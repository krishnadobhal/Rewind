/**
 * The directory backing of the ingest API — what `pnpm serve` uses with no database.
 *
 * The scan has no index behind it, so the thing worth checking is that it answers the
 * same two questions Postgres does, not that it answers them quickly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '@krishnadobhal/rewind-sdk-js/recorder';
import { fileStore } from '@krishnadobhal/rewind-sdk-js/store';
import { fileIngestStore } from '../src/files.ts';

/** Records one run of identical questions, returning its id. */
function record(root: string): string {
  const recorder = new Recorder({ store: fileStore(root), log: () => {} });
  for (let i = 0; i < 2; i++) {
    recorder.record({
      node: `n${i}`,
      kind: 'model',
      request: { kind: 'model', provider: 'anthropic', model_id: 'claude-opus-5', messages: [{ role: 'user', content: `ask ${i}?` }] },
      response: { content: 'answered' },
      latency_ms: 1,
    });
  }
  recorder.finish({ final_state_hash: 'sha256:files' });
  return recorder.run.run_id;
}

test('findSteps over a directory finds the same call in both runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewind-files-'));
  const first = record(root);
  const second = record(root);
  const store = fileIngestStore(root);

  const trace = await store.readTrace(first);
  const hash = trace!.steps[0]!.req_hash;

  const same = await store.findSteps!({ hash });
  assert.deepEqual(same.map((hit) => hit.run_id).sort(), [first, second].sort());
  assert.ok(same.every((hit) => hit.seq === 0 && hit.node === 'n0' && hit.status === 'complete'));

  // The other axis: the position, whatever it asked that time.
  const byNode = await store.findSteps!({ node: 'n1', kind: 'model' });
  assert.equal(byNode.length, 2);
  // And no filter is not a table scan.
  assert.deepEqual(await store.findSteps!({}), []);
});
