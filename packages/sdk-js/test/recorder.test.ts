import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reqHash } from '@rewind/core/hash';
import type { ModelRequest } from '@rewind/core/request';
import type { Step } from '@rewind/core/schema';
import { Recorder } from '../src/recorder.ts';
import { fileStore, type Store } from '../src/store.ts';

const root = () => mkdtempSync(join(tmpdir(), 'rewind-'));

const request: ModelRequest = {
  kind: 'model',
  provider: 'anthropic',
  model_id: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'email ada@example.com about the invoice' }],
};

const observe = (node: string) => ({
  node,
  kind: 'model' as const,
  request,
  response: { content: 'sent to ada@example.com', usage: { output_tokens: 12 } },
  latency_ms: 340,
  tokens: 12,
  cost_usd: 0.0004,
  provider: 'anthropic',
});

function everyFile(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? everyFile(path) : [path];
  });
}

const steps = (dir: string, runId: string): Step[] =>
  readFileSync(join(dir, 'runs', runId, 'steps.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('a run produces an inspectable trace with a hash per step', () => {
  const dir = root();
  const recorder = new Recorder({ store: fileStore(dir) });
  recorder.record(observe('plan'));
  recorder.record({ ...observe('search'), request: { kind: 'tool', tool_name: 'web_search', args: { q: 'invoice' } }, kind: 'tool' });
  recorder.finish({ final_state_hash: 'sha256:deadbeef' });

  const trace = steps(dir, recorder.run.run_id);
  assert.deepEqual(trace.map((s) => [s.seq, s.node, s.kind]), [[0, 'plan', 'model'], [1, 'search', 'tool']]);
  assert.equal(trace[0]!.req_hash, reqHash(request));
  for (const step of trace) {
    assert.match(step.req_hash, /^[0-9a-f]{64}$/);
    assert.equal(step.cassette_ref, step.req_hash);
    assert.equal(step.match_tier, 'recorded');
  }

  const run = JSON.parse(readFileSync(join(dir, 'runs', recorder.run.run_id, 'run.json'), 'utf8'));
  assert.equal(run.status, 'complete');
  assert.equal(run.tokens, 24);
  assert.equal(run.outcome.final_state_hash, 'sha256:deadbeef');
});

test('cassettes are content-addressed and written once', () => {
  const dir = root();
  const recorder = new Recorder({ store: fileStore(dir) });
  recorder.record(observe('plan'));
  recorder.record(observe('plan-again'));
  recorder.finish(null);

  const files = readdirSync(join(dir, 'cassettes'));
  assert.deepEqual(files, [`${reqHash(request)}.json`], 'the same request is one cassette, not two');
  const cassette = JSON.parse(readFileSync(join(dir, 'cassettes', files[0]!), 'utf8'));
  assert.equal(cassette.hash_version, 3);
  assert.equal(cassette.provider, 'anthropic');
});

test('I4: no plaintext PII reaches the store', () => {
  const dir = root();
  const recorder = new Recorder({ store: fileStore(dir) });
  recorder.record(observe('plan'));
  recorder.finish(null);

  for (const file of everyFile(dir)) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /ada@example\.com/, `PII survived into ${file}`);
  }
  const cassette = JSON.parse(readFileSync(join(dir, 'cassettes', `${reqHash(request)}.json`), 'utf8'));
  assert.deepEqual(Object.values(cassette.redaction_map), ['email']);
});

test('req_hash is over the plaintext, so redaction config does not invalidate a corpus', () => {
  const dir = root();
  const loose = new Recorder({ store: fileStore(dir), redact: { preset: 'none' } });
  loose.record(observe('plan'));
  const strict = new Recorder({ store: fileStore(dir), redact: { custom: [/invoice/g] } });
  strict.record(observe('plan'));
  assert.equal(steps(dir, loose.run.run_id)[0]!.req_hash, steps(dir, strict.run.run_id)[0]!.req_hash);
});

test('I1: a failing store never throws into the graph', () => {
  const logged: string[] = [];
  const broken: Store = {
    putRun() { throw new Error('disk full'); },
    appendStep() { throw new Error('disk full'); },
    putCassette() { throw new Error('disk full'); },
  };
  const recorder = new Recorder({ store: broken, log: (m) => logged.push(m) });

  assert.doesNotThrow(() => {
    recorder.record(observe('plan'));
    recorder.record(observe('search'));
    recorder.finish({ final_state_hash: 'sha256:deadbeef' });
  });
  assert.equal(recorder.stats.dropped, 4, 'putRun + two records + finish');
  assert.equal(recorder.stats.steps, 0);
  assert.equal(logged.length, 1, 'logged once, not once per drop');
});

test('a dropped event marks the run partial, and the caller cannot override it', () => {
  let fail = true;
  const flaky: Store = {
    putRun() {},
    appendStep() {},
    putCassette() { if (fail) { fail = false; throw new Error('transient'); } },
  };
  const recorder = new Recorder({ store: flaky, log: () => {} });
  recorder.record(observe('plan'));
  recorder.record(observe('search'));
  recorder.finish(null, 'complete');
  assert.equal(recorder.run.status, 'partial');
  assert.equal(recorder.stats.steps, 1);
});
