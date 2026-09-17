import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cassette, Run, Step } from '@krishnadobhal/rewind-core/schema';
import { bufferedStore, type AsyncStore } from '../src/emitter.ts';
import { Recorder } from '../src/recorder.ts';

/** A slow target that records what reached it, and can be made to fail. */
function target(options: { failEvery?: number; delayMs?: number } = {}) {
  const written: string[] = [];
  let calls = 0;
  const accept = async (what: string) => {
    calls++;
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    if (options.failEvery && calls % options.failEvery === 0) throw new Error('target unavailable');
    written.push(what);
  };
  const store: AsyncStore = {
    putRun: (r: Run) => accept(`run:${r.run_id}`),
    appendStep: (s: Step) => accept(`step:${s.seq}`),
    putCassette: (c: Cassette) => accept(`cassette:${c.hash.slice(0, 6)}`),
  };
  return { store, written };
}

const step = (seq: number): Step => ({
  run_id: 'r', seq, node: 'n', kind: 'model', req_hash: 'h', cassette_ref: null,
  match_tier: 'recorded', latency_ms: 0, tokens: null, cost_usd: null, error: null,
});

test('a push never blocks and never throws', () => {
  const { store } = target({ delayMs: 50 });
  const buffered = bufferedStore({ target: store, log: () => {} });

  const started = Date.now();
  for (let i = 0; i < 100; i++) buffered.appendStep(step(i));
  // The whole point: the graph does not wait for the network.
  assert.ok(Date.now() - started < 50, 'pushing queued instead of writing');
  assert.equal(buffered.stats.queued, 100);
  assert.equal(buffered.stats.written, 0, 'nothing has drained yet');
});

test('flush drains everything, in order', async () => {
  const { store, written } = target();
  const buffered = bufferedStore({ target: store, batchMs: 0, log: () => {} });

  for (let i = 0; i < 20; i++) buffered.appendStep(step(i));
  const result = await buffered.flush();

  assert.equal(result.written, 20);
  assert.equal(result.pending, 0);
  // Steps must land in order or a trace reads as a different run.
  assert.deepEqual(written, Array.from({ length: 20 }, (_, i) => `step:${i}`));
});

test('a full queue drops the newest and counts it', async () => {
  const { store, written } = target();
  const buffered = bufferedStore({ target: store, maxQueue: 5, batchMs: 10_000, log: () => {} });

  for (let i = 0; i < 12; i++) buffered.appendStep(step(i));
  assert.equal(buffered.stats.dropped, 7, 'bounded memory beats complete telemetry');

  const result = await buffered.flush();
  assert.equal(result.written, 5);
  // The oldest survive: the start of a run explains more than its end.
  assert.deepEqual(written, ['step:0', 'step:1', 'step:2', 'step:3', 'step:4']);
});

test('a failing target loses the write, not the process', async () => {
  const logged: string[] = [];
  const { store, written } = target({ failEvery: 2 });
  const buffered = bufferedStore({ target: store, batchMs: 0, log: (m) => logged.push(m) });

  for (let i = 0; i < 6; i++) buffered.appendStep(step(i));
  const result = await buffered.flush();

  assert.equal(result.written, 3);
  assert.equal(result.dropped, 3);
  assert.deepEqual(written, ['step:0', 'step:2', 'step:4']);
  assert.equal(logged.length, 1, 'logged once, not once per failure');
});

test('the recorder does not know the store is remote', async () => {
  const { store, written } = target();
  const buffered = bufferedStore({ target: store, batchMs: 0, log: () => {} });
  // bufferedStore is a Store, so Recorder takes it unchanged — that is the whole
  // reason the emitter wears this shape rather than a new interface.
  const recorder = new Recorder({ store: buffered, log: () => {} });
  recorder.record({
    node: 'plan',
    kind: 'model',
    request: { kind: 'model', provider: 'p', model_id: 'm', messages: [{ role: 'user', content: 'hi' }] },
    response: { content: 'ok' },
    latency_ms: 1,
  });
  recorder.finish({ final_state_hash: 'sha256:x' });

  await buffered.flush();
  assert.equal(recorder.run.status, 'complete', 'queueing is not dropping');
  assert.equal(written.filter((w) => w.startsWith('step:')).length, 1);
  assert.equal(written.filter((w) => w.startsWith('cassette:')).length, 1);
  assert.equal(written.filter((w) => w.startsWith('run:')).length, 2, 'opened and finished');
});

test('writes still in flight at the end are reported, not hidden', async () => {
  const { store } = target({ delayMs: 5 });
  const buffered = bufferedStore({ target: store, maxQueue: 3, batchMs: 10_000, log: () => {} });

  for (let i = 0; i < 10; i++) buffered.appendStep(step(i));
  const result = await buffered.flush();

  // `dropped` is the number #guard can never see: nothing threw, the queue overflowed.
  assert.equal(result.dropped, 7);
  assert.equal(result.pending, 0, 'flush waits rather than reporting a lie');
});

test('a batching target gets one call, not one per write', async () => {
  const batches: number[] = [];
  const buffered = bufferedStore({
    batchMs: 0,
    log: () => {},
    target: {
      putRun: async () => {},
      appendStep: async () => {},
      putCassette: async () => {},
      // Present, so the emitter must prefer it — over HTTP this is the difference
      // between one request per run and one per boundary crossing.
      putBatch: async (writes) => void batches.push(writes.length),
    },
  });

  for (let i = 0; i < 12; i++) buffered.appendStep(step(i));
  const result = await buffered.flush();
  assert.deepEqual(batches, [12], 'twelve writes, one call');
  assert.equal(result.written, 12);
});

test('a batch is split at maxBatch, still in order', async () => {
  const seen: number[][] = [];
  const buffered = bufferedStore({
    batchMs: 0,
    maxBatch: 4,
    log: () => {},
    target: {
      putRun: async () => {},
      appendStep: async () => {},
      putCassette: async () => {},
      putBatch: async (writes) => void seen.push(writes.map((w) => (w.kind === 'step' ? w.step.seq : -1))),
    },
  });

  for (let i = 0; i < 10; i++) buffered.appendStep(step(i));
  await buffered.flush();
  assert.deepEqual(seen, [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]], 'chunked, and sequence preserved');
});

test('a target without putBatch still works one write at a time', async () => {
  const { store, written } = target();
  // fileStore has no putBatch. Adding batching must not have broken the local path.
  assert.equal((store as { putBatch?: unknown }).putBatch, undefined);
  const buffered = bufferedStore({ target: store, batchMs: 0, log: () => {} });
  for (let i = 0; i < 3; i++) buffered.appendStep(step(i));
  await buffered.flush();
  assert.deepEqual(written, ['step:0', 'step:1', 'step:2']);
});
