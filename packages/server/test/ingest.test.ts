/**
 * The full M8 path: agent → emitter → HTTP → ingest → Postgres → blobs, and back.
 *
 * Every hop is the real one. The only thing standing in for production is PGlite,
 * which is Postgres compiled to WASM.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { bufferedStore } from '@rewind/sdk-js/emitter';
import { httpStore } from '@rewind/sdk-js/http';
import { Recorder } from '@rewind/sdk-js/recorder';
import { fileBlobs } from '../src/blobs.ts';
import { createIngestServer } from '../src/ingest.ts';
import { migrate, pgStore, type Sql } from '../src/pg.ts';

let db: PGlite;
let server: ReturnType<typeof createIngestServer>;
let url = '';
/** Every request the server saw, so a test can count round trips. */
const requests: string[] = [];

before(async () => {
  db = new PGlite();
  await migrate(db as unknown as Sql);
  const store = pgStore(db as unknown as Sql, fileBlobs(mkdtempSync(join(tmpdir(), 'rewind-ingest-'))));

  server = createIngestServer({ store, token: 'secret' });
  server.on('request', (request) => requests.push(`${request.method} ${request.url}`));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  return db.close();
});

/** An agent recording through the emitter into the ingest server. */
function agent(options: { token?: string; steps?: number } = {}) {
  const buffered = bufferedStore({
    target: httpStore({ url, token: options.token ?? 'secret' }),
    batchMs: 0,
    log: () => {},
  });
  const recorder = new Recorder({ store: buffered, log: () => {} });
  for (let i = 0; i < (options.steps ?? 2); i++) {
    recorder.record({
      node: `n${i}`,
      kind: 'model',
      request: { kind: 'model', provider: 'anthropic', model_id: 'claude-opus-5', messages: [{ role: 'user', content: `ask ada@example.com ${i}?` }] },
      response: { content: 'answered' },
      latency_ms: 10,
      tokens: 3,
    });
  }
  recorder.finish({ final_state_hash: 'sha256:ingest' });
  return { buffered, recorder };
}

test('a run reaches Postgres over HTTP and reads back', async () => {
  const { buffered, recorder } = agent();
  const flushed = await buffered.flush();
  assert.equal(flushed.dropped, 0);

  const response = await fetch(`${url}/v1/runs/${recorder.run.run_id}`, { headers: { authorization: 'Bearer secret' } });
  assert.equal(response.status, 200);
  const trace = (await response.json()) as { run: { status: string; tokens: number }; steps: { node: string }[] };
  assert.equal(trace.run.status, 'complete');
  assert.equal(trace.run.tokens, 6);
  assert.deepEqual(trace.steps.map((s) => s.node), ['n0', 'n1']);
});

test('I4 survives the wire: the server never receives plaintext', async () => {
  const { buffered, recorder } = agent({ steps: 1 });
  await buffered.flush();

  const trace = (await (await fetch(`${url}/v1/runs/${recorder.run.run_id}`, { headers: { authorization: 'Bearer secret' } })).json()) as { steps: { req_hash: string }[] };
  const cassette = (await (await fetch(`${url}/v1/cassettes/${trace.steps[0]!.req_hash}`, { headers: { authorization: 'Bearer secret' } })).json()) as { request: string; redaction_map: Record<string, string> };
  // Redaction ran in the agent's process, before anything left it. The server has
  // never seen the address, so no server-side bug can leak it.
  assert.doesNotMatch(cassette.request, /ada@example\.com/);
  assert.deepEqual(Object.values(cassette.redaction_map), ['email']);
});

test('a whole run is one request, not one per step', async () => {
  requests.length = 0;
  const { buffered } = agent({ steps: 5 });
  await buffered.flush();

  const ingests = requests.filter((r) => r.includes('/v1/ingest'));
  // 5 steps means 5 step writes, 5 cassettes and 2 run writes — twelve writes.
  // Without batching that is twelve round trips.
  assert.equal(ingests.length, 1, `expected one batched POST, saw ${ingests.length}`);
});

test('the server down does not reach the agent', async () => {
  // Nothing listening on this port.
  const buffered = bufferedStore({ target: httpStore({ url: 'http://127.0.0.1:1', timeoutMs: 500 }), batchMs: 0, log: () => {} });
  const recorder = new Recorder({ store: buffered, log: () => {} });

  assert.doesNotThrow(() => {
    recorder.record({
      node: 'plan',
      kind: 'model',
      request: { kind: 'model', provider: 'p', model_id: 'm', messages: [{ role: 'user', content: 'hi' }] },
      response: { content: 'ok' },
      latency_ms: 1,
    });
    recorder.finish({ final_state_hash: 'sha256:down' });
  });

  const flushed = await buffered.flush();
  assert.equal(flushed.written, 0);
  assert.ok(flushed.dropped > 0, 'the writes were lost and counted');
  assert.equal(recorder.stats.steps, 1, 'the graph ran regardless (I1)');
});

test('a rejected batch is counted, not silently accepted', async () => {
  const { buffered } = agent({ token: 'wrong' });
  const flushed = await buffered.flush();
  // A 401 must surface as a drop. Swallowing it would report a complete run whose
  // steps never arrived.
  assert.equal(flushed.written, 0);
  assert.ok(flushed.dropped > 0);
});

test('health needs no token, everything else does', async () => {
  assert.equal((await fetch(`${url}/health`)).status, 200, 'a load balancer should not need a credential');
  assert.equal((await fetch(`${url}/v1/runs`)).status, 401);
  assert.equal((await fetch(`${url}/v1/runs`, { headers: { authorization: 'Bearer secret' } })).status, 200);
});

test('an unknown run is 404, and an unknown route is too', async () => {
  const auth = { headers: { authorization: 'Bearer secret' } };
  assert.equal((await fetch(`${url}/v1/runs/01NOPE`, auth)).status, 404);
  assert.equal((await fetch(`${url}/v1/nonsense`, auth)).status, 404);
});

test('/v1/runs answers with the summary the viewer renders', async () => {
  const { buffered } = agent({ steps: 2 });
  await buffered.flush();

  const rows = (await (await fetch(`${url}/v1/runs`, { headers: { authorization: 'Bearer secret' } })).json()) as Record<string, unknown>[];
  assert.ok(rows.length > 0);
  // Exactly the fields a row renders. A rename here blanks the list silently, and
  // the viewer has no server of its own to keep in sync with.
  for (const field of ['run_id', 'status', 'steps', 'tokens', 'cost_usd', 'latency_ms', 'started_at', 'tiers']) {
    assert.ok(field in rows[0]!, `missing ${field}`);
  }
  assert.equal(rows[0]!['steps'], 2);
  assert.deepEqual(rows[0]!['tiers'], { recorded: 2 }, 'tiers are always reported (I3)');
  // Newest first: the run you just recorded is the one you want to open.
  assert.ok(String(rows[0]!['run_id']) >= String(rows[rows.length - 1]!['run_id']));
});

test('/v1/steps finds the same call in another run', async () => {
  const auth = { headers: { authorization: 'Bearer secret' } };
  // Two runs asking the same questions: same canonical request, so the same hash.
  const first = agent({ steps: 2 });
  await first.buffered.flush();
  const second = agent({ steps: 2 });
  await second.buffered.flush();

  const trace = (await (await fetch(`${url}/v1/runs/${first.recorder.run.run_id}`, auth)).json()) as { steps: { req_hash: string }[] };
  const hash = trace.steps[0]!.req_hash;

  const hits = (await (await fetch(`${url}/v1/steps?hash=${encodeURIComponent(hash)}`, auth)).json()) as Record<string, unknown>[];
  const runs = hits.map((hit) => hit['run_id']);
  assert.ok(runs.includes(first.recorder.run.run_id), 'the run it came from');
  assert.ok(runs.includes(second.recorder.run.run_id), 'and the other run that asked it');
  // Exactly the fields a row renders, same reason as /v1/runs.
  for (const field of ['run_id', 'seq', 'node', 'kind', 'req_hash', 'match_tier', 'started_at', 'status']) {
    assert.ok(field in hits[0]!, `missing ${field}`);
  }
});

test('/v1/steps by node finds the position, and no filter finds nothing', async () => {
  const auth = { headers: { authorization: 'Bearer secret' } };
  const hits = (await (await fetch(`${url}/v1/steps?node=n0&kind=model`, auth)).json()) as { node: string }[];
  assert.ok(hits.length >= 2);
  assert.ok(hits.every((hit) => hit.node === 'n0'));
  // An unfiltered query is never the question being asked, so it is not a table scan.
  assert.deepEqual(await (await fetch(`${url}/v1/steps`, auth)).json(), []);
});
