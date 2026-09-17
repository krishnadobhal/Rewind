# @krishnadobhal/rewind-sdk-js

Record every boundary a LangGraph agent crosses — each model call, each tool call, the
exact request and the exact response — so you can read back what actually happened
instead of guessing from logs.

```bash
npm install @krishnadobhal/rewind-sdk-js
```

## Why

An agent that goes wrong leaves you a transcript and a bill. What you need is the
*request* — the fully-resolved prompt after every template, tool schema and message
rewrite — and there is no log line that contains it. Rewind sits at the boundary, hashes
the request canonically, and stores both halves of the exchange.

## Quick start

```ts
import { withRewind } from '@krishnadobhal/rewind-sdk-js/middleware';

const rw = await withRewind({ model, tools });

// Hand the instrumented pair to your graph. Nothing else changes.
const graph = buildGraph({ model: rw.model, tools: rw.tools });
```

Then switch it on from the environment:

```bash
REWIND_ENABLED=1 node agent.js
cat .rewind/runs/*/steps.jsonl | jq '{seq,node,kind,req_hash}'
```

**With no variable set, `withRewind` hands back your original model and tools**, unwrapped.
An uninstrumented run costs nothing and takes no branches, so this is safe to leave in
production code.

## The environment is the interface

There is no CLI. Configuration is the variables the SDK reads inside your process, because
redaction has to happen *before* anything leaves it — a wrapper watching from outside only
sees bytes on a socket, by which point the PII is already gone.

| | |
|---|---|
| `REWIND_ENABLED=1` | record this run |
| `REWIND_DIR` | where recordings go (default `.rewind`) |
| `REWIND_SERVER` | send writes to an ingest server instead of a directory |
| `REWIND_TOKEN` | bearer token for that server |
| `REWIND_CONFIG` | path to a `rewind.config.ts` |
| `REWIND_ENV_FILE` | a `.env` to load, or `0` to skip it |

A `.env` in the working directory is loaded automatically, *before* `REWIND_ENABLED` is
checked — so a value in the file can switch recording on without touching your shell.

## What gets recorded

Every crossing becomes a `Step` plus a content-addressed `Cassette`:

```jsonc
{
  "seq": 0,
  "node": "plan",            // the LangGraph node it happened in
  "kind": "model",           // model · tool · clock · rng · human · env
  "req_hash": "9c28dd0e…",   // sha256 over the canonical request
  "match_tier": "recorded",
  "latency_ms": 420,
  "tokens": 900,
  "cost_usd": 0.004
}
```

The hash is what makes a call *identifiable*. Two runs that asked the same thing share one
cassette, so 500 runs behind the same system prompt store it once. Canonicalization is
[RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785) plus normalization that scrubs
volatile ids to ordinals — which is why two recordings of the same question hash
identically even though LangChain stamps a fresh UUID on every message.

## Redaction happens at write time

```ts
// rewind.config.ts
import { defineConfig } from '@krishnadobhal/rewind-sdk-js/config';

export default defineConfig({
  dir: '.rewind',
  redact: {
    preset: 'default',              // emails, phones, cards, keys, JWTs
    fields: ['ssn', 'dateOfBirth'], // by key name, at any depth
    custom: [/ACC-\d{8}/g],
  },
});
```

A cassette is written already redacted. There is no unredacted copy on disk to leak,
because the plaintext never reaches the store — only the hash is computed over it, so
recordings stay matchable without holding the sensitive value.

The redactor is also callable directly:

```ts
import { redact } from '@krishnadobhal/rewind-sdk-js/redact';

const { value, map } = redact({ to: 'a@b.com', note: 'call 555-123-4567' }, { preset: 'default' });

// value  { to: '[redacted:email:0]', note: 'call [redacted:phone:0]' }
// map    { '[redacted:email:0]': 'email', '[redacted:phone:0]': 'phone' }
```

## Recording somewhere other than a disk

```bash
REWIND_ENABLED=1 REWIND_SERVER=http://localhost:4000 node agent.js
```

The SDK swaps its directory store for a batching HTTP client and your graph is none the
wiser. `Recorder.record()` runs inside your nodes, where it may neither block nor be
awaited, so writes go through a bounded queue with a background flush:

```ts
import { bufferedStore } from '@krishnadobhal/rewind-sdk-js/emitter';
import { httpStore } from '@krishnadobhal/rewind-sdk-js/http';

const store = bufferedStore({ target: httpStore({ url, token }), maxQueue: 1000 });
```

See [`@krishnadobhal/rewind-server`](https://www.npmjs.com/package/@krishnadobhal/rewind-server)
for the other end, and [`@krishnadobhal/rewind-ui`](https://www.npmjs.com/package/@krishnadobhal/rewind-ui)
for the viewer.

## It fails open, on purpose

A full disk, an unreachable server, a serialization bug — each is counted and logged, not
thrown. Your agent keeps running and the run is marked `partial`. Observability must never
take down the thing it observes, and a recorder that can crash your agent is worse than no
recorder.

A `partial` run is honestly labelled rather than quietly trusted: it dropped events, so
nothing may treat it as a complete account of what happened.

## Reading recordings back

```ts
import { readTrace, listRuns, readCassette } from '@krishnadobhal/rewind-sdk-js/store';

for (const id of listRuns('.rewind')) {
  const { run, steps } = readTrace('.rewind', id)!;
  console.log(id, run.status, steps.length);
}
```

## Exports

| | |
|---|---|
| `/middleware` | `withRewind` — the one function most code needs |
| `/recorder` | `Recorder` for driving it yourself |
| `/redact` | `redact()` and its config types |
| `/store` | `fileStore`, `readTrace`, `listRuns`, `readCassette` |
| `/emitter` | `bufferedStore` — the bounded queue |
| `/http` | `httpStore` — the ingest client |
| `/config` | `defineConfig`, `DEFAULT_DIR` |
| `/env` | the variable names, `loadEnvFile`, `recorderFromEnv` |

## Requirements

Node 22.6+ (24 recommended) and ESM. TypeScript types ship with the package.

## Scope

Recording is what this does. **Replay — re-running a recorded run against its cassettes
with the network blocked — is not in this release**; it is parked on the `replay-engine`
branch pending a way to replay a run that lives on a server rather than on local disk.

No clock or RNG shims yet either, so an agent that reads the wall clock or a random source
has a boundary Rewind does not see.

## License

Apache-2.0
