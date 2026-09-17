/**
 * I4's gate: no PII survives a record → store round trip.
 *
 *   pnpm test:redaction
 *
 * Required before `bench/corpus/` is committed or updated. A cassette holds whatever
 * the agent saw, and the corpus is public — an unredacted byte that reaches the store
 * is already a breach, and committing one makes it permanent.
 *
 * These patterns are deliberately broader than the redactor's own. The redactor's unit
 * tests check that its matchers work; this checks whether they were enough.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { HumanMessage } from '@langchain/core/messages';
import { Recorder } from '@krishnadobhal/rewind-sdk-js/recorder';
import { fileStore } from '@krishnadobhal/rewind-sdk-js/store';
import { buildGraph, script, webSearch } from 'deep-research-agent/graph';
import { ScriptedChatModel } from 'deep-research-agent/model';
import { join } from 'node:path';

const ROOT = 'bench/corpus';

/** Issuer prefix + Luhn, so a long id is not reported as a card. Mirrors the redactor. */
function luhn(digits: string): boolean {
  const only = digits.replace(/\D/g, '');
  // Luhn alone passes one random digit-run in ten; the prefix has to agree too.
  if (!/^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5)|62|35)/.test(only)) return false;
  let sum = 0;
  for (let i = 0; i < only.length; i++) {
    let d = Number(only[only.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return only.length >= 13 && sum % 10 === 0;
}

/** What must never appear in a stored byte, whatever the redactor thinks. */
const FORBIDDEN: [name: string, pattern: RegExp, accept?: (m: string) => boolean][] = [
  ['email', /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ['card', /\b(?:\d[ -]?){13,19}\b/, luhn],
  ['us phone', /(?:\+\d{1,3}[ -]?)?(?:\(\d{3}\)|\d{3})[ -]\d{3}[ -]\d{4}\b/],
  ['uk phone', /\b0\d{2,4}[ -]\d{3,4}[ -]?\d{4}\b/],
  ['bearer token', /\bBearer\s+[\w.\-~+/]+=*/],
  ['provider key', /\b(?:sk|pk|rk)[-_](?:live|test)?[-_]?[A-Za-z0-9]{12,}/],
  ['aws key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/],
];

/** Every file in the corpus, recursively. */
function everyFile(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? everyFile(path) : [path];
  });
}

const files = everyFile(ROOT);

test('the corpus has something to check', () => {
  // A pass over an empty directory is not a pass.
  assert.ok(files.length > 20, `only ${files.length} files under ${ROOT}`);
  assert.ok(files.some((f) => f.includes('cassettes')), 'no cassettes in the corpus');
});

for (const [name, pattern, accept] of FORBIDDEN) {
  test(`no ${name} survives into the corpus`, () => {
    const leaks: string[] = [];
    for (const file of files) {
      // Every occurrence, not just the first: one refused match must not hide a real
      // one later in the same file.
      for (const found of readFileSync(file, 'utf8').matchAll(new RegExp(pattern.source, 'g'))) {
        if (accept && !accept(found[0])) continue;
        // Name the file and the match, so a failure is actionable rather than a puzzle.
        leaks.push(`${file}: ${found[0].slice(0, 40)}`);
      }
    }
    assert.deepEqual(leaks, [], `${name} reached the store`);
  });
}

test('the corpus needed no redaction — it is publishable by construction', () => {
  const redacted = files
    .filter((f) => f.includes('cassettes'))
    .map((f) => [f, (JSON.parse(readFileSync(f, 'utf8')) as { redaction_map: Record<string, string> }).redaction_map] as const)
    .filter(([, map]) => Object.keys(map).length > 0);

  // A committed corpus has to store its inputs in plaintext to stay replayable, so
  // those inputs must be safe to publish in the first place. A redaction here means
  // something unpublishable got in — the redactor caught it in the cassette, but the
  // manifest holds the same text unredacted and would carry it into git.
  assert.deepEqual(
    redacted.map(([f, map]) => `${f}: ${Object.values(map).join(',')}`),
    [],
    'a corpus question carried something that needed redacting',
  );
  console.log(`corpus: ${files.length} files, 0 redactions needed`);
});

test('a redaction map never contains the original value', () => {
  for (const file of files.filter((f) => f.includes('cassettes'))) {
    const { redaction_map } = JSON.parse(readFileSync(file, 'utf8')) as { redaction_map: Record<string, string> };
    for (const [token, kind] of Object.entries(redaction_map)) {
      // token → matcher name. Storing the original would rebuild the breach the map
      // exists to record, and it would sit in git forever.
      assert.match(token, /^\[redacted:[a-z:0-9]+\]$/, `unexpected token shape: ${token}`);
      assert.match(kind, /^[a-z]+(:\d+)?$/, `map value looks like data, not a matcher: ${kind}`);
    }
  }
});

test('a record → store round trip leaks nothing, on real PII', async () => {
  // The corpus is PII-free by construction, so it cannot prove the redactor works.
  // This records genuine PII shapes into a throwaway store and checks every byte.
  const dir = mkdtempSync(join(tmpdir(), 'rewind-redaction-'));
  const recorder = new Recorder({ store: fileStore(dir), log: () => {} });
  const { graph } = await buildGraph({
    model: new ScriptedChatModel({ responses: script(), model: 'scripted-planner-1' }),
    tools: [webSearch],
    recorder,
  });
  const secrets = [
    'ada@example.com',
    '+1 415-555-0134',
    '020 7946 0958',
    '4111 1111 1111 1111',
    'sk-live_abcdefghijklmnop',
    'Bearer abc.def.ghi',
    'AKIAIOSFODNN7EXAMPLE',
  ];
  await graph.invoke({ messages: [new HumanMessage(`Reach me at ${secrets.join(' or ')} about step 7?`)] });
  recorder.finish({ final_state_hash: 'sha256:redaction' });

  for (const file of everyFile(dir)) {
    const body = readFileSync(file, 'utf8');
    for (const secret of secrets) {
      assert.ok(!body.includes(secret), `${secret} survived into ${file}`);
    }
  }
});

test('a long id is not mistaken for a card number', () => {
  // Every run.json carries a 15-digit PRNG seed. Redacting those would corrupt data
  // the agent needs while adding no privacy, so the card matcher checks Luhn.
  const seeds = files
    .filter((f) => f.endsWith('run.json'))
    .map((f) => (JSON.parse(readFileSync(f, 'utf8')) as { seed: unknown }).seed);
  assert.ok(seeds.length > 0);
  for (const seed of seeds) assert.equal(typeof seed, 'number', 'a seed was redacted into a token');
});
