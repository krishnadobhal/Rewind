import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENV_DIR, ENV_ENABLED, recorderFromEnv, resetRecorder } from '../src/env.ts';
import { withRewind } from '../src/middleware.ts';

/** Points the SDK at a fresh store and clears the memoized run. */
function recording(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-env-'));
  process.env[ENV_ENABLED] = '1';
  process.env[ENV_DIR] = dir;
  resetRecorder(); // each test opens its own run
  return dir;
}

test('one process is one run, however many times withRewind is called', async () => {
  const dir = recording();
  const model = { _llmType: () => 'p', model: 'planner', invoke: async (_input: unknown, _config?: unknown) => ({ content: 'a' }) };
  const router = { _llmType: () => 'p', model: 'router', invoke: async (_input: unknown, _config?: unknown) => ({ content: 'b' }) };

  // A second withRewind must join the run, not start a rival one — split steps
  // would leave two incomplete traces and nothing saying so.
  const a = await withRewind({ model });
  const b = await withRewind({ model: router });
  assert.equal(a.recorder, b.recorder, 'same recorder');
  assert.equal(a.recorder!.run.run_id, b.recorder!.run.run_id, 'one ULID');

  await a.model.invoke([{ role: 'user', content: 'x' }], {});
  await b.model.invoke([{ role: 'user', content: 'y' }], {});
  a.recorder!.finish(null);

  assert.deepEqual(readdirSync(join(dir, 'runs')), [a.recorder!.run.run_id], 'one run on disk');
  assert.equal(a.recorder!.stats.steps, 2, 'both models recorded into it');
});

test('recorderFromEnv and withRewind share the same run', async () => {
  recording();
  const direct = await recorderFromEnv();
  const viaMiddleware = await withRewind({});
  assert.equal(direct, viaMiddleware.recorder, 'the manual path is not a second run');
});

test('an un-recorded process gets null every time', async () => {
  delete process.env[ENV_ENABLED];
  resetRecorder();
  assert.equal(await recorderFromEnv(), null);
  assert.equal((await withRewind({})).recorder, null);
});
