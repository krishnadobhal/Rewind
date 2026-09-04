import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { RewindRequest } from './request.ts';

export const HASH_VERSION = 3;

// Random per call, but repetition is meaningful — it pairs a tool call with its result.
const ID_KEYS = new Set([
  'id',
  'message_id',
  'tool_call_id',
  'tool_use_id',
  'call_id',
  'correlation_id',
]);

// Never identity. Auth headers included — a rotated key must not invalidate a corpus.
const DROP_KEYS = new Set([
  'request_id',
  'idempotency_key',
  'timestamp',
  'created',
  'created_at',
  'latency_ms',
  'traceparent',
  'tracestate',
  'trace_id',
  'span_id',
  'user-agent',
  'user_agent',
  'retry_count',
  'sdk_version',
  'x-api-key',
  'api_key',
  'apikey',
  'authorization',
  'stream',
]);

/* length threshold, not a decoder probe. Prose is not valid base64. */
const BASE64_MIN = 1024;
const BASE64_RE = /^[A-Za-z0-9+/\s]+={0,2}$/;
const DATA_URL_RE = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/;

/* Renames volatile ids to call_0, call_1 … by first appearance within one request. */
class Ordinals {
  #seen = new Map<string, string>();
  of(id: string): string {
    let ordinal = this.#seen.get(id);
    if (ordinal === undefined) {
      // Map size is the counter; a repeat hits the get above and never advances it.
      ordinal = `call_${this.#seen.size}`;
      this.#seen.set(id, ordinal);
    }
    return ordinal;
  }
}

function digestBase64(b64: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')}`;
}

/** Every string in the request passes through here. HASHING.md §3, steps 1, 2 and 4. */
export function normalizeText(input: string): string {
  const dataUrl = DATA_URL_RE.exec(input);
  if (dataUrl) return digestBase64(dataUrl[1]!);
  if (input.length >= BASE64_MIN && BASE64_RE.test(input)) return digestBase64(input);

  const nfc = input.normalize('NFC').replace(/\r\n?/g, '\n');
  // Odd indices are fenced blocks; leave them byte-for-byte — indentation changes behaviour.
  const parts = nfc.split(/(```[\s\S]*?(?:```|$))/g);
  const lines = parts
    .map((part, i) => (i % 2 === 1 ? part : collapseHorizontal(part)))
    .join('')
    .split('\n');
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.join('\n');
}

function collapseHorizontal(chunk: string): string {
  return chunk
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').replace(/[^\S\n]+$/, ''))
    .join('\n');
}

/** Rebuilds `value` as a new tree; never mutates the caller's request. */
function normalizeValue(value: unknown, ids: Ordinals): unknown {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v, ids));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      const lower = key.toLowerCase();
      // undefined, null and omitted all collapse to omitted; "" and [] are meaningful.
      if (raw === undefined || raw === null) continue;
      if (DROP_KEYS.has(lower)) continue;
      // 'id' is generic — domain ids get renumbered too, and two distinct ids reaching
      // the same slot in two requests both become call_N and collide.
      if (ID_KEYS.has(lower) && typeof raw === 'string') {
        out[key] = ids.of(raw);
        continue;
      }
      out[key] = normalizeValue(raw, ids);
    }
    return out;
  }
  return value;
}

/** The canonical form of a request: exactly the fields that make up its identity. */
export function canonical(req: RewindRequest): Record<string, unknown> {
  const ids = new Ordinals(); // per request — numbering restarts at call_0 every time
  if (req.kind === 'tool') {
    return { kind: 'tool', tool_name: req.tool_name, args: normalizeValue(req.args, ids) };
  }
  if (req.kind !== 'model') {
    return { kind: req.kind, counter: req.counter };
  }

  const out: Record<string, unknown> = {
    kind: 'model',
    provider: req.provider,
    model_id: req.model_id,
    // Ordinals are assigned in message order, so scrub messages before anything else.
    messages: normalizeValue(req.messages, ids),
  };
  if (req.system_prompt_sha !== undefined) out['system_prompt_sha'] = req.system_prompt_sha;
  if (req.tool_schemas !== undefined) {
    // Sorted: the same tool set declared in a different order is the same call.
    const sorted = [...req.tool_schemas].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    out['tool_schemas'] = normalizeValue(sorted, ids);
  }
  for (const field of ['response_format', 'temperature', 'top_p', 'top_k', 'seed', 'max_tokens', 'tool_choice'] as const) {
    const v = req[field];
    if (v !== undefined && v !== null) out[field] = normalizeValue(v, ids);
  }
  return out;
}

/** req_hash = sha256(HASH_VERSION ‖ "\x00" ‖ jcs(canonical(request))) */
export function reqHash(req: RewindRequest): string {
  const canonicalJson = canonicalize(canonical(req));
  if (canonicalJson === undefined) throw new Error('canonicalize returned undefined — non-JSON value in request');
  return createHash('sha256').update(`${HASH_VERSION}\x00${canonicalJson}`).digest('hex');
}
