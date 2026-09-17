# @krishnadobhal/rewind-core

The question every replay tool has to answer is *"is this call the same call I recorded?"*
This package is that answer: canonical request hashing, and the schema the rest of
[Rewind](https://github.com/krishnadobhal/Rewind) is written against.

```bash
npm install @krishnadobhal/rewind-core
```

You rarely install this directly — it arrives as a dependency of
[`@krishnadobhal/rewind-sdk-js`](https://www.npmjs.com/package/@krishnadobhal/rewind-sdk-js)
and [`@krishnadobhal/rewind-server`](https://www.npmjs.com/package/@krishnadobhal/rewind-server).
Reach for it when you need the hash itself.

## The hash

```ts
import { reqHash, stateHash, HASH_VERSION } from '@krishnadobhal/rewind-core/hash';

reqHash({
  kind: 'model',
  provider: 'anthropic',
  model_id: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'summarise this' }],
});
// 'faba1bab0b866b412ff8992582fc2a4bc0be5864895e9790dc4e4215fdb3301d'
```

```
sha256( HASH_VERSION ‖ 0x00 ‖ jcs( canonical(request) ) )
```

`canonical` decides *what counts as the identity of a call*; [RFC 8785
JCS](https://www.rfc-editor.org/rfc/rfc8785) then serializes it with stable key order,
number formatting and string escaping. Hand-rolling that last part is where unicode and
number edge cases bite, so it is not hand-rolled.

`reqHash` returns bare hex. `stateHash` runs the same canonicalization over any value and
returns a `sha256:`-prefixed string — that prefix is the only difference, and mixing the
two up is the most common mistake when reading these values back.

## Getting the boundary right

Too strict and every harmless edit looks like a divergence. Too loose and you match a
stale answer to a different question — worse, because it looks like a result.

**In the hash:** provider, model id, normalized messages, system prompt digest, tool
schemas sorted by name with their full JSON Schema, response format, sampling parameters,
tool choice. A changed tool parameter changes behaviour, so it changes identity.

**Excluded:** request ids, idempotency keys, absolute timestamps, latency, trace headers,
user agents, retry counters, SDK versions, provider-side message ids, and **every auth
header and API key**. Excluding secrets is a correctness requirement as much as a security
one — a rotated key must not invalidate a corpus of recordings.

Normalization, in order: Unicode NFC · whitespace collapse (but never re-wrapping, since
indentation inside fenced code blocks changes model behaviour) · volatile ids scrubbed to
ordinals so the same conversation shape hashes identically across runs · base64 media
replaced by the digest of its decoded bytes, so a 4 MB image never enters the hash input ·
`undefined`/`null`/omitted collapsed to omitted, while empty arrays and strings are kept
because they are meaningful.

## HASH_VERSION is a wire format

Currently **3**. Every cassette records the version it was written under, and a reader
refuses to mix versions rather than silently missing on every step.

Any change to canonicalization — however small — needs the version bumped, the goldens
regenerated, and old recordings re-indexed or quarantined. If the goldens did not move,
you did not change what you thought you changed.

## Schema

```ts
import type { Run, Step, Cassette, StepKind, MatchTier } from '@krishnadobhal/rewind-core/schema';
```

Three entities and that is the whole vocabulary. A `Run` has many `Step`s; many steps
point at the same `Cassette`, which is content-addressed by `req_hash` and immutable — a
corrected recording is a new cassette, never an overwrite.

```ts
STEP_KINDS   // 'model' · 'tool' · 'clock' · 'rng' · 'human' · 'env'
MATCH_TIERS  // 'exact' · 'miss' · 'recorded'
```

`recorded` is what a live run writes; `exact` and `miss` are what a replay reports. The
tier is always stored explicitly, never inferred from context.

## Request types

```ts
import type { RewindRequest, ModelRequest, ToolRequest, Message } from '@krishnadobhal/rewind-core/request';
```

A discriminated union on `kind`. Framework-shaped objects are flattened into these before
hashing — LangChain `BaseMessage` classes become `{ role, content }`, and a Zod schema
becomes the JSON Schema `bindTools` produced, with its lazily-filled `_cached` stripped.
Without that last detail the same schema hashes differently before and after its first
validation.

## Also exported

`normalizeText(input)` — the text normalizer, on its own, for testing what a change to it
would do.

`canonical(request)` — the canonical object *before* serialization. Useful when a hash
mismatch needs explaining: diff two canonical forms and the differing field is the answer.

## Requirements

Node 22.6+ (24 recommended) and ESM. Types ship with the package. One runtime dependency,
[`canonicalize`](https://www.npmjs.com/package/canonicalize), for JCS.

## License

Apache-2.0
