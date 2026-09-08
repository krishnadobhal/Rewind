import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const AGENT = fileURLToPath(new URL('./fixtures/agent.ts', import.meta.url));
const root = () => mkdtempSync(join(tmpdir(), 'rewind-cli-'));

/** Runs the CLI in-process-adjacent and captures both streams. */
const rewind = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('record runs the agent and reports the run id', () => {
  const dir = root();
  const run = rewind(['record', '--dir', dir, '--', process.execPath, AGENT]);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /agent: working/, 'child stdio passes through');
  assert.match(run.stderr, /rewind: recorded 0[0-9A-HJKMNP-TV-Z]{25}/);
});

test('M0 gate: show --json yields a hash per step', () => {
  const dir = root();
  rewind(['record', '--dir', dir, '--', process.execPath, AGENT]);
  const runId = /recorded (\S+)/.exec(rewind(['record', '--dir', dir, '--', process.execPath, AGENT]).stderr)![1]!;

  const shown = rewind(['show', runId, '--dir', dir, '--json']);
  assert.equal(shown.status, 0);
  const trace = JSON.parse(shown.stdout);
  // This is the gate's `jq '.steps[] | {seq,node,kind,req_hash}'`.
  assert.deepEqual(
    trace.steps.map((s: { seq: number; node: string; kind: string; req_hash: string }) => ({ seq: s.seq, node: s.node, kind: s.kind })),
    [{ seq: 0, node: 'plan', kind: 'model' }, { seq: 1, node: 'search', kind: 'tool' }],
  );
  for (const step of trace.steps) assert.match(step.req_hash, /^[0-9a-f]{64}$/);
  assert.equal(trace.run.status, 'complete');
  assert.equal(trace.run.outcome.final_state_hash, 'sha256:fixture');
});

test('show prints a readable table with the tier column', () => {
  const dir = root();
  const runId = /recorded (\S+)/.exec(rewind(['record', '--dir', dir, '--', process.execPath, AGENT]).stderr)![1]!;
  const shown = rewind(['show', runId, '--dir', dir]);
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /complete {2}2 steps {2}7 tokens/);
  assert.match(shown.stdout, /seq {2}node/);
  assert.match(shown.stdout, /recorded/, 'match tier is always shown (I3)');
});

test('the agent exit code is the command result', () => {
  const dir = root();
  const run = rewind(['record', '--dir', dir, '--', process.execPath, AGENT], { FIXTURE_EXIT: '3' });
  assert.equal(run.status, 3);
  assert.match(run.stderr, /rewind: recorded /, 'a failing agent still recorded');
});

test('an unrecorded command is reported, not failed', () => {
  const dir = root();
  const run = rewind(['record', '--dir', dir, '--', process.execPath, '-e', 'console.log("quiet")']);
  assert.equal(run.status, 0);
  assert.match(run.stderr, /no runs recorded/);
});

test('usage errors exit 1', () => {
  assert.equal(rewind(['record']).status, 1, 'nothing to run');
  assert.equal(rewind(['show']).status, 1, 'no run id');
  assert.equal(rewind(['bogus']).status, 1, 'unknown command');
  assert.equal(rewind([]).status, 1, 'no command');
  assert.equal(rewind(['show', 'run_nope', '--dir', root()]).status, 1, 'unknown run');
});

test('an argument with spaces reaches the agent intact', () => {
  const dir = root();
  // A quoted question used to arrive as its last word: cmd.exe split it, because
  // `node` has no extension and so went through a shell. Silent, and it changed
  // what got recorded.
  const question = 'How do you replay a LangGraph agent deterministically?';
  const run = rewind(['record', '--dir', dir, '--', process.execPath, AGENT, question]);
  assert.equal(run.status, 0);
  assert.match(run.stdout, new RegExp(`argv: ${question.replace(/\?/g, '\?')}`), 'the whole sentence, not its last word');
});
