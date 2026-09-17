import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Cassette, Run, Step } from '@rewind/core/schema';
import type { AsyncStore } from '@rewind/sdk-js/emitter';
import type { Trace } from '@rewind/sdk-js/store';
import type { BlobStore } from './blobs.ts';
import type { StepHit, StepQuery } from './ingest.ts';

export type Sql = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

const MIGRATION = fileURLToPath(new URL('../migrations/001_init.sql', import.meta.url));

export async function migrate(sql: Sql): Promise<void> {
  const ddl = readFileSync(MIGRATION, 'utf8').replace(/^\s*--.*$/gm, ''); // drop comment lines
  for (const statement of ddl.split(';')) {
    if (statement.trim() !== '') await sql.query(statement);
  }
}

/** A store over Postgres for the index and a blob store for the bodies. */
export function pgStore(sql: Sql, blobs: BlobStore): AsyncStore & {
  readTrace: (runId: string) => Promise<Trace | null>;
  listRuns: () => Promise<string[]>;
  readCassette: (hash: string) => Promise<Cassette | null>;
  findSteps: (query: StepQuery) => Promise<StepHit[]>;
} {
  return {
    async putRun(run: Run) {
      await sql.query(
        `insert into runs (run_id, thread_id, graph_sha, code_sha, prompt_sha, model_cfg, seed,
           flags_snapshot, hash_version, started_at, ended_at, status, outcome, tokens, cost_usd, latency_ms)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         -- finish() rewrites the row it opened, so a run upserts rather than conflicts.
         on conflict (run_id) do update set
           ended_at = excluded.ended_at, status = excluded.status, outcome = excluded.outcome,
           tokens = excluded.tokens, cost_usd = excluded.cost_usd, latency_ms = excluded.latency_ms`,
        [run.run_id, run.thread_id, run.graph_sha, run.code_sha, run.prompt_sha,
         JSON.stringify(run.model_cfg), run.seed, JSON.stringify(run.flags_snapshot), run.hash_version,
         run.started_at, run.ended_at, run.status, run.outcome === null ? null : JSON.stringify(run.outcome),
         run.tokens, run.cost_usd, run.latency_ms],
      );
    },

    async appendStep(step: Step) {
      await sql.query(
        `insert into steps (run_id, seq, node, kind, req_hash, cassette_ref, match_tier,
           latency_ms, tokens, cost_usd, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         -- Append-only: the same step redelivered is the same step (I7).
         on conflict (run_id, seq) do nothing`,
        [step.run_id, step.seq, step.node, step.kind, step.req_hash, step.cassette_ref,
         step.match_tier, step.latency_ms, step.tokens, step.cost_usd,
         step.error === null ? null : JSON.stringify(step.error)],
      );
    },

    async putCassette(cassette: Cassette) {
      // Bodies go to blobs first: a row pointing at a missing body is worse than
      // a body nothing points at, which GC cleans up anyway.
      const [request, response, chunks] = await Promise.all([
        blobs.put(cassette.hash, 'request', cassette.request),
        blobs.put(cassette.hash, 'response', cassette.response),
        cassette.chunks === null ? Promise.resolve(null) : blobs.put(cassette.hash, 'chunks', cassette.chunks),
      ]);
      await sql.query(
        `insert into cassettes (hash, hash_version, kind, request, response, chunks,
           provider, model_version, redaction_map, refcount, recorded_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         -- Content-addressed and immutable: never overwrite, only count the reference.
         on conflict (hash) do update set refcount = cassettes.refcount + 1`,
        [cassette.hash, cassette.hash_version, cassette.kind, request, response, chunks,
         cassette.provider, cassette.model_version, JSON.stringify(cassette.redaction_map),
         cassette.refcount, cassette.recorded_at],
      );
    },

    async readTrace(runId: string) {
      const { rows } = await sql.query('select * from runs where run_id = $1', [runId]);
      if (rows.length === 0) return null; // unknown run id
      const steps = await sql.query('select * from steps where run_id = $1 order by seq', [runId]);
      return { run: toRun(rows[0]!), steps: steps.rows.map(toStep) };
    },

    async listRuns() {
      // ULIDs sort by time, so id order is creation order.
      const { rows } = await sql.query('select run_id from runs order by run_id');
      return rows.map((r) => String(r['run_id']));
    },

    async readCassette(hash: string) {
      const { rows } = await sql.query('select * from cassettes where hash = $1', [hash]);
      if (rows.length === 0) return null;
      const row = rows[0]!;
      // The row holds refs; the caller wants bodies.
      return {
        hash: String(row['hash']),
        hash_version: Number(row['hash_version']),
        kind: row['kind'] as Cassette['kind'],
        request: (await blobs.get(String(row['request']))) ?? '',
        response: (await blobs.get(String(row['response']))) ?? '',
        chunks: row['chunks'] === null ? null : await blobs.get(String(row['chunks'])),
        provider: row['provider'] as string | null,
        model_version: row['model_version'] as string | null,
        redaction_map: asJson(row['redaction_map']) as Record<string, string>,
        refcount: Number(row['refcount']),
        recorded_at: iso(row['recorded_at']),
      };
    },

    /**
     * Every occurrence of a call, newest run first.
     *
     * Both filters ride an index the schema already carries — `steps_req_hash` for the
     * identical call, `steps_kind_node` for the position. The join is for `started_at`,
     * which is what turns a row into something worth clicking.
     */
    async findSteps(query: StepQuery) {
      const where: string[] = [];
      const params: unknown[] = [];
      // Built positionally so an absent filter contributes no clause at all.
      if (query.hash !== undefined) where.push(`s.req_hash = $${params.push(query.hash)}`);
      if (query.node !== undefined) where.push(`s.node = $${params.push(query.node)}`);
      if (query.kind !== undefined) where.push(`s.kind = $${params.push(query.kind)}`);
      if (where.length === 0) return []; // an unfiltered scan is never the question
      const { rows } = await sql.query(
        `select s.run_id, s.seq, s.node, s.kind, s.req_hash, s.match_tier,
                r.started_at, r.status
         from steps s join runs r on r.run_id = s.run_id
         where ${where.join(' and ')}
         order by r.started_at desc, s.seq
         limit $${params.push(Math.min(query.limit ?? 50, 200))}`,
        params,
      );
      return rows.map((row) => ({
        run_id: String(row['run_id']),
        seq: Number(row['seq']),
        node: String(row['node']),
        kind: String(row['kind']),
        req_hash: String(row['req_hash']),
        match_tier: String(row['match_tier']),
        started_at: iso(row['started_at']),
        status: String(row['status']),
      }));
    },
  };
}

/** pg returns jsonb parsed; PGlite may hand back a string. */
function asJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** Timestamps come back as Date from pg, as a string from elsewhere. */
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Rebuilds a Run from its row. */
function toRun(row: Record<string, unknown>): Run {
  return {
    run_id: String(row['run_id']),
    thread_id: String(row['thread_id']),
    graph_sha: String(row['graph_sha']),
    code_sha: String(row['code_sha']),
    prompt_sha: String(row['prompt_sha']),
    model_cfg: asJson(row['model_cfg']) as Record<string, unknown>,
    seed: Number(row['seed']), // bigint comes back as a string; seeds stay under 2^53
    flags_snapshot: asJson(row['flags_snapshot']) as Record<string, string>,
    hash_version: Number(row['hash_version']),
    started_at: iso(row['started_at']),
    ended_at: row['ended_at'] === null ? null : iso(row['ended_at']),
    status: row['status'] as Run['status'],
    outcome: row['outcome'] === null ? null : (asJson(row['outcome']) as Run['outcome']),
    tokens: Number(row['tokens']),
    cost_usd: Number(row['cost_usd']),
    latency_ms: Number(row['latency_ms']),
  };
}

/** Rebuilds a Step from its row. */
function toStep(row: Record<string, unknown>): Step {
  return {
    run_id: String(row['run_id']),
    seq: Number(row['seq']),
    node: String(row['node']),
    kind: row['kind'] as Step['kind'],
    req_hash: String(row['req_hash']),
    cassette_ref: row['cassette_ref'] as string | null,
    match_tier: row['match_tier'] as Step['match_tier'],
    latency_ms: Number(row['latency_ms']),
    tokens: row['tokens'] === null ? null : Number(row['tokens']),
    cost_usd: row['cost_usd'] === null ? null : Number(row['cost_usd']),
    error: row['error'] === null ? null : asJson(row['error']),
  };
}
