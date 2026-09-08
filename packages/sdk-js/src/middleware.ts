/**
 * `withRewind` — the interception point (ARCHITECTURE §2).
 *
 * Wraps the model (B1) and tools (B2), not the graph: a graph wrapper sees a run start
 * and a run end and nothing between. No `@langchain/*` dependency — this ships into
 * user processes under a 60 kB budget, and duck-typing `.invoke()` pins no version.
 */
import type { RewindRequest } from '@rewind/core/request';
import type { StepKind } from '@rewind/core/schema';
import { recorderFromEnv, replayerFromEnv } from './env.ts';
import { MissError, type Replayer } from './replay.ts';
import type { Recorder } from './recorder.ts';

/** Anything with an invoke method — a model, a tool, a runnable. */
type Invokable = { invoke: (input: never, config?: never) => unknown };

/** Any callable, for reflective dispatch through the proxies. */
type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

/** Methods returning a new runnable that must stay wrapped. */
const REWRAPPING = new Set(['bindTools', 'bind', 'withConfig', 'withRetry']);

/** What this process does to each boundary. At most one of the two is set. */
type Session = { recorder: Recorder | null; replayer: Replayer | null; revive: (response: unknown) => unknown };

export type WithRewindOptions<M, T> = {
  model?: M;
  tools?: T[];
  /** Supplied by tests; otherwise from the `rewind record` env handshake. */
  recorder?: Recorder | null;
  /** Supplied by tests; otherwise from the `rewind replay` env handshake. */
  replayer?: Replayer | null;
  /**
   * Turns a recorded response back into the object the graph expects.
   * A cassette holds JSON; LangChain wants an `AIMessage` back, and raw JSON would
   * change the next request so every later step misses. Recording ignores this.
   */
  revive?: (response: unknown) => unknown;
};

export type Rewind<M, T> = {
  model: M;
  tools: T[];
  recorder: Recorder | null;
  /** Non-null when this process is replaying a recorded run. */
  replayer: Replayer | null;
  /** Wraps one more model or tool — `model`/`tools` are sugar over this. */
  wrap: <X extends Invokable>(target: X) => X;
};

/** Wraps a model and tools so every call is recorded, or replayed. */
export async function withRewind<M extends Invokable, T extends Invokable>(
  options: WithRewindOptions<M, T> = {},
): Promise<Rewind<M, T>> {
  // Replay first: a process replaying a run is not also recording one.
  const replayer = options.replayer ?? (await replayerFromEnv());
  const recorder = replayer ? null : options.recorder ?? (await recorderFromEnv());
  const tools = options.tools ?? [];
  const model = options.model as M;
  const session: Session = { recorder, replayer, revive: options.revive ?? ((r) => r) };
  // Neither: hand back the originals, so an un-instrumented run costs nothing.
  if (recorder === null && replayer === null) {
    return { model, tools, recorder: null, replayer: null, wrap: (target) => target };
  }
  const wrap = <X extends Invokable>(target: X): X => wrapAny(target, session);
  return { model: model && wrap(model), tools: tools.map(wrap), recorder, replayer, wrap };
}

/** Dispatches to the model or tool wrapper by shape. */
function wrapAny<X extends Invokable>(target: X, session: Session): X {
  const t = unwrapModel(target); // a binding carries neither marker itself
  // Models have _llmType/bindTools, tools have neither. Guessing wrong shows up as a
  // `tool` step where a `model` step belongs.
  const isModel = typeof t['_llmType'] === 'function' || typeof t['bindTools'] === 'function';
  return isModel ? wrapModel(target, session) : wrapTool(target, session);
}

/** Proxies a chat model, turning each invoke into a step. */
function wrapModel<M extends Invokable>(model: M, session: Session, bound: unknown[] = []): M {
  return new Proxy(model, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target); // target, not the proxy — getters recurse
      if (prop === 'invoke') {
        return (input: unknown, config?: unknown) =>
          observe(session, 'model', config, () => modelRequest(target, input, bound), () =>
            (value as AnyFn).call(target, input, config),
          );
      }
      // bindTools returns a *new* runnable; unwrapped, the graph calls it directly.
      if (REWRAPPING.has(prop as string) && typeof value === 'function') {
        return (...args: unknown[]) => {
          const next = (value as AnyFn).apply(target, args) as Invokable;
          const schemas = prop === 'bindTools' ? (providerTools(next) ?? (args[0] as unknown[]) ?? []) : bound;
          return wrapModel(next, session, schemas); // schemas are part of the identity
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as M;
}

/** Proxies a tool, turning each invoke into a step. */
function wrapTool<T extends Invokable>(tool: T, session: Session): T {
  return new Proxy(tool, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'invoke') return typeof value === 'function' ? value.bind(target) : value;
      const name = String(Reflect.get(target, 'name', target) ?? 'tool');
      return (input: unknown, config?: unknown) =>
        observe(
          session,
          'tool',
          config,
          () => ({ kind: 'tool', tool_name: name, args: toolArgs(input) }), // name + args, nothing else
          () => (value as AnyFn).call(target, input, config),
        );
    },
  }) as T;
}

/** Answers a boundary crossing: from a cassette, or from the world. */
async function observe(
  session: Session,
  kind: StepKind,
  config: unknown,
  request: () => RewindRequest,
  call: () => unknown,
): Promise<unknown> {
  const node = nodeName(config);
  const { recorder, replayer } = session;

  if (replayer !== null) {
    const hit = replayer.resolve(node, kind, request());
    if (hit.hit) return session.revive(hit.response); // never touches the network (I6)
    // A miss is a branch, not a replay (I5): strict fails by name, live falls through.
    if (replayer.onMiss === 'strict') {
      const step = replayer.steps[replayer.steps.length - 1]!;
      throw new MissError(node, step.seq, step.req_hash);
    }
    return call();
  }

  const started = Date.now(); // real clock; the virtual one arrives with B3
  try {
    const response = await call();
    recorder?.record({
      node,
      kind,
      request: request(),
      response: plain(response),
      latency_ms: Date.now() - started,
      ...usage(response),
    });
    return response;
  } catch (error) {
    // A provider error is a recorded outcome, not a gap (B9).
    recorder?.record({
      node,
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
  // Identity read off a binding gives model_id "unknown" — every model looks alike.
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
    tool_schemas: boundTools.map((tool, i) => toolSchema(tool, i)), // canonical() sorts these
    ...pick(m, ['temperature', 'topP', 'topK', 'maxTokens']),
  };
}

/** Flattens LangChain messages to plain role/content records. */
function messages(input: unknown): { role: string; content: unknown; [k: string]: unknown }[] {
  const list = Array.isArray(input) ? input : [input]; // a bare message is a list of one
  return list.map((message) => {
    const m = message as Record<string, unknown>;
    const getType = m['_getType']; // BaseMessage hides its role behind this
    return {
      role: typeof getType === 'function' ? String((getType as AnyFn).call(message)) : String(m['role'] ?? 'user'),
      content: m['content'] ?? null,
      ...pick(m, ['tool_calls', 'tool_call_id', 'name', 'id']), // ids become ordinals later
    };
  });
}

/** Unwraps a tool call's args from its envelope. */
function toolArgs(input: unknown): unknown {
  const i = input as Record<string, unknown> | null;
  // LangGraph passes the whole ToolCall; a direct caller passes bare args.
  return i !== null && typeof i === 'object' && 'args' in i ? i['args'] : input;
}

/** Prefers the JSON-Schema tool dicts a binding carries. */
function providerTools(bound: unknown): unknown[] | null {
  // What the model actually sees, and plain JSON unlike a raw Zod object.
  const b = bound as { kwargs?: { tools?: unknown }; config?: { tools?: unknown } } | null;
  for (const tools of [b?.kwargs?.tools, b?.config?.tools]) {
    if (Array.isArray(tools)) return tools;
  }
  return null;
}

/** Reduces a tool object to its identity fields. */
function toolSchema(tool: unknown, index: number): { name: string; [k: string]: unknown } {
  const t = tool as Record<string, unknown>;
  const fn = (t['function'] ?? t) as Record<string, unknown>; // OpenAI nests, others are flat
  return {
    name: String(fn['name'] ?? `tool_${index}`),
    description: fn['description'] ?? null,
    // ponytail: a raw Zod object hashes as its internal _def, which a Zod upgrade
    // invalidates. Models that convert on bindTools hit providerTools() instead.
    schema: stable(fn['parameters'] ?? fn['input_schema'] ?? fn['schema'] ?? null),
  };
}

/** Drops memoized fields that appear only after first use. */
function stable(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return schema;
  // Zod fills `_cached` lazily: identity must not depend on how often it was used.
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
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
}
