/**
 * Redaction runs here, in the user's process, before an event is written (I4).
 * There is no read-time redaction path and there must never be one — an unredacted
 * byte that reaches the store is already a breach.
 *
 * The `redaction_map` stored with a cassette maps token → matcher name. It never
 * contains the original value; a map that did would re-create the breach it exists
 * to record.
 */

export type RedactConfig = {
  /** `default` covers emails, phones, card-shaped digits and bearer tokens. */
  preset?: 'default' | 'none';
  custom?: RegExp[];
  /** Dotted paths whose whole value is replaced, e.g. `headers.authorization`. */
  fields?: string[];
};

export type RedactResult = { value: unknown; map: Record<string, string> };

/**
 * ponytail: regex matchers, not a PII classifier. Cheap, deterministic, and wrong at
 * the margins — an ML detector is the upgrade path if the redaction suite (M7) finds
 * real leaks these miss. Order matters: cards before phones, or the phone matcher
 * eats card numbers first.
 */
const PRESET: [name: string, pattern: RegExp][] = [
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['token', /\b(?:Bearer\s+[\w.\-~+/]+=*|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[\w-]{10,})/g],
  ['card', /\b(?:\d[ -]?){13,19}\b/g],
  ['phone', /(?:\+\d{1,3}[ -]?)?(?:\(\d{3}\)|\d{3})[ -]\d{3}[ -]\d{4}\b/g],
];

class Tokens {
  readonly map: Record<string, string> = {};
  #seen = new Map<string, string>();
  #counts = new Map<string, number>();

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

function redactString(input: string, matchers: [string, RegExp][], tokens: Tokens): string {
  let out = input;
  for (const [name, pattern] of matchers) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), (m) => tokens.for(m, name));
  }
  return out;
}

function walk(value: unknown, path: string, ctx: { matchers: [string, RegExp][]; fields: Set<string>; tokens: Tokens }): unknown {
  if (ctx.fields.has(path)) {
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

export function redact(value: unknown, config: RedactConfig = {}): RedactResult {
  const matchers: [string, RegExp][] = config.preset === 'none' ? [] : [...PRESET];
  (config.custom ?? []).forEach((re, i) => matchers.push([`custom:${i}`, re]));
  const tokens = new Tokens();
  const redacted = walk(value, '', { matchers, fields: new Set(config.fields ?? []), tokens });
  return { value: redacted, map: tokens.map };
}
