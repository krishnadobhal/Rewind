/**
 * Runs in the user's process, before anything is written. There is no read-time path.
 * `redaction_map` holds token → matcher name, never the original value.
 */

import type { RedactConfig, RedactResult } from './types/redact.ts';

export type { RedactConfig, RedactResult } from './types/redact.ts';

/** A matcher may refuse a match it caught, when the shape alone is not enough. */
type Matcher = [name: string, pattern: RegExp, accept?: (match: string) => boolean];

/** Issuer prefixes: Visa, Mastercard, Amex, Discover, UnionPay, JCB. */
const CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5)|62|35)/;

/**
 * Is this digit run actually a card number?
 *
 * A 13–19 digit run is card-*shaped*; a PRNG seed or an order number is too. Luhn alone
 * lets one in ten through, so the issuer prefix has to agree as well. Over-redacting
 * corrupts data the agent needs while protecting nothing.
 */
function card(digits: string): boolean {
  const only = digits.replace(/\D/g, '');
  if (only.length < 13 || !CARD_PREFIX.test(only)) return false;
  let sum = 0;
  for (let i = 0; i < only.length; i++) {
    // Double every second digit from the right; 10 or more folds to its digit sum.
    let d = Number(only[only.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const PRESET: Matcher[] = [
  // Bounded per RFC 5321 (local part <= 64, each domain label <= 63) for speed, not
  // correctness: an unbounded [\w.+-]+ backtracks across the whole string from every
  // start position, so a long token in the same character class and no @ — base64,
  // a JWT, a data URI — costs O(n^2). 20 KB of base64 took 324ms before, 5.6ms after.
  ['email', /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g],
  ['token', /\b(?:Bearer\s+[\w.\-~+/]+=*|(?:sk|pk|rk)[-_](?:live|test)?[-_]?[A-Za-z0-9]{12,}|xox[baprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})/g],
  ['card', /\b(?:\d[ -]?){13,19}\b/g, card],
  // Numbers are not all +1 555, so this takes grouped digits with an optional country
  // code — covering UK `020 7946 0958` and most of Europe. The boundaries are the load
  // -bearing part: without them it eats the digit groups inside a UUID, which corrupts
  // ids the agent needs while protecting nothing.
  ['phone', /(?<![\w-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]\d{3,4}[ .-]?\d{3,4}(?![\w-])/g],
];

class Tokens {
  readonly map: Record<string, string> = {}; // token → matcher name, no plaintext
  #seen = new Map<string, string>(); // original → token, for repeat values
  #counts = new Map<string, number>(); // per-matcher counter, gives the suffix

  /** Same original → same token, so redacted text keeps its structure. */
  for(original: string, matcher: string): string {
    let token = this.#seen.get(original);
    if (token === undefined) {
      const n = this.#counts.get(matcher) ?? 0;
      this.#counts.set(matcher, n + 1);
      token = `[redacted:${matcher}:${n}]`;
      this.#seen.set(original, token);
      this.map[token] = matcher;
    }
    return token;
  }
}

/** Runs every matcher over one string, in order. */
function redactString(input: string, matchers: Matcher[], tokens: Tokens): string {
  let out = input; // rewritten once per matcher
  for (const [name, pattern, accept] of matchers) {
    // Fresh RegExp per call: a shared /g pattern carries lastIndex between strings.
    out = out.replace(new RegExp(pattern.source, pattern.flags), (m) =>
      // A refused match is left exactly as it was found.
      accept && !accept(m) ? m : tokens.for(m, name),
    );
  }
  return out;
}

/**
 * Depth-first over the tree, building a dotted path as it descends. A configured
 * `fields` path wins outright — the whole value goes, whatever shape it is — before
 * any pattern gets a chance to run against it.
 */
/** Recurses the value, redacting strings and named fields. */
function walk(value: unknown, path: string, ctx: { matchers: Matcher[]; fields: Set<string>; tokens: Tokens }): unknown {
  if (ctx.fields.has(path)) { // whole value goes, whatever type it is
    return value === undefined ? value : ctx.tokens.for(`${path}:${JSON.stringify(value)}`, 'field');
  }
  if (typeof value === 'string') return redactString(value, ctx.matchers, ctx.tokens);
  if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walk(v, path === '' ? k : `${path}.${k}`, ctx);
    }
    return out;
  }
  return value;
}

/** Assemble the matcher list, then walk once. Returns a new tree; the input is untouched. */
/** Redacts a value, returning it with a token map. */
export function redact(value: unknown, config: RedactConfig = {}): RedactResult {
  const matchers: Matcher[] = config.preset === 'none' ? [] : [...PRESET]; // copy, PRESET is shared
  (config.custom ?? []).forEach((re, i) => matchers.push([`custom:${i}`, re]));
  const tokens = new Tokens(); // one map per call, numbering restarts
  const redacted = walk(value, '', { matchers, fields: new Set(config.fields ?? []), tokens });
  return { value: redacted, map: tokens.map };
}
