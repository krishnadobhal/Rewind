/**
 * Runs in the user's process, before anything is written. There is no read-time path.
 * `redaction_map` holds token → matcher name, never the original value.
 */

import type { RedactConfig, RedactResult } from './types/redact.ts';

export type { RedactConfig, RedactResult } from './types/redact.ts';

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

/**
 * Depth-first over the tree, building a dotted path as it descends. A configured
 * `fields` path wins outright — the whole value goes, whatever shape it is — before
 * any pattern gets a chance to run against it.
 */
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

/** Assemble the matcher list, then walk once. Returns a new tree; the input is untouched. */
export function redact(value: unknown, config: RedactConfig = {}): RedactResult {
  const matchers: [string, RegExp][] = config.preset === 'none' ? [] : [...PRESET];
  (config.custom ?? []).forEach((re, i) => matchers.push([`custom:${i}`, re]));
  const tokens = new Tokens();
  const redacted = walk(value, '', { matchers, fields: new Set(config.fields ?? []), tokens });
  return { value: redacted, map: tokens.map };
}
