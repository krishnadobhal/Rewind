/**
 * `withRewind` — the interception point (ARCHITECTURE §2).
 *
 * It wraps the chat model (B1) and the tools (B2) rather than the graph, because a
 * wrapper around the graph sees a run start and a run end and nothing in between. The
 * same wrappers resolve from cassettes on replay; only what sits underneath changes.
 *
 * Deliberately no `@langchain/*` dependency — this ships into user processes under a
 * 60 kB budget, and duck-typing `.invoke()` costs nothing and pins no version.
 */
import type { RewindRequest } from '@rewind/core/request';
import type { StepKind } from '@rewind/core/schema';
import { recorderFromEnv } from './env.ts';
import type { Recorder } from './recorder.ts';

/** Anything with an invoke method — a model, a tool, a runnable. */
type Invokable = { invoke: (input: never, config?: never) => unknown };

/** Any callable, for reflective dispatch through the proxies. */
type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

/** Methods returning a new runnable that must stay wrapped. */
const REWRAPPING = new Set(['bindTools', 'bind', 'withConfig', 'withRetry']);

export type WithRewindOptions<M, T> = {
  model?: M;
  tools?: T[];
  /** Supplied by tests; otherwise built from the `rewind record` env handshake. */
  recorder?: Recorder | null;
};

export type Rewind<M, T> = {
  model: M;
  tools: T[];
  recorder: Recorder | null;
  /**
   * Wraps one more model or tool. An agent with a cheap router and an expensive
   * planner has two models; `model` and `tools` are sugar over this for the common
   * one-model shape, not a limit on how many you can record.
   */
  wrap: <X extends Invokable>(target: X) => X;
};

/** Wraps a model and tools so every call is recorded. */
export async function withRewind<M extends Invokable, T extends Invokable>(
  options: WithRewindOptions<M, T> = {},
): Promise<Rewind<M, T>> {
  const recorder = options.recorder ?? (await recorderFromEnv());
  const tools = options.tools ?? [];
  const model = options.model as M;
  // Not recording: hand back the originals, so an un-wrapped run costs nothing.
  if (recorder === null) return { model, tools, recorder: null, wrap: (target) => target };
  const wrap = <X extends Invokable>(target: X): X => wrapAny(target, recorder);
  return { model: model && wrap(model), tools: tools.map(wrap), recorder, wrap };
}

/** Dispatches to the model or tool wrapper by shape. */
function wrapAny<X extends Invokable>(target: X, recorder: Recorder): X {
  // Look through bindings first: `wrap(model.bindTools(…))` hands us a RunnableBinding,
  // which carries neither marker itself and would be recorded as a tool.
  const t = unwrapModel(target);
  // Chat models carry _llmType/bindTools; tools carry neither. Guessing wrong would
  // show up immediately as a `tool` step where a `model` step belongs.
  const isModel = typeof t['_llmType'] === 'function' || typeof t['bindTools'] === 'function';
  return isModel ? wrapModel(target, recorder) : wrapTool(target, recorder);
}

/** Proxies a chat model, recording each invoke as a step. */
function wrapModel<M extends Invokable>(model: M, recorder: Recorder, bound: unknown[] = []): M {
  return new Proxy(model, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target); // target, not the proxy — getters recurse
      if (prop === 'invoke') {
        return (input: unknown, config?: unknown) =>
          observe(recorder, 'model', config, () => modelRequest(target, input, bound), () =>
            (value as AnyFn).call(target, input, config),
          );
      }
      // bindTools returns a *new* runnable; unwrapped, the graph would call it directly.
      if (REWRAPPING.has(prop as string) && typeof value === 'function') {
        return (...args: unknown[]) => {
          const next = (value as AnyFn).apply(target, args) as Invokable;
          // Remember the tool schemas — they are part of the call's identity.
          const schemas = prop === 'bindTools' ? (providerTools(next) ?? (args[0] as unknown[]) ?? []) : bound;
          return wrapModel(next, recorder, schemas);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as M;
}

/** Proxies a tool, recording each invoke as a step. */
function wrapTool<T extends Invokable>(tool: T, recorder: Recorder): T {
  return new Proxy(tool, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'invoke') return typeof value === 'function' ? value.bind(target) : value;
      const name = String(Reflect.get(target, 'name', target) ?? 'tool');
      return (input: unknown, config?: unknown) =>
        observe(
          recorder,
          'tool',
          config,
          // A tool call's identity is its name plus its arguments, nothing else.
          () => ({ kind: 'tool', tool_name: name, args: toolArgs(input) }),
          () => (value as AnyFn).call(target, input, config),
        );
    },
  }) as T;
}

/** Times a call, records it, returns its result. */
async function observe(
  recorder: Recorder,
  kind: StepKind,
  config: unknown,
  request: () => RewindRequest,
  call: () => unknown,
): Promise<unknown> {
  const started = Date.now(); // real clock; the virtual one arrives with B3
  try {
    const response = await call();
    // Recorder.record never throws (I1), so this cannot break the graph.
    recorder.record({
      node: nodeName(config),
      kind,
      request: request(),
      response: plain(response),
      latency_ms: Date.now() - started,
      ...usage(response),
    });
    return response;
  } catch (error) {
    // A provider error is a recorded outcome, not a gap — replay reproduces it (B9).
    recorder.record({
      node: nodeName(config),
      kind,
      request: request(),
      response: null,
      latency_ms: Date.now() - started,
      error: { message: String(error) },
    });
    throw error; // the graph's error handling is the graph's business
  }
}

/** Reads the LangGraph node name out of the config. */
function nodeName(config: unknown): string {
  const metadata = (config as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  const fromGraph = metadata?.['langgraph_node']; // LangGraph sets this per node
  if (typeof fromGraph === 'string') return fromGraph;
  const runName = (config as { runName?: string } | undefined)?.runName;
  return runName ?? 'unknown'; // ponytail: a step with no node is still a step
}

/** Digs past Runnable bindings to the model underneath. */
function unwrapModel(model: unknown): Record<string, unknown> {
  let m = model as Record<string, unknown>;
  // bindTools and withConfig return a RunnableBinding holding the real model in
  // `bound`. Reading identity off the binding yields model_id "unknown", which
  // would make every model look alike to `fork --set model=`.
  for (let depth = 0; depth < 8 && m && typeof m['_llmType'] !== 'function'; depth++) {
    const inner = m['bound'];
    if (inner === undefined || inner === null) break;
    m = inner as Record<string, unknown>;
  }
  return m;
}

/** Builds the canonical model request from an invoke. */
function modelRequest(model: unknown, input: unknown, boundTools: unknown[]): RewindRequest {
  const m = unwrapModel(model);
  const llmType = m['_llmType']; // LangChain's provider discriminator
  return {
    kind: 'model',
    provider: typeof llmType === 'function' ? String((llmType as AnyFn).call(m)) : 'unknown',
    model_id: String(m['model'] ?? m['modelName'] ?? 'unknown'),
    messages: messages(input),
    // canonical() sorts these by name; a changed schema is a changed call.
    tool_schemas: boundTools.map((tool, i) => toolSchema(tool, i)),
    ...pick(m, ['temperature', 'topP', 'topK', 'maxTokens']),
  };
}

/** Flattens LangChain messages to plain role/content records. */
function messages(input: unknown): { role: string; content: unknown; [k: string]: unknown }[] {
  const list = Array.isArray(input) ? input : [input]; // a bare message is a one-message list
  return list.map((message) => {
    const m = message as Record<string, unknown>;
    const getType = m['_getType']; // BaseMessage hides its role behind this
    return {
      role: typeof getType === 'function' ? String((getType as AnyFn).call(message)) : String(m['role'] ?? 'user'),
      content: m['content'] ?? null,
      // Ids are scrubbed to ordinals during canonicalization, so passing them is safe.
      ...pick(m, ['tool_calls', 'tool_call_id', 'name', 'id']),
    };
  });
}

/** Unwraps a tool call's args from its envelope. */
function toolArgs(input: unknown): unknown {
  const i = input as Record<string, unknown> | null;
  // LangGraph hands tools the whole ToolCall; a direct caller hands bare args.
  return i !== null && typeof i === 'object' && 'args' in i ? i['args'] : input;
}

/** Prefers the JSON-Schema tool dicts a binding carries. */
function providerTools(bound: unknown): unknown[] | null {
  // bindTools converts tools to provider format and stashes them on the binding —
  // under kwargs for .bind(), under config for .withConfig(). That form is what the
  // model actually sees, and unlike a raw Zod object it is plain JSON.
  const b = bound as { kwargs?: { tools?: unknown }; config?: { tools?: unknown } } | null;
  for (const tools of [b?.kwargs?.tools, b?.config?.tools]) {
    if (Array.isArray(tools)) return tools;
  }
  return null;
}

/** Reduces a tool object to its identity fields. */
function toolSchema(tool: unknown, index: number): { name: string; [k: string]: unknown } {
  const t = tool as Record<string, unknown>;
  // OpenAI style nests under .function; anthropic and raw tools are flat.
  const fn = (t['function'] ?? t) as Record<string, unknown>;
  return {
    name: String(fn['name'] ?? `tool_${index}`),
    description: fn['description'] ?? null,
    // ponytail: a raw Zod object serializes as its internal _def — stable within a
    // Zod version, invalidated by an upgrade. Models that convert on bindTools (all
    // real ones) hit providerTools() above and never reach this.
    schema: stable(fn['parameters'] ?? fn['input_schema'] ?? fn['schema'] ?? null),
  };
}

/** Drops memoized fields that appear only after first use. */
function stable(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return schema;
  // Zod fills `_cached` lazily, so the same schema hashed before and after a
  // validation would produce two different req_hashes. Identity must not depend
  // on how many times the object has been used.
  return JSON.parse(JSON.stringify(schema, (key, value) => (key === '_cached' ? undefined : value))) as unknown;
}

/** Copies the keys that exist and are not null. */
function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  return out;
}

/** Pulls token counts off a model response, if present. */
function usage(response: unknown): { tokens?: number } {
  const meta = (response as { usage_metadata?: { total_tokens?: number } } | null)?.usage_metadata;
  return typeof meta?.total_tokens === 'number' ? { tokens: meta.total_tokens } : {};
}

/** Strips class identity so the response serializes as data. */
function plain(value: unknown): unknown {
  // ponytail: JSON round-trip. Throws on a cycle, which #guard catches as a drop.
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
}
