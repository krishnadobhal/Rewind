import { randomBytes } from 'node:crypto';

/** Crockford base32 — no I, L, O or U, so ids survive being read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID: 48-bit millisecond timestamp + 80 bits of randomness, base32.
 * Lexicographic order is creation order, which is why DATA_MODEL.md picks it over UUIDv4.
 */
export function ulid(now = Date.now()): string {
  let time = '';
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  // 256 / 32 is exact, so a uniform byte gives a uniform symbol.
  let rand = '';
  for (const byte of randomBytes(16)) rand += ALPHABET[byte % 32];
  return time + rand;
}
