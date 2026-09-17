/**
 * The M1 gate: every run in the corpus replays to the same steps, with the network
 * physically blocked.
 *
 *   pnpm test:determinism
 *
 * This is the milestone that proves the thesis. If it drops below 100% the cause is
 * almost always an unshimmed boundary — `docs/DETERMINISM.md` lists them, and the
 * clock and RNG shims are the two currently deferred.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HumanMessage } from '@langchain/core/messages';
import { HASH_VERSION, stateHash } from '@rewind/core/hash';
import { Replayer } from '@rewind/sdk-js/replay';
import { buildGraph, routerScript, script, webSearch } from 'deep-research-agent/graph';
import { ScriptedChatModel } from 'deep-research-agent/model';
import { attempts, denyNetwork } from '../fixtures/no-network.ts';

const ROOT = 'bench/corpus';
type Entry = { run_id: string; question: string; routed: boolean; steps: number; final_state_hash: string };
const manifest = JSON.parse(readFileSync(`${ROOT}/manifest.json`, 'utf8')) as { hash_version: number; runs: Entry[] };

let restore = () => {};
before(() => { restore = denyNetwork(); });
after(() => restore());

/** Replays one corpus run, with its final state hash for the caller to check. */
async function replay(entry: Entry) {
  const replayer = new Replayer({ root: ROOT, runId: entry.run_id, onMiss: 'strict' });
  const { graph } = await buildGraph({
    model: new ScriptedChatModel({ responses: script(), model: 'scripted-planner-1' }),
    tools: [webSearch],
    router: entry.routed ? new ScriptedChatModel({ responses: routerScript('research'), model: 'scripted-router-1' }) : undefined,
    replayer,
  });
  const state = await graph.invoke({ messages: [new HumanMessage(entry.question)] });
  return { replayer, final: stateHash(state) };
}

test('the corpus was recorded under this build of the hash', () => {
  // Replaying across versions misses on every step and looks like total divergence.
  assert.equal(manifest.hash_version, HASH_VERSION);
  assert.ok(manifest.runs.length >= 20, `corpus is ${manifest.runs.length} runs`);
});

test('every corpus run replays identically, with no network', async () => {
  const failures: string[] = [];
  let steps = 0;

  for (const entry of manifest.runs) {
    const { replayer, final } = await replay(entry);
    steps += replayer.steps.length;
    // Both checks, not either: the step sequence proves the path, the state hash
    // proves the outcome. A run can reproduce one and not the other.
    const path = replayer.reproduced ? 'match' : 'diverged';
    const outcome = final === entry.final_state_hash ? 'match' : 'mismatch';
    if (path !== 'match' || outcome !== 'match') {
      failures.push(`${entry.run_id} ${path}/${outcome} at seq ${replayer.divergenceSeq ?? '-'} — ${entry.question}`);
    }
  }

  const rate = ((manifest.runs.length - failures.length) / manifest.runs.length) * 100;
  console.log(`determinism: ${manifest.runs.length - failures.length}/${manifest.runs.length} runs (${rate.toFixed(1)}%), ${steps} steps, ${attempts.length} network attempts`);
  assert.deepEqual(failures, [], 'runs that did not reproduce');
  assert.deepEqual(attempts, [], 'a replay reached for the network (I6)');
});

test('every replayed step resolved exact — nothing was approximated', async () => {
  const { replayer } = await replay(manifest.runs[0]!);
  assert.equal(replayer.tiers.miss, 0);
  assert.equal(replayer.tiers.exact, replayer.source.steps.length);
});

test('the fixture actually blocks — otherwise this suite proves nothing', async () => {
  await assert.rejects(() => fetch('https://api.anthropic.com/v1/messages'), /network blocked/);
  assert.equal(attempts.length, 1);
  attempts.length = 0; // do not leak into the run above
});
