/**
 * The viewer's server: a directory, four routes, no dependencies.
 *
 * Standalone rather than mountable — `rewind record -- node agent.js` runs and exits,
 * so there is no long-lived host process to mount a router into (ROADMAP M6). The page
 * uses relative URLs only, which keeps mounting possible later at no cost today.
 *
 * Read-only on purpose. A viewer that only reads is safe to leave running; one that can
 * spawn processes is a different thing, and that choice should be made deliberately.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DIR } from '@rewind/sdk-js/config';
import { listRuns, readCassette, readTrace } from '@rewind/sdk-js/store';
import type { Step } from '@rewind/core/schema';

const PAGE = fileURLToPath(new URL('./app.html', import.meta.url));

/** One row in the run list: enough to choose, not enough to scroll. */
type Summary = {
  run_id: string;
  status: string;
  steps: number;
  tokens: number;
  cost_usd: number;
  latency_ms: number;
  started_at: string;
  tiers: Record<string, number>;
};

/** Counts how many steps resolved at each tier (I3 — always reported). */
function tiersOf(steps: Step[]): Record<string, number> {
  const tiers: Record<string, number> = {};
  for (const step of steps) tiers[step.match_tier] = (tiers[step.match_tier] ?? 0) + 1;
  return tiers;
}

/**
 * Every run, newest first.
 *
 * ponytail: reads each run's steps to count them. Fine for hundreds, slow in the low
 * thousands — that is the SQLite trigger in WISHLIST.md, not a reason to build one now.
 */
function summaries(root: string): Summary[] {
  const rows: Summary[] = [];
  for (const id of listRuns(root)) {
    const trace = readTrace(root, id);
    if (trace === null) continue; // half-written run, skip it rather than fail the list
    const { run, steps } = trace;
    rows.push({
      run_id: run.run_id,
      status: run.status,
      steps: steps.length,
      tokens: run.tokens,
      cost_usd: run.cost_usd,
      latency_ms: run.latency_ms,
      started_at: run.started_at,
      tiers: tiersOf(steps),
    });
  }
  return rows.reverse(); // ULIDs sort by time, so reversing gives newest first
}

/** Sends a JSON body, or 404 when the value is null. */
function json(response: import('node:http').ServerResponse, value: unknown): void {
  if (value === null) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

/** Builds the viewer's server over one store directory. */
export function createUiServer(root: string) {
  return createServer((request, response) => {
    // No base path: every URL the page builds is relative to where it was served from.
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      // Read per request, so editing the page needs a refresh, not a restart.
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(readFileSync(PAGE, 'utf8'));
      return;
    }
    if (path === '/api/runs') return json(response, summaries(root));

    const run = /^\/api\/runs\/([\w-]+)$/.exec(path);
    if (run) return json(response, readTrace(root, run[1]!));

    const cassette = /^\/api\/cassettes\/([0-9a-f]{64})$/.exec(path);
    if (cassette) {
      const found = readCassette(root, cassette[1]!);
      if (found === null) return json(response, null);
      // Parse the bodies here so the page never has to double-decode.
      return json(response, {
        ...found,
        request: JSON.parse(found.request) as unknown,
        response: JSON.parse(found.response) as unknown,
      });
    }

    json(response, null);
  });
}

/**
 * Nearest .rewind walking up from the cwd, the way tools find .git.
 *
 * A relative default resolves against the cwd, so `pnpm -F @rewind/ui dev` read
 * packages/ui/.rewind and listed nothing — a missing directory reads as empty (I1),
 * which makes a wrong path look like an empty store.
 */
function resolveRoot(from: string = process.cwd()): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, DEFAULT_DIR);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return resolve(from, DEFAULT_DIR); // none found, name the default
  }
}

// Only listen when run directly, so tests can start it on a port of their choosing.
if (import.meta.main) {
  const configured = process.env['REWIND_DIR'];
  const root = configured === undefined ? resolveRoot() : resolve(configured);
  const port = Number(process.env['REWIND_UI_PORT'] ?? 4100);
  createUiServer(root).listen(port, '127.0.0.1', () => {
    // The count is the whole point: an empty store and a wrong path look alike without it.
    console.log(`rewind ui  http://localhost:${port}  reading ${root}  (${listRuns(root).length} runs)`);
  });
}
