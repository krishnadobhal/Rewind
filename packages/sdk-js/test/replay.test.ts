import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '../src/recorder.ts';
import { MissError, Replayer } from '../src/replay.ts';
import { withRewind } from '../src/middleware.ts';
import { fileStore } from '../src/store.ts';

/** A model whose answer depends on the prompt, so a changed prompt changes the hash. */
function model(answer = 'recorded answer') {
  return {
    model: 'fake-1',
    _llmType: () => 'fake',
    async invoke(_input: unknown, _config?: unknown) {
      return { content: answer };
    },
  };
}

/** Records one model call and returns the store plus the run id. */
async function recorded(prompt = 'hello') {
  const root = mkdtempSync(join(tmpdir(), 'rewind-replay-'));
  const recorder = new Recorder({ store: fileStore(root), log: () => {} });
  const rw = await withRewind({ model: model(), recorder });
  await rw.model.invoke([{ role: 'user', content: prompt }], { metadata: { langgraph_node: 'plan' } });
  recorder.finish({ final_state_hash: 'sha256:final' });
  return { root, runId: recorder.run.run_id };
}

test('a replayed step resolves from its cassette and reports the tier', async () => {
  const { root, runId } = await recorded();
  const replayer = new Replayer({ root, runId });
  const rw = await withRewind({ model: model(), replayer });

  const response = await rw.model.invoke([{ role: 'user', content: 'hello' }], { metadata: { langgraph_node: 'plan' } });
  assert.deepEqual(response, { content: 'recorded answer' });
  assert.equal(replayer.tiers.exact, 1);
  assert.equal(replayer.tiers.miss, 0);
  assert.equal(replayer.steps[0]!.match_tier, 'exact', 'never inferred, never omitted (I3)');
  assert.equal(replayer.faithful, true);
  assert.equal(replayer.divergenceSeq, null);
});

test('I6: a replayed call never reaches the model', async () => {
  const { root, runId } = await recorded();
  // The only honest proof: a model that throws if anything invokes it.
  const tripwire = {
    model: 'fake-1',
    _llmType: () => 'fake',
    async invoke(_input: unknown, _config?: unknown): Promise<never> {
      throw new Error('the network was touched during replay');
    },
  };
  const rw = await withRewind({ model: tripwire, replayer: new Replayer({ root, runId }) });
  const response = await rw.model.invoke([{ role: 'user', content: 'hello' }], { metadata: { langgraph_node: 'plan' } });
  assert.deepEqual(response, { content: 'recorded answer' }, 'answered from the cassette, not the model');
});

test('a changed request is a miss, and strict names the hash', async () => {
  const { root, runId } = await recorded('hello');
  const replayer = new Replayer({ root, runId, onMiss: 'strict' });
  const rw = await withRewind({ model: model(), replayer });

  // A different prompt is a different call — replay must not answer it from the old one.
  await assert.rejects(
    () => rw.model.invoke([{ role: 'user', content: 'something else' }], { metadata: { langgraph_node: 'plan' } }),
    (error: unknown) => {
      assert.ok(error instanceof MissError);
      assert.equal(error.node, 'plan');
      assert.equal(error.seq, 0);
      assert.match(error.message, /no cassette for plan at seq 0/);
      return true;
    },
  );
  assert.equal(replayer.tiers.miss, 1);
  assert.equal(replayer.divergenceSeq, 0, 'where the recording stopped being authoritative');
  assert.equal(replayer.faithful, false);
});

test('on-miss=live falls through to a real call', async () => {
  const { root, runId } = await recorded('hello');
  const replayer = new Replayer({ root, runId, onMiss: 'live' });
  const rw = await withRewind({ model: model('live answer'), replayer });

  const response = await rw.model.invoke([{ role: 'user', content: 'something else' }], {});
  assert.deepEqual(response, { content: 'live answer' }, 'the miss became a branch, not a failure');
  assert.equal(replayer.tiers.miss, 1, 'still counted as a miss, never dressed up as a hit');
});

test('a partial run is refused as a replay source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewind-replay-'));
  const recorder = new Recorder({
    // One failing write is enough to make the run partial (I1).
    store: { ...fileStore(root), putCassette() { throw new Error('disk full'); } },
    log: () => {},
  });
  const rw = await withRewind({ model: model(), recorder });
  await rw.model.invoke([{ role: 'user', content: 'hello' }], {});
  recorder.finish(null);

  assert.equal(recorder.run.status, 'partial');
  assert.throws(() => new Replayer({ root, runId: recorder.run.run_id }), /partial/);
});

test('mixing hash versions is refused by name, not by missing', async () => {
  const { root, runId } = await recorded();
  const store = fileStore(root);
  const trace = new Replayer({ root, runId }).source;
  // A corpus recorded under another version would miss on every step and look like
  // a total divergence. Say so instead (I2).
  store.putRun({ ...trace.run, hash_version: 2 });
  assert.throws(() => new Replayer({ root, runId }), /HASH_VERSION 2, this build is 3/);
});

test('a recorded response is revived before the graph sees it', async () => {
  const { root, runId } = await recorded();
  const replayer = new Replayer({ root, runId });
  // Cassettes hold JSON; frameworks want their own classes back.
  class Answer {
    content: string;
    constructor(content: string) {
      this.content = content; // parameter properties are not erasable
    }
  }
  const rw = await withRewind({
    model: model(),
    replayer,
    revive: (r) => new Answer((r as { content: string }).content),
  });
  const response = await rw.model.invoke([{ role: 'user', content: 'hello' }], {});
  assert.ok(response instanceof Answer);
  assert.equal((response as Answer).content, 'recorded answer');
});
