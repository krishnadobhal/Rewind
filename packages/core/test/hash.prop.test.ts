/**
 * Properties of canonicalization: what must NOT change a hash, and what must.
 * docs/HASHING.md §3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reqHash, normalizeText } from '../src/hash.ts';
import type { ModelRequest, RewindRequest } from '../src/types/request.ts';

const base: ModelRequest = {
  kind: 'model',
  provider: 'anthropic',
  model_id: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'summarize the report' }],
  temperature: 0,
  max_tokens: 512,
};

const same = (a: RewindRequest, b: RewindRequest, why: string) =>
  assert.equal(reqHash(a), reqHash(b), why);
const differs = (a: RewindRequest, b: RewindRequest, why: string) =>
  assert.notEqual(reqHash(a), reqHash(b), why);

test('stable under key reordering', () => {
  const reordered = { max_tokens: 512, temperature: 0, messages: base.messages, model_id: base.model_id, provider: base.provider, kind: 'model' } as ModelRequest;
  same(base, reordered, 'JCS must sort keys');
});

test('stable under whitespace perturbation', () => {
  for (const content of [
    'summarize   the report',
    'summarize the report   ',
    '\n\nsummarize the report\n\n',
    'summarize\tthe report',
    'summarize the report\r\n',
  ]) {
    same(base, { ...base, messages: [{ role: 'user', content }] }, `whitespace variant: ${JSON.stringify(content)}`);
  }
});

test('stable under unicode-equivalent input', () => {
  const nfc = 'café';
  const nfd = 'café';
  assert.notEqual(nfc, nfd);
  same(
    { ...base, messages: [{ role: 'user', content: nfc }] },
    { ...base, messages: [{ role: 'user', content: nfd }] },
    'NFC normalization',
  );
});

test('stable under volatile fields', () => {
  const noisy: ModelRequest = {
    ...base,
    messages: [{ role: 'user', content: 'summarize the report', request_id: 'req_9', created_at: '2026-09-04T00:00:00Z', traceparent: '00-abc-def-01' }],
  };
  same(base, noisy, 'volatile fields are excluded from identity');
});

test('stable under a rotated api key', () => {
  const withKey = (k: string): ModelRequest => ({ ...base, messages: [{ role: 'user', content: 'summarize the report', authorization: `Bearer ${k}` }] });
  same(withKey('sk-old'), withKey('sk-new'), 'a rotated key must not invalidate a corpus');
  same(base, withKey('sk-old'), 'auth headers are not identity');
});

test('stable under tool_schema ordering', () => {
  const a: ModelRequest = { ...base, tool_schemas: [{ name: 'alpha' }, { name: 'zulu' }] };
  const b: ModelRequest = { ...base, tool_schemas: [{ name: 'zulu' }, { name: 'alpha' }] };
  same(a, b, 'tool schemas are sorted by name');
});

test('stable under renamed tool-call ids', () => {
  const conv = (id: string): ModelRequest => ({
    ...base,
    messages: [
      { role: 'assistant', content: '', tool_calls: [{ id, name: 'search', args: {} }] },
      { role: 'tool', tool_call_id: id, content: 'result' },
    ],
  });
  same(conv('toolu_01'), conv('toolu_ZZ'), 'ids collapse to ordinals');
});

test('null, undefined and omitted collapse to omitted', () => {
  same(base, { ...base, top_p: undefined }, 'undefined');
  same(base, { ...base, messages: [{ role: 'user', content: 'summarize the report', extra: null }] }, 'null');
});

test('empty string and empty array are meaningful', () => {
  const empty: ModelRequest = { ...base, messages: [{ role: 'assistant', content: '' }] };
  const absent: ModelRequest = { ...base, messages: [{ role: 'assistant', content: undefined }] };
  differs(empty, absent, 'empty content is not absent content');
});

test('identity fields change the hash', () => {
  differs(base, { ...base, model_id: 'claude-haiku-4-5' }, 'model');
  differs(base, { ...base, provider: 'openai' }, 'provider');
  differs(base, { ...base, temperature: 0.7 }, 'temperature');
  differs(base, { ...base, messages: [{ role: 'user', content: 'summarize the memo' }] }, 'content');
  differs(base, { ...base, system_prompt_sha: 'sha256:v3' }, 'prompt');
  differs(base, { ...base, tool_schemas: [{ name: 'search', parameters: { q: 'string' } }] }, 'tool schema');
});

test('indentation inside fenced code blocks survives', () => {
  const code = (indent: string) => `run this:\n\n\`\`\`py\ndef f():\n${indent}return 1\n\`\`\``;
  differs(
    { ...base, messages: [{ role: 'user', content: code('    ') }] },
    { ...base, messages: [{ role: 'user', content: code('  ') }] },
    'code indentation changes model behaviour',
  );
});

test('media is hashed, not embedded', () => {
  const png = Buffer.alloc(4096, 7).toString('base64');
  const out = normalizeText(`data:image/png;base64,${png}`);
  assert.match(out, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(out, normalizeText(`data:image/png;base64,${Buffer.alloc(4096, 8).toString('base64')}`));
});

test('shim boundaries hash their counter, not their value', () => {
  differs({ kind: 'clock', counter: 1 }, { kind: 'clock', counter: 2 }, 'counter is identity');
  differs({ kind: 'clock', counter: 1 }, { kind: 'rng', counter: 1 }, 'kind is identity');
});
