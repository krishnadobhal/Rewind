/**
 * Smoke-tests the Postgres store against a real server.
 *
 *   node --env-file=.env scripts/smoke-pg.ts
 *
 * The unit tests run against PGlite, which is Postgres compiled to WASM — same SQL,
 * no daemon. This checks the things WASM cannot: a real network, TLS, a pooler, and
 * a driver that is `pg` rather than an embedded engine.
 *
 * It works inside a throwaway schema and drops it at the end, so pointing this at a
 * database that has other things in it is safe.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { fileBlobs } from '@rewind/server/blobs';
import { migrate, pgStore, type Sql } from '@rewind/server/pg';
import { loadEnvFile } from '@rewind/sdk-js/env';

loadEnvFile();

const SCHEMA = 'rewind_smoke';
/** Refuses the template's placeholder, which is what a fresh `cp` leaves behind. */
function requireReal(name: string, value: string | undefined, placeholder: string): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set — copy .env.example to .env and fill it in`);
  }
  if (value.includes(placeholder)) {
    throw new Error(`${name} is still the .env.example placeholder — put a real value in .env`);
  }
  return value;
}

const url = requireReal('DATABASE_URL', process.env['DATABASE_URL'], 'user:password@host');

// Strip libpq's sslmode/channel_binding: node-postgres is changing how it reads them,
// and an explicit `ssl` option says what we mean without depending on that.
const dsn = new URL(url);
for (const param of ['sslmode', 'channel_binding']) dsn.searchParams.delete(param);
const pool = new pg.Pool({ connectionString: dsn.href, ssl: { rejectUnauthorized: true } });
const blobDir = mkdtempSync(join(tmpdir(), 'rewind-smoke-'));
const sql: Sql = {
  // Everything runs inside the throwaway schema, including the migration's
  // `create table`, so nothing else in this database is touched.
  query: async (text, params) => {
    const client = await pool.connect();
    try {
      await client.query(`set search_path to ${SCHEMA}`);
      return await client.query(text, params as unknown[]);
    } finally {
      client.release();
    }
  },
};

const checks: string[] = [];
const check = (name: string, ok: boolean) => {
  checks.push(`${ok ? '✔' : '✖'} ${name}`);
  if (!ok) process.exitCode = 1;
};

try {
  const { rows: version } = await pool.query('select version()');
  console.log(String((version[0] as { version: string }).version).split(',')[0]);

  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
  await pool.query(`create schema ${SCHEMA}`);
  await migrate(sql);
  check('migration applies to a real server', true);

  const store = pgStore(sql, fileBlobs(blobDir));
  const hash = 'a'.repeat(64);
  await store.putRun({
    run_id: '01SMOKE', thread_id: 't', graph_sha: 'g', code_sha: 'c', prompt_sha: 'p',
    model_cfg: { provider: 'anthropic' }, seed: 42, flags_snapshot: {}, hash_version: 3,
    started_at: new Date().toISOString(), ended_at: null, status: 'complete',
    outcome: { final_state_hash: 'sha256:smoke' }, tokens: 7, cost_usd: 0.0012, latency_ms: 340,
  });
  await store.appendStep({
    run_id: '01SMOKE', seq: 0, node: 'plan', kind: 'model', req_hash: hash,
    cassette_ref: hash, match_tier: 'recorded', latency_ms: 340, tokens: 7, cost_usd: 0.0012, error: null,
  });
  await store.putCassette({
    hash, hash_version: 3, kind: 'model', request: '{"kind":"model"}', response: '{"content":"hi"}',
    chunks: null, provider: 'anthropic', model_version: 'claude-opus-5',
    redaction_map: { '[redacted:email:0]': 'email' }, refcount: 1, recorded_at: new Date().toISOString(),
  });

  const trace = await store.readTrace('01SMOKE');
  check('a run round-trips over the network', trace?.run.run_id === '01SMOKE' && trace.steps.length === 1);
  // numeric and timestamptz come back differently from pg than from PGlite; this is
  // the conversion PGlite cannot exercise.
  check('numeric survives as a number', trace?.run.cost_usd === 0.0012);
  check('timestamptz comes back as an ISO string', typeof trace?.run.started_at === 'string' && trace.run.started_at.endsWith('Z'));
  check('jsonb comes back parsed', (trace?.run.outcome as { final_state_hash?: string })?.final_state_hash === 'sha256:smoke');

  // I7: a redelivered write must land exactly once.
  await store.appendStep({
    run_id: '01SMOKE', seq: 0, node: 'plan', kind: 'model', req_hash: hash,
    cassette_ref: hash, match_tier: 'recorded', latency_ms: 999, tokens: 7, cost_usd: 0.0012, error: null,
  });
  const again = await store.readTrace('01SMOKE');
  check('a redelivered step lands once (I7)', again?.steps.length === 1 && again.steps[0]!.latency_ms === 340);

  const cassette = await store.readCassette(hash);
  check('a cassette body comes back from blobs', cassette?.request === '{"kind":"model"}');
  check('the row holds a ref, not the body', (await pool.query(`select request from ${SCHEMA}.cassettes where hash = $1`, [hash])).rows[0].request.startsWith('file://'));
} finally {
  // Leave the database exactly as it was found.
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
  await pool.end();
  rmSync(blobDir, { recursive: true, force: true });
}

console.log(checks.join('\n'));
console.log(process.exitCode ? 'smoke: FAILED' : 'smoke: ok, schema dropped');
