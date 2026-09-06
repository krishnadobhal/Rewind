<div align="center">

# ⏪ Rewind

**Deterministic record & replay for LangGraph agents.**

</div>

> **Status: M0 done, M1 next.** Recording works end to end — you can run an agent under
> `rewind record` and read the trace back. Replay does not exist yet.

---

## The problem

You changed a prompt. What did it do to the four hundred conversations that already
happened?

LangGraph can rewind agent **state** — its time-travel API resumes from any
`checkpoint_id` — but replaying a checkpoint re-executes the nodes. The LLM call fires
again, the HTTP request goes out again, and both may answer differently. So you can
*debug* a past run; you cannot *test* one.

Rewind is the missing half: record every point where non-determinism enters the graph,
then re-execute against those recordings instead of against the world.

## What works today

```bash
rewind record --dir .rewind -- node your-agent.js
rewind show <run_id>
rewind show <run_id> --json
```

```
$ rewind record --dir .rewind -- node agent.js
rewind: recorded 01M1V6GF92DAPRSX6N0AFF68P7

$ rewind show 01M1V6GF92DAPRSX6N0AFF68P7
01M1V6GF92DAPRSX6N0AFF68P7  complete  2 steps  7 tokens  $0.0000  42ms

  seq  node                 kind    tier      req_hash          latency
    0  plan                 model   recorded  4f862f65e4d389b6      12ms
    1  search               tool    recorded  f73ac9e536935131      30ms
```

| | |
|---|---|
| ✅ `rewind record` | Runs your agent with recording switched on |
| ✅ `rewind show` | Prints a trace as a table or as `{run, steps}` JSON |
| ✅ Canonical request hashing | Decides whether two calls are *the same call*. `HASH_VERSION 3` |
| ✅ Recorder | A Step + a content-addressed Cassette per boundary crossing, and it never throws into your graph |
| ✅ Write-time redaction | Emails, phones, cards, bearer tokens — stripped before anything is written |
| ✅ File cassette store | A directory. No Postgres, no S3, no ingest API |
| ❌ Replay, fork, sweep, bisect | Not built |
| ❌ LangGraph middleware | Not built — your agent calls the SDK directly for now |
| ❌ Server, UI, Python SDK | Not built |

## Wiring it into an agent

`rewind record` does not intercept anything. It can't — redaction and hashing have to
happen *inside* your process, because a wrapper watching from outside only sees bytes on
a socket, and by then the PII has already left the building.

So `record` sets three environment variables and gets out of the way. Your agent picks
them up:

```ts
import { recorderFromEnv } from '@rewind/sdk-js/env';

const recorder = await recorderFromEnv();   // null unless REWIND_ENABLED=1

recorder?.record({
  node: 'planner',
  kind: 'model',
  request: { kind: 'model', provider: 'anthropic', model_id: 'claude-opus-5', messages },
  response,
  latency_ms: 340,
  tokens: 128,
  cost_usd: 0.0019,
});

recorder?.finish({ final_state_hash });
```

Outside a `rewind record` wrapper `recorderFromEnv()` returns `null`, so `recorder?.…`
costs nothing and the same code ships to production unchanged.

Configuration is one file, `rewind.config.ts`, overridden by CLI flags:

```ts
import { defineConfig } from '@rewind/sdk-js/config';

export default defineConfig({
  dir: '.rewind',
  redact: { preset: 'default', fields: ['headers.authorization'] },
});
```

## How recordings are keyed

Recordings are named by **a hash of the request**, not by the order calls happened in.

```
"Who won the 2025 Turing Award?"   →   1d09c6df98dcce15…   →   cassettes/1d09….json
```

Ask the same question again and you land on the same file. Ask a different one and there
is no file — which is the point: on a replay, a changed call *cannot* be quietly answered
with a stale recording. Key by position instead ("the 3rd call") and the moment a change
alters how many calls happen, you hand back the wrong answer and never notice.

The hash is deliberately forgiving about what isn't part of the question, and strict about
everything else:

| Same hash | Different hash |
|---|---|
| extra whitespace, reflowed prompt | different model or provider |
| rotated API key, new `request_id` | changed message content |
| renamed tool-call ids | changed tool schema or sampling params |
| unicode written a different way | changed system prompt |

Too strict and every fork misses; too loose and you replay a stale answer to a different
question — which is worse, because it looks like a result. Every rule in that table is
pinned by a test.

## On disk

```
.rewind/
  runs/01M1V6GF92DAPRSX6N0AFF68P7/run.json      summary, seed, totals, status
  runs/01M1V6GF92DAPRSX6N0AFF68P7/steps.jsonl   one line per boundary crossing
  cassettes/4f862f65e4d389b6….json              the recorded request + response
```

Steps are per-run, small, append-only. Cassettes are shared — 500 runs behind the same
system prompt store it once — content-addressed, and **written once**. A corrected
recording is a new cassette, never an overwrite.

Redaction happens on the way in, and the map records *that* an email was there, never
which one:

```json
"request": "{…\"content\":\"email [redacted:email:0] about the invoice\"}",
"redaction_map": { "[redacted:email:0]": "email" }
```

There is no read-time redaction path, and there must never be one. A cassette store holds
whatever your agent saw, so treat it as a production data store, not as test fixtures.

## Packages

```
packages/core/     Schema, canonicalization, hashing. No I/O, no network, no filesystem.
packages/sdk-js/   Recorder, redactor, cassette store, config, env handshake, ULIDs.
packages/cli/      rewind record | show
```

Dependencies point one way, into `core`. Nothing imports upward. `sdk-js` is the only code
that runs inside your process, which is why it stays small and why the store sits behind a
three-method interface — swap `fileStore` for a real backend and nothing upstream changes.

## Two behaviours worth knowing

**The recorder fails open.** It runs inside your production agent, so a full disk or a
serialization bug is caught, counted, and logged at most once a minute — your graph keeps
running. The run is then marked `partial`, and a partial run is never a replay source. The
caller cannot override that.

**Match tier is always reported.** Every step carries the tier it resolved at, and `show`
always prints the column. A run that resolved 96% exact is evidence; one that resolved 40%
by fuzzy match is a hypothesis. The code must never let those two look alike.

## Develop

```bash
pnpm install
pnpm build
pnpm test        # 46 tests
```

The tests are load-bearing here rather than decorative, because this project's failure
mode is silent: if canonicalization drifts, everything still runs and still writes files —
it just stops finding the right recordings. `core/test/hash.golden.json` pins ~12 requests
to exact hashes so drift fails loudly, and it fails equally loudly when you *meant* to
change canonicalization and didn't.

Never change canonicalization without bumping `HASH_VERSION` and regenerating the goldens:

```bash
UPDATE_GOLDENS=1 node --test packages/core/test/hash.test.ts   # then review the diff
```

## Next

**M1** — `ReplayModel`, `ReplayToolNode`, virtual clock, seeded RNG, deterministic
scheduler. `rewind replay <run_id>` reproduces a run's final-state hash with the network
blocked. That milestone is the one that proves the thesis; everything after it is leverage.

## License

Apache-2.0
