/**
 * M8's shape: an agent records through the emitter into Postgres, and something else
 * reads it back. The two halves never share memory — the data goes through the
 * database, which is the whole point of the milestone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { bufferedStore, type AsyncStore } from '@krishnadobhal/rewind-sdk-js/emitter';
import { Recorder } from '@krishnadobhal/rewind-sdk-js/recorder';
import { fileBlobs } from '../src/blobs.ts';
import { migrate, pgStore, type Sql } from '../src/pg.ts';

/** A model call, as the middleware would hand it over. */
const observation = (node: string, content: string) => ({
  node,
  kind: 'model' as const,
  request: { kind: 'model' as const, provider: 'anthropic', model_id: 'claude-opus-5', messages: [{ role: 'user', content }] },
  response: { content: 'answered' },
  latency_ms: 12,
  tokens: 7,
});

/** Records one run into a fresh database on disk, and returns how to reopen it. */
async function recordInto(options: { failWrites?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rewind-pg-'));
  const blobDir = mkdtempSync(join(tmpdir(), 'rewind-blobs-'));

  // An unreachable store needs no database: booting PGlite for a target that rejects
  // every write costs two seconds of WASM startup and buys nothing. It also made the
  // suite flaky under parallel test files.
  const down: AsyncStore = {
    putRun: () => Promise.reject(new Error('ECONNREFUSED')),
    appendStep: () => Promise.reject(new Error('ECONNREFUSED')),
    putCassette: () => Promise.reject(new Error('ECONNREFUSED')),
  };
  const writer = options.failWrites ? null : new PGlite(dataDir);
  if (writer !== null) await migrate(writer as unknown as Sql);
  const target: AsyncStore = writer === null ? down : pgStore(writer as unknown as Sql, fileBlobs(blobDir));

  const buffered = bufferedStore({ target, batchMs: 0, log: () => {} });
  const recorder = new Recorder({ store: buffered, log: () => {} });
  recorder.record(observation('plan', 'email ada@example.com about replay?'));
  recorder.record(observation('summarize', 'and then what?'));
  recorder.finish({ final_state_hash: 'sha256:e2e' });

  const flushed = await buffered.flush();
  await writer?.close(); // the recording process ends here
  return { dataDir, blobDir, runId: recorder.run.run_id, recorder, flushed };
}

test('a run recorded through the emitter reads back from a separate handle', async () => {
  const { dataDir, blobDir, runId, flushed } = await recordInto();
  assert.equal(flushed.dropped, 0);
  assert.equal(flushed.pending, 0);

  // Nothing is shared with the writer but the directory — this is the reader's
  // whole view, the same as a viewer on another machine would have.
  const reader = new PGlite(dataDir);
  const store = pgStore(reader as unknown as Sql, fileBlobs(blobDir));

  const trace = (await store.readTrace(runId))!;
  assert.equal(trace.run.status, 'complete');
  assert.equal(trace.run.tokens, 14);
  assert.deepEqual(trace.steps.map((s) => [s.seq, s.node]), [[0, 'plan'], [1, 'summarize']]);

  const cassette = (await store.readCassette(trace.steps[0]!.req_hash))!;
  // I4 holds across the network too: redaction ran in the recording process.
  assert.doesNotMatch(cassette.request, /ada@example\.com/);
  assert.deepEqual(Object.values(cassette.redaction_map), ['email']);
  await reader.close();
});

test('I1: the store being down does not reach the agent', async () => {
  // Every write rejects, the way an unreachable Postgres would.
  const { recorder, flushed } = await recordInto({ failWrites: true });

  assert.equal(flushed.written, 0);
  assert.ok(flushed.dropped >= 3, 'the writes were lost and counted');
  assert.equal(recorder.stats.steps, 2, 'the graph ran to completion regardless');
});

test('a dropped flush is a different failure from a dropped write', async () => {
  // #guard catches a write that threw. It cannot see a queue that never drained,
  // because pushing succeeded — the loss happens later, in the background.
  const { recorder } = await recordInto({ failWrites: true });
  assert.equal(recorder.stats.dropped, 0, 'the recorder saw no error at all');
  assert.equal(recorder.run.status, 'complete', 'and so it called the run complete');
});
