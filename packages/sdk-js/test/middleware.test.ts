import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cassette, Step } from '@rewind/core/schema';
import { Recorder } from '../src/recorder.ts';
import { withRewind } from '../src/middleware.ts';
import type { Store } from '../src/store.ts';

/** Collects what the recorder writes, so a test can read it back. */
function memory() {
  const steps: Step[] = [];
  const cassettes: Cassette[] = [];
  const store: Store = { putRun() {}, appendStep: (s) => void steps.push(s), putCassette: (c) => void cassettes.push(c) };
  return { steps, cassettes, recorder: new Recorder({ store, log: () => {} }) };
}

/** Minimal duck-typed chat model — no LangChain in sdk-js tests. */
function fakeModel(onInvoke?: () => never) {
  return {
    model: 'fake-1',
    temperature: 0,
    _llmType: () => 'fake',
    async invoke(_input: unknown, _config?: unknown) {
      if (onInvoke) onInvoke();
      return { content: 'answer', usage_metadata: { total_tokens: 5 } };
    },
    bindTools(tools: unknown[]) {
      // Real models convert to JSON Schema and stash it on the binding.
      return { ...this, config: { tools: tools.map((t) => ({ type: 'function', function: t })) } };
    },
  };
}

const searchTool = {
  name: 'web_search',
  description: 'Search the web.',
  async invoke(input: { args?: unknown }) {
    return { hits: 1, echo: input };
  },
};

test('un-wrapped runs get the originals back, untouched', async () => {
  const model = fakeModel();
  const wrapped = await withRewind({ model, tools: [searchTool], recorder: null });
  assert.equal(wrapped.model, model, 'same object, not a proxy');
  assert.equal(wrapped.tools[0], searchTool);
  assert.equal(wrapped.recorder, null);
});

test('a model call becomes a step with its node name', async () => {
  const { steps, cassettes, recorder } = memory();
  const { model } = await withRewind({ model: fakeModel(), tools: [], recorder });

  const result = await model.invoke([{ role: 'user', content: 'hello' }], { metadata: { langgraph_node: 'plan' } });
  assert.deepEqual(result, { content: 'answer', usage_metadata: { total_tokens: 5 } }, 'the caller sees the real result');

  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.node, 'plan');
  assert.equal(steps[0]!.kind, 'model');
  assert.equal(steps[0]!.tokens, 5, 'usage_metadata is picked up');
  const request = JSON.parse(cassettes[0]!.request);
  assert.equal(request.provider, 'fake');
  assert.equal(request.model_id, 'fake-1');
  assert.equal(request.temperature, 0);
});

test('bindTools stays wrapped and carries JSON Schema', async () => {
  const { steps, cassettes, recorder } = memory();
  const { model } = await withRewind({ model: fakeModel(), tools: [], recorder });

  const schema = { name: 'web_search', parameters: { type: 'object', properties: { q: { type: 'string' } } } };
  const bound = model.bindTools([schema]);
  await bound.invoke([{ role: 'user', content: 'search' }], { metadata: { langgraph_node: 'plan' } });

  assert.equal(steps.length, 1, 'the bound runnable still records');
  const request = JSON.parse(cassettes[0]!.request);
  assert.deepEqual(request.tool_schemas, [{ name: 'web_search', description: null, schema: schema.parameters }]);
});

test('a tool call records its name and args', async () => {
  const { steps, cassettes, recorder } = memory();
  const { tools } = await withRewind({ model: fakeModel(), tools: [searchTool], recorder });

  // LangGraph hands a tool the whole ToolCall, not bare args.
  await tools[0]!.invoke({ id: 'call_1', name: 'web_search', args: { q: 'rewind' } }, { metadata: { langgraph_node: 'tools' } });

  assert.equal(steps[0]!.kind, 'tool');
  assert.equal(steps[0]!.node, 'tools');
  assert.deepEqual(JSON.parse(cassettes[0]!.request), { kind: 'tool', tool_name: 'web_search', args: { q: 'rewind' } });
});

test('a thrown provider error is recorded and rethrown', async () => {
  const { steps, recorder } = memory();
  const boom = () => { throw new Error('429 rate limited'); };
  const { model } = await withRewind({ model: fakeModel(boom as () => never), tools: [], recorder });

  await assert.rejects(() => model.invoke([{ role: 'user', content: 'hi' }], {}), /429/);
  assert.equal(steps.length, 1, 'the failure is a step, not a gap (B9)');
  assert.deepEqual(steps[0]!.error, { message: 'Error: 429 rate limited' });
});

test('memoized schema fields never reach the hash', async () => {
  const { cassettes, recorder } = memory();
  const { model } = await withRewind({ model: fakeModel(), tools: [], recorder });

  // Zod populates `_cached` on first use; identity must not depend on that.
  const cold = { name: 't', parameters: { type: 'object', _cached: null } };
  const warm = { name: 't', parameters: { type: 'object', _cached: { keys: ['q'] } } };
  await model.bindTools([cold]).invoke([{ role: 'user', content: 'x' }], {});
  await model.bindTools([warm]).invoke([{ role: 'user', content: 'x' }], {});

  assert.equal(cassettes[0]!.hash, cassettes[1]!.hash, 'same schema, same hash, used or not');
});

test('a step with no node name is still a step', async () => {
  const { steps, recorder } = memory();
  const { model } = await withRewind({ model: fakeModel(), tools: [], recorder });
  await model.invoke([{ role: 'user', content: 'hi' }]);
  assert.equal(steps[0]!.node, 'unknown');
});

test('several models record side by side, each keeping its identity', async () => {
  const { steps, cassettes, recorder } = memory();
  // A cheap router and an expensive planner is the ordinary shape, not an edge case.
  const planner = { ...fakeModel(), model: 'opus-5' };
  const router = { ...fakeModel(), model: 'haiku-4-5' };

  const rw = await withRewind({ model: planner, tools: [searchTool], recorder });
  const wrappedRouter = rw.wrap(router);

  await rw.model.invoke([{ role: 'user', content: 'plan this' }], { metadata: { langgraph_node: 'plan' } });
  await wrappedRouter.invoke([{ role: 'user', content: 'route this' }], { metadata: { langgraph_node: 'route' } });

  assert.deepEqual(steps.map((s) => s.node), ['plan', 'route']);
  assert.deepEqual(cassettes.map((c) => JSON.parse(c.request).model_id), ['opus-5', 'haiku-4-5']);
  // model_id is part of the identity, so the same prompt to two models is two cassettes.
  assert.notEqual(steps[0]!.req_hash, steps[1]!.req_hash);
});

test('wrap dispatches on shape, and is a no-op when not recording', async () => {
  const { steps, recorder } = memory();
  const rw = await withRewind({ recorder });
  await rw.wrap(fakeModel()).invoke([{ role: 'user', content: 'hi' }], {});
  await rw.wrap(searchTool).invoke({ args: { q: 'x' } }, {});
  assert.deepEqual(steps.map((s) => s.kind), ['model', 'tool'], 'a model is not mistaken for a tool');

  const off = await withRewind({ recorder: null });
  assert.equal(off.wrap(searchTool), searchTool, 'un-wrapped runs pay nothing');
});

test('identity survives bindTools, which returns a binding not a model', async () => {
  const { cassettes, recorder } = memory();
  const { model } = await withRewind({ model: fakeModel(), tools: [], recorder });

  // withConfig/bindTools wrap the model in a RunnableBinding. Reading identity off
  // the binding gives model_id "unknown" and makes every model look alike.
  const binding = { bound: fakeModel(), kwargs: {}, config: {}, invoke: async () => ({ content: 'x' }) };
  const wrapped = model.bindTools([{ name: 't' }]);
  assert.ok(wrapped, 'bindTools returns something wrapped');

  await wrapped.invoke([{ role: 'user', content: 'hi' }], {});
  const viaBinding = JSON.parse(cassettes[0]!.request);
  assert.equal(viaBinding.model_id, 'fake-1', 'not "unknown"');
  assert.equal(viaBinding.provider, 'fake');

  const direct = await withRewind({ model: binding, tools: [], recorder });
  await direct.model.invoke([{ role: 'user', content: 'hi' }], {});
  const viaBound = JSON.parse(cassettes[1]!.request);
  assert.equal(viaBound.model_id, 'fake-1', 'a nested .bound is followed too');
});
