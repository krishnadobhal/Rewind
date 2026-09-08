/**
 * Contract tests between the page and the server.
 *
 * The page is vanilla JS with no build step, so the thing that can silently break is
 * the agreement between them: a renamed field or a moved route. These fetch what the
 * page fetches, in the order the page fetches it, and assert the shapes it reads.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Script } from 'node:vm';
import { MATCH_TIERS } from '@rewind/core/schema';
import { HumanMessage } from '@langchain/core/messages';
import { Recorder } from '@rewind/sdk-js/recorder';
import { fileStore } from '@rewind/sdk-js/store';
import { buildGraph, script, webSearch } from 'deep-research-agent/graph';
import { ScriptedChatModel } from 'deep-research-agent/model';
import { createUiServer } from '../src/server.ts';

const PAGE = readFileSync(fileURLToPath(new URL('../src/app.html', import.meta.url)), 'utf8');

let base = '';
let server: ReturnType<typeof createUiServer>;
let runId = '';

const get = async (path: string) => {
  const response = await fetch(`${base}/${path}`);
  // The page is HTML; everything under /api is JSON. Do not parse one as the other.
  const isJson = response.headers.get('content-type')?.includes('json') ?? false;
  return { status: response.status, body: isJson && response.status === 200 ? await response.json() : null };
};

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-ui-'));
  const recorder = new Recorder({ store: fileStore(dir), log: () => {} });
  const { graph } = await buildGraph({
    model: new ScriptedChatModel({ responses: script(), model: 'scripted-planner-1' }),
    tools: [webSearch],
    recorder,
  });
  await graph.invoke({ messages: [new HumanMessage('email ada@example.com about replay?')] });
  recorder.finish({ final_state_hash: 'sha256:ui' });
  runId = recorder.run.run_id;

  server = createUiServer(dir);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test('the page is served and asks for relative URLs only', () => {
  // An absolute base path baked into the HTML is bull-board's most common bug report,
  // and it is what would stop this page ever being mounted under a prefix.
  const fetches = [...PAGE.matchAll(/fetch\(`?([^`')]+)/g)].map((m) => m[1]!);
  assert.ok(fetches.length > 0, 'the page fetches something');
  for (const url of fetches) assert.doesNotMatch(url, /^\/|^https?:/, `absolute URL in page: ${url}`);
});

test('every route the page calls exists on the server', async () => {
  assert.equal((await get('')).status, 200, 'the page itself');
  assert.equal((await get('api/runs')).status, 200);
  assert.equal((await get(`api/runs/${runId}`)).status, 200);
});

test('the run list carries what a row renders', async () => {
  const { body } = await get('api/runs');
  const rows = body as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  // Exactly the fields the row template reads — a rename here breaks the page silently.
  for (const field of ['run_id', 'status', 'steps', 'tokens', 'started_at', 'tiers']) {
    assert.ok(field in rows[0]!, `missing ${field}`);
  }
  assert.equal(rows[0]!['steps'], 3);
  assert.deepEqual(rows[0]!['tiers'], { recorded: 3 }, 'tiers are always reported (I3)');
});

test('a run detail carries its steps in order', async () => {
  const { body } = await get(`api/runs/${runId}`);
  const { run, steps } = body as { run: Record<string, unknown>; steps: Record<string, unknown>[] };
  assert.equal(run['run_id'], runId);
  assert.deepEqual(steps.map((s) => [s['seq'], s['node'], s['kind']]), [[0, 'plan', 'model'], [1, 'tools', 'tool'], [2, 'summarize', 'model']]);
  for (const field of ['match_tier', 'req_hash', 'latency_ms', 'cassette_ref']) {
    assert.ok(field in steps[0]!, `missing ${field}`);
  }
});

test('a cassette arrives decoded, with its redaction map', async () => {
  const { body: detail } = await get(`api/runs/${runId}`);
  const hash = (detail as { steps: { req_hash: string }[] }).steps[0]!.req_hash;
  const { body } = await get(`api/cassettes/${hash}`);
  const cassette = body as Record<string, unknown>;

  // The page renders these with JSON.stringify, so they must arrive as objects.
  assert.equal(typeof cassette['request'], 'object', 'request is decoded, not a string');
  assert.equal(typeof cassette['response'], 'object');
  assert.deepEqual(Object.values(cassette['redaction_map'] as object), ['email']);
  // I4 again, from the other side: the viewer must never be able to show the original.
  assert.doesNotMatch(JSON.stringify(cassette), /ada@example\.com/);
});

test('unknown ids and bad paths are 404, not a crash', async () => {
  assert.equal((await get('api/runs/does_not_exist')).status, 404);
  assert.equal((await get(`api/cassettes/${'0'.repeat(64)}`)).status, 404);
  assert.equal((await get('api/nonsense')).status, 404);
});

test('the page script parses — there is no build step to catch a typo', () => {
  // Vanilla JS with no bundler means nothing checks this file until a browser loads it.
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(PAGE)?.[1];
  assert.ok(script, 'the page has a module script');
  assert.doesNotThrow(() => new Script(script!, { filename: 'app.html' }));
});

test('the page renders every tier it might be handed', () => {
  // A tier with no CSS class renders as unstyled text, which reads as "no tier at all".
  const styles = /<style>([\s\S]*?)<\/style>/.exec(PAGE)?.[1] ?? '';
  for (const tier of MATCH_TIERS) {
    assert.ok(styles.includes(`.${tier}`), `no style for tier: ${tier}`);
  }
});
