/** The M0 gate as a test: the reference workload records a full trace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { stateHash } from '@krishnadobhal/rewind-core/hash';
import { Recorder } from '@krishnadobhal/rewind-sdk-js/recorder';
import { fileStore, readCassette, readTrace, type Trace } from '@krishnadobhal/rewind-sdk-js/store';
import { buildGraph, routerScript, script, webSearch } from '../src/graph.ts';
import { ScriptedChatModel } from '../src/model.ts';

/** Runs the reference graph once against a throwaway store. */
async function run(options: { routed?: boolean; decision?: 'research' | 'direct'; question?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-agent-'));
  // The recorder is injected, so buildGraph instruments without touching env or disk.
  const recorder = new Recorder({ store: fileStore(dir), log: () => {} });
  const { graph } = await buildGraph({
    model: new ScriptedChatModel({ responses: script(), model: 'scripted-planner-1' }),
    tools: [webSearch],
    router: options.routed
      ? new ScriptedChatModel({ responses: routerScript(options.decision ?? 'research'), model: 'scripted-router-1' })
      : undefined,
    recorder,
  });
  const state = await graph.invoke({ messages: [new HumanMessage(options.question ?? 'how do I replay an agent?')] });
  const hash = stateHash(state); // canonical, so message UUIDs do not leak into it
  recorder.finish({ final_state_hash: hash });
  return { dir, state, stateHash: hash, trace: readTrace(dir, recorder.run.run_id)! };
}

/** The model_id behind each model step, in order. */
const modelIds = (dir: string, trace: Trace) =>
  trace.steps.filter((s) => s.kind === 'model').map((s) => JSON.parse(readCassette(dir, s.req_hash)!.request).model_id);

test('the reference agent records every boundary it crosses', async () => {
  const { state, trace } = await run();

  assert.deepEqual(
    trace.steps.map((s) => [s.seq, s.node, s.kind]),
    [[0, 'plan', 'model'], [1, 'tools', 'tool'], [2, 'summarize', 'model']],
    'plan calls the model, the tool node runs, then the model answers',
  );
  for (const step of trace.steps) assert.match(step.req_hash, /^[0-9a-f]{64}$/);
  assert.equal(trace.run.status, 'complete');
  assert.equal(state.messages.length, 4, 'human, tool call, tool result, answer');
});

test('the two model calls differ only by their message history', async () => {
  const { trace } = await run();
  const [plan, , summarize] = trace.steps;
  assert.notEqual(plan!.req_hash, summarize!.req_hash, 'more messages is a different call');
});

test('recording twice yields identical hashes', async () => {
  // The precondition for replay: the same run must fingerprint the same way twice.
  const first = await run();
  const second = await run();
  assert.deepEqual(
    first.trace.steps.map((s) => s.req_hash),
    second.trace.steps.map((s) => s.req_hash),
    'volatile ids and timestamps are excluded, so two runs agree',
  );
});

test('a second model adds a step and keeps its own identity', async () => {
  const { dir, trace } = await run({ routed: true });

  assert.deepEqual(
    trace.steps.map((s) => [s.node, s.kind]),
    [['route', 'model'], ['plan', 'model'], ['tools', 'tool'], ['summarize', 'model']],
    'the router runs first, then the planner',
  );
  assert.deepEqual(modelIds(dir, trace), ['scripted-router-1', 'scripted-planner-1', 'scripted-planner-1']);
});

test('the router takes a direct answer straight to the end', async () => {
  const { trace } = await run({ routed: true, decision: 'direct' });
  assert.deepEqual(trace.steps.map((s) => s.node), ['route'], 'the expensive model never ran');
});

test('building the graph is what instruments it — the caller cannot forget', async () => {
  // buildGraph takes raw models and tools, so there is no unwrapped pair to pass and
  // no way to end up with a trace that is missing its tool steps.
  const { trace } = await run();
  assert.ok(trace.steps.some((s) => s.kind === 'tool'), 'the tool boundary is recorded');
  assert.ok(trace.steps.every((s) => s.match_tier === 'recorded'), 'every step reports its tier (I3)');
});
