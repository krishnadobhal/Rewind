/**
 * Runs against PGlite — Postgres itself compiled to WASM, not a mock. Same SQL, same
 * types, same upsert semantics, and no daemon to have running. `pg.Pool` satisfies the
 * same `Sql` shape, so production uses a real server without touching this code.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Cassette, Run, Step } from '@rewind/core/schema';
import { fileBlobs } from '../src/blobs.ts';
import { migrate, pgStore, type Sql } from '../src/pg.ts';

let db: PGlite;
let store: ReturnType<typeof pgStore>;
let blobs: ReturnType<typeof fileBlobs>;

before(async () => {
  db = new PGlite();
  await migrate(db as unknown as Sql);
  blobs = fileBlobs(mkdtempSync(join(tmpdir(), 'rewind-blobs-')));
  store = pgStore(db as unknown as Sql, blobs);
});

after(() => db.close());

const run = (id: string, over: Partial<Run> = {}): Run => ({
  run_id: id, thread_id: 'th', graph_sha: 'g', code_sha: 'c', prompt_sha: 'p',
  model_cfg: { provider: 'anthropic' }, seed: 42, flags_snapshot: { TIER: 'a' },
  hash_version: 3, started_at: '2026-09-15T10:00:00.000Z', ended_at: null,
  status: 'complete', outcome: null, tokens: 0, cost_usd: 0, latency_ms: 0, ...over,
});

const step = (id: string, seq: number, over: Partial<Step> = {}): Step => ({
  run_id: id, seq, node: 'plan', kind: 'model', req_hash: 'a'.repeat(64),
  cassette_ref: 'a'.repeat(64), match_tier: 'recorded', latency_ms: 12,
  tokens: 5, cost_usd: 0.001, error: null, ...over,
});

const cassette = (hash: string, over: Partial<Cassette> = {}): Cassette => ({
  hash, hash_version: 3, kind: 'model', request: '{"kind":"model"}', response: '{"content":"hi"}',
  chunks: null, provider: 'anthropic', model_version: 'claude-opus-5',
  redaction_map: { '[redacted:email:0]': 'email' }, refcount: 1,
  recorded_at: '2026-09-15T10:00:00.000Z', ...over,
});

test('a run round-trips through Postgres unchanged', async () => {
  await store.putRun(run('01AAA'));
  await store.appendStep(step('01AAA', 0));
  await store.appendStep(step('01AAA', 1, { node: 'tools', kind: 'tool' }));

  const trace = (await store.readTrace('01AAA'))!;
  assert.equal(trace.run.run_id, '01AAA');
  assert.equal(trace.run.hash_version, 3);
  assert.deepEqual(trace.run.model_cfg, { provider: 'anthropic' });
  assert.deepEqual(trace.steps.map((s) => [s.seq, s.node, s.kind]), [[0, 'plan', 'model'], [1, 'tools', 'tool']]);
  assert.equal(trace.steps[0]!.match_tier, 'recorded', 'the tier survives storage (I3)');
});

test('finishing a run updates it rather than conflicting', async () => {
  await store.putRun(run('01BBB'));
  // The recorder writes the row twice: once on open, once on finish.
  await store.putRun(run('01BBB', { status: 'partial', ended_at: '2026-09-15T10:01:00.000Z', tokens: 99 }));

  const trace = (await store.readTrace('01BBB'))!;
  assert.equal(trace.run.status, 'partial');
  assert.equal(trace.run.tokens, 99);
  const { rows } = await db.query('select count(*)::int as n from runs where run_id = $1', ['01BBB']);
  assert.equal((rows[0] as { n: number }).n, 1, 'one row, not two');
});

test('I7: a redelivered step lands exactly once', async () => {
  await store.putRun(run('01CCC'));
  await store.appendStep(step('01CCC', 0));
  // A worker that crashed mid-write gets the job again. It must not double-count.
  await store.appendStep(step('01CCC', 0, { latency_ms: 999 }));

  const trace = (await store.readTrace('01CCC'))!;
  assert.equal(trace.steps.length, 1);
  assert.equal(trace.steps[0]!.latency_ms, 12, 'the first write stands; a step is immutable');
});

test('a cassette body goes to blobs, and the row holds a ref', async () => {
  const hash = 'b'.repeat(64);
  await store.putCassette(cassette(hash));

  const { rows } = await db.query('select request, response from cassettes where hash = $1', [hash]);
  const stored = rows[0] as { request: string; response: string };
  // ARCHITECTURE §13: bodies are blobs so a corpus can be committed and reviewed.
  assert.match(stored.request, /^file:\/\//, 'the row holds a ref, not the body');
  assert.doesNotMatch(stored.request, /kind/, 'the body is not in the database');

  const read = (await store.readCassette(hash))!;
  assert.equal(read.request, '{"kind":"model"}', 'the body comes back through the blob store');
  assert.deepEqual(read.redaction_map, { '[redacted:email:0]': 'email' });
});

test('the same cassette twice is one row with a refcount', async () => {
  const hash = 'c'.repeat(64);
  await store.putCassette(cassette(hash));
  await store.putCassette(cassette(hash));

  const read = (await store.readCassette(hash))!;
  // Dedup across a corpus is the reason for content addressing; refcount is what
  // lets GC know when the last run referring to a body has aged out (M7).
  assert.equal(read.refcount, 2);
});

test('an unknown run and an unknown cassette read as absent, not as an error', async () => {
  assert.equal(await store.readTrace('01NOPE'), null);
  assert.equal(await store.readCassette('d'.repeat(64)), null);
});

test('runs list in creation order, because ULIDs sort that way', async () => {
  const ids = await store.listRuns();
  assert.deepEqual(ids, [...ids].sort(), 'id order is time order');
  assert.ok(ids.includes('01AAA') && ids.includes('01CCC'));
});

test('the status check rejects a value the schema does not define', async () => {
  // The DDL and schema.ts must agree; the database is the one that can enforce it.
  await assert.rejects(() => store.putRun(run('01DDD', { status: 'finished' as Run['status'] })), /constraint|check/i);
});
