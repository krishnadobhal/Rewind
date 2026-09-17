import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Cassette, Run, Step } from '@krishnadobhal/rewind-core/schema';
import type { AsyncStore, BatchWrite } from '@krishnadobhal/rewind-sdk-js/emitter';
import type { Trace } from '@krishnadobhal/rewind-sdk-js/store';


export type StepQuery = { hash?: string; node?: string; kind?: string; limit?: number };

/** One occurrence, carrying enough of its run to be worth opening. */
export type StepHit = {
  run_id: string;
  seq: number;
  node: string;
  kind: string;
  req_hash: string;
  match_tier: string;
  started_at: string;
  status: string;
};

/** What the server needs: a place to write, and a way to read back. */
export type IngestStore = AsyncStore & {
  readTrace: (runId: string) => Promise<Trace | null>;
  listRuns: () => Promise<string[]>;
  readCassette: (hash: string) => Promise<Cassette | null>;
  /** Other occurrences of a call, across every recorded run. */
  findSteps?: (query: StepQuery) => Promise<StepHit[]>;
};

export type IngestOptions = {
  store: IngestStore;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** Refuse a body larger than this, so one client cannot exhaust memory. */
  maxBodyBytes?: number;
};

/** Reads a JSON body, refusing anything oversized. */
async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // Bail during the stream, not after: the point is to not buffer it all.
    if (size > limit) throw new Error(`body over ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** One row in the run list: enough to choose, not enough to scroll. */
export type RunSummary = {
  run_id: string;
  status: string;
  steps: number;
  tokens: number;
  cost_usd: number;
  latency_ms: number;
  started_at: string;
  tiers: Record<string, number>;
};


async function summaries(store: IngestStore): Promise<RunSummary[]> {
  const rows: RunSummary[] = [];
  for (const id of await store.listRuns()) {
    const trace = await store.readTrace(id);
    if (trace === null) continue; // half-written run; skip rather than fail the list
    const tiers: Record<string, number> = {};
    for (const step of trace.steps) tiers[step.match_tier] = (tiers[step.match_tier] ?? 0) + 1;
    rows.push({
      run_id: trace.run.run_id,
      status: trace.run.status,
      steps: trace.steps.length,
      tokens: trace.run.tokens,
      cost_usd: trace.run.cost_usd,
      latency_ms: trace.run.latency_ms,
      started_at: trace.run.started_at,
      tiers, // always reported, even when every step is the same tier (I3)
    });
  }
  return rows.reverse(); // ULIDs sort by time, so reversing gives newest first
}

/** Applies one batch in order, so steps land in sequence. */
async function apply(store: AsyncStore, writes: BatchWrite[]): Promise<void> {
  for (const write of writes) {
    if (write.kind === 'run') await store.putRun(write.run as Run);
    else if (write.kind === 'step') await store.appendStep(write.step as Step);
    else await store.putCassette(write.cassette as Cassette);
  }
}

/** Builds the ingest server over a store. */
export function createIngestServer(options: IngestOptions) {
  const { store, token, maxBodyBytes = 8 * 1024 * 1024 } = options;

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;

      // Health is unauthenticated on purpose: a load balancer should not need a token.
      if (path === '/health') return json(response, 200, { ok: true });

      if (token !== undefined && request.headers.authorization !== `Bearer ${token}`) {
        return json(response, 401, { error: 'unauthorized' });
      }

      try {
        if (request.method === 'POST' && path === '/v1/ingest') {
          const body = (await readJson(request, maxBodyBytes)) as { writes?: BatchWrite[] };
          const writes = body.writes ?? [];
          await apply(store, writes);
          // The count is what lets a client tell "accepted" from "silently ignored".
          return json(response, 200, { written: writes.length });
        }

        if (request.method === 'GET' && path === '/v1/runs') {
          // Summaries, not bare ids: the viewer's list needs step counts and tiers,
          // and a second round trip per run to get them would be the wrong shape.
          return json(response, 200, await summaries(store));
        }

        if (request.method === 'GET' && path === '/v1/steps') {
          // Either axis, or both: hash pins the identical call, node+kind the position.
          const hits = (await store.findSteps?.({
            hash: url.searchParams.get('hash') ?? undefined,
            node: url.searchParams.get('node') ?? undefined,
            kind: url.searchParams.get('kind') ?? undefined,
            limit: Number(url.searchParams.get('limit') ?? 50),
          })) ?? [];
          return json(response, 200, hits);
        }

        const run = /^\/v1\/runs\/([\w-]+)$/.exec(path);
        if (request.method === 'GET' && run) {
          const trace = await store.readTrace(run[1]!);
          return trace === null ? json(response, 404, { error: 'not found' }) : json(response, 200, trace);
        }

        const cassette = /^\/v1\/cassettes\/([0-9a-f]{64})$/.exec(path);
        if (request.method === 'GET' && cassette) {
          const found = await store.readCassette(cassette[1]!);
          return found === null ? json(response, 404, { error: 'not found' }) : json(response, 200, found);
        }

        json(response, 404, { error: 'no such route' });
      } catch (error) {
        // A 500 makes the client's emitter count the batch as dropped and mark the
        // run partial — which is the honest outcome. Never answer 200 on failure.
        json(response, 500, { error: String(error) });
      }
    })();
  });
}
