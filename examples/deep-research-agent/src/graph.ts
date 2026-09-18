/**
 * The reference workload: a small deep-research agent.
 *
 *   plan ──► tools ──► summarize
 *
 * Small on purpose. Its job is to exercise every boundary Rewind has to record — a
 * model call that emits tool calls, a tool that returns data, and a second model call
 * that reads the tool output — not to be a good research agent.
 */
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { load } from '@langchain/core/load';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { withRewind } from '@rewind/sdk-js/middleware';
import type { Recorder } from '@rewind/sdk-js/recorder';
import { ScriptedChatModel } from './model.ts';

/** A canned search tool; a real one would reach the network. */
export const webSearch = tool(
  // Deterministic on its own, but recorded anyway — the real one would not be.
  async ({ query }: { query: string }) => JSON.stringify({ query, hits: [{ title: 'Deterministic replay for agents', url: 'https://example.com/replay' }] }),
  {
    name: 'web_search',
    description: 'Search the web for a query.',
    schema: z.object({ query: z.string().describe('the search query') }),
  },
);

/** The two turns the scripted model plays, in order. */
export function script(): AIMessage[] {
  return [
    // Turn 1: ask for a search. tool_calls is what routes us to the tool node.
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_plan_1', name: 'web_search', args: { query: 'deterministic replay for langgraph agents' } }],
    }),
    // Turn 2: read the tool result and answer. No tool_calls ends the loop.
    new AIMessage({ content: 'Rewind records every boundary crossing, then replays it. Source: example.com/replay' }),
  ];
}

/** The router's two turns: research this, or answer it directly. */
export function routerScript(decision: 'research' | 'direct' = 'research'): AIMessage[] {
  return [new AIMessage(decision)];
}

export type BuiltGraph = Awaited<ReturnType<typeof buildGraph>>;

type Model = ScriptedChatModel | { invoke: never };

/**
 * Raw models and tools. They are instrumented here rather than by the caller, so
 * there is no way to hand the graph an unwrapped tool and silently lose its steps.
 * `router` is optional — with it the graph runs two models, without it, one.
 */
export type Binding = {
  model: Model;
  tools: StructuredToolInterface[];
  router?: Model;
  recorder?: Recorder | null;
};

/**
 * Instruments the models and tools, then wires them into a compiled graph.
 *
 * `withRewind` lives here, at the build step, because this is the one place that
 * holds every boundary object at once. Unrecorded it hands them all
 * back untouched, so this costs nothing in production.
 */
export async function buildGraph(binding: Binding) {
  const rw = await withRewind({
    model: binding.model as { invoke: never },
    tools: binding.tools,
    recorder: binding.recorder,
    revive: reviveLangChain,
  });
  const tools = rw.tools;
  // A second model goes through `wrap`, the primitive model/tools are sugar over.
  const router = binding.router ? rw.wrap(binding.router as { invoke: never }) : undefined;

  // bindTools puts the schemas into the request identity; withRewind keeps the wrapper.
  const planner = (rw.model as unknown as ScriptedChatModel).bindTools(tools);
  /** Turns a model into a node that appends its reply. */
  const speak = (m: { invoke: (input: never, config?: never) => unknown }) => async (state: { messages: BaseMessage[] }, config: unknown) =>
    ({ messages: [(await (m.invoke as (i: unknown, c: unknown) => Promise<BaseMessage>)(state.messages, config))] });

  const research = new StateGraph(MessagesAnnotation)
    .addNode('plan', speak(planner))
    .addNode('tools', new ToolNode(tools))
    .addNode('summarize', speak(planner))
    // No tool calls means the model answered directly; skip straight to the end.
    .addConditionalEdges('plan', (state) => (hasToolCalls(state.messages) ? 'tools' : END), ['tools', END])
    .addEdge('tools', 'summarize')
    .addEdge('summarize', END);

  // The recorder comes back with the graph — the caller needs it to close the run.
  // One model: straight into planning.
  if (router === undefined) return { graph: research.addEdge(START, 'plan').compile(), recorder: rw.recorder };

  // Two models: a cheap router decides whether the expensive one runs at all.
  const graph = research
    .addNode('route', speak(router))
    .addEdge(START, 'route')
    .addConditionalEdges('route', (state) => (wantsResearch(state.messages) ? 'plan' : END), ['plan', END])
    .compile();
  return { graph, recorder: rw.recorder };
}

/**
 * Rebuilds a LangChain object from its recorded JSON.
 *
 * Cassettes hold `{lc:1,type:"constructor",…}`; the graph needs the class back, or the
 * next request it builds differs from the recording and every later step misses.
 * `sdk-js` stays framework-free, so the reviver lives here, next to the framework.
 */
function reviveLangChain(response: unknown): unknown {
  const r = response as { lc?: number; type?: string } | null;
  if (r === null || typeof r !== 'object' || r.lc !== 1) return response; // plain data
  // load() is async; the middleware awaits whatever it gets back.
  return load(JSON.stringify(response));
}

/** True when the router asked for research rather than a direct answer. */
function wantsResearch(messages: BaseMessage[]): boolean {
  const last = messages[messages.length - 1];
  return String(last?.content ?? '').trim() === 'research';
}

/** True when the last message asked for a tool. */
function hasToolCalls(messages: BaseMessage[]): boolean {
  const last = messages[messages.length - 1] as AIMessage | undefined;
  return (last?.tool_calls?.length ?? 0) > 0;
}
