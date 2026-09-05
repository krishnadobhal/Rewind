/**
 * Golden hashes. These pin the wire format (I2).
 *
 * If you changed canonicalization and these still pass, you did not change what you
 * thought you changed. Regenerate deliberately with:
 *
 *   UPDATE_GOLDENS=1 node --test packages/core/test/hash.test.ts
 *
 * and review the diff.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { HASH_VERSION, reqHash } from '../src/hash.ts';
import type { RewindRequest } from '../src/types/request.ts';

const FILE = new URL('./hash.golden.json', import.meta.url);
type Golden = { hash_version: number; cases: { name: string; request: RewindRequest; hash?: string }[] };
const golden: Golden = JSON.parse(readFileSync(FILE, 'utf8'));

if (process.env['UPDATE_GOLDENS'] === '1') {
  golden.hash_version = HASH_VERSION;
  for (const c of golden.cases) c.hash = reqHash(c.request);
  writeFileSync(FILE, JSON.stringify(golden, null, 2) + '\n');
}

test('goldens were recorded under the current HASH_VERSION', () => {
  assert.equal(golden.hash_version, HASH_VERSION);
});

for (const c of golden.cases) {
  test(`golden: ${c.name}`, () => {
    assert.ok(c.hash, `${c.name} has no recorded hash — run with UPDATE_GOLDENS=1`);
    assert.equal(reqHash(c.request), c.hash);
  });
}

test('every golden hash is distinct', () => {
  const seen = new Map<string, string>();
  for (const c of golden.cases) {
    const prior = seen.get(c.hash!);
    assert.equal(prior, undefined, `${c.name} collides with ${prior}`);
    seen.set(c.hash!, c.name);
  }
});
