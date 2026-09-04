import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.ts';

test('default preset catches the documented shapes', () => {
  const { value, map } = redact({
    body: 'mail ada@example.com or call +1 415-555-0134',
    auth: 'Bearer sk_live_abcdefghijklmnop',
    card: 'paid with 4111 1111 1111 1111',
  });
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /ada@example\.com/);
  assert.doesNotMatch(json, /415-555-0134/);
  assert.doesNotMatch(json, /4111 1111 1111 1111/);
  assert.doesNotMatch(json, /sk_live_abcdefghijklmnop/);
  assert.deepEqual(new Set(Object.values(map)), new Set(['email', 'phone', 'card', 'token']));
});

test('the redaction map never contains the original value', () => {
  const secret = 'ada@example.com';
  const { map } = redact({ note: `contact ${secret}` });
  assert.doesNotMatch(JSON.stringify(map), /ada|example\.com/);
  assert.deepEqual(Object.values(map), ['email']);
});

test('the same value gets the same token, so structure survives', () => {
  const { value } = redact({
    a: 'ada@example.com',
    b: 'ada@example.com',
    c: 'grace@example.com',
  }) as { value: Record<string, string> };
  assert.equal(value.a, value.b);
  assert.notEqual(value.a, value.c);
});

test('field paths redact the whole value', () => {
  const { value, map } = redact(
    { headers: { authorization: 'Basic YWxhZGRpbjpvcGVuc2VzYW1l' }, args: { apiKey: 'plaintext' } },
    { fields: ['headers.authorization', 'args.apiKey'] },
  );
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /YWxhZGRpbg|plaintext/);
  assert.deepEqual(Object.values(map), ['field', 'field']);
});

test('custom matchers are additive', () => {
  const { value } = redact({ id: 'acct_a1b2c3d4e5f6g7h8' }, { custom: [/acct_[a-z0-9]{16}/gi] });
  assert.doesNotMatch(JSON.stringify(value), /a1b2c3/);
});

test('nested arrays and objects are walked', () => {
  const { value } = redact({ msgs: [{ content: ['hi ada@example.com'] }] });
  assert.doesNotMatch(JSON.stringify(value), /ada@example\.com/);
});

test('preset none disables the built-ins', () => {
  const { value, map } = redact({ note: 'ada@example.com' }, { preset: 'none' });
  assert.deepEqual(value, { note: 'ada@example.com' });
  assert.deepEqual(map, {});
});
