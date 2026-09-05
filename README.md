<div align="center">

# ⏪ Rewind

**Deterministic record & replay for LangGraph agents.**

</div>

> **Status: M0, in progress.** Recording works. Replay does not exist yet.
> This README covers what is actually built and runnable today — see
> [READMEMAIN.md](READMEMAIN.md) for where the project is going.

---

## What works today

You can record an agent's calls to a local cassette store and inspect the trace.

| | |
|---|---|
| ✅ Event schema | `Run`, `Step`, `Cassette` — the vocabulary in [docs/DATA_MODEL.md](docs/DATA_MODEL.md) |
| ✅ Canonical request hashing | Decides whether two calls are *the same call*. `HASH_VERSION 3` |
| ✅ Recorder | Emits a Step + a content-addressed Cassette per boundary crossing, and never throws into your graph |
| ✅ Write-time redaction | Emails, phones, cards, bearer tokens — stripped before anything is written |
| ✅ File cassette store | A directory. No Postgres, no S3, no ingest API yet |
| ❌ Replay, fork, sweep, bisect | Not built |
| ❌ CLI (`rewind record`), server, UI | Not built |
| ❌ LangGraph middleware | Not built — the recorder is called directly for now |

## The idea

Recordings are keyed by **a hash of the request**, not by the order calls happened in.

```
"Who won the 2025 Turing Award?"   →   1d09c6df98dcce15…   →   cassettes/1d09….json
```

Ask the same question again and you land on the same file. Ask a different one and there
is no file — which is the point: on a replay a changed call *cannot* be silently answered
with a stale recording.

The hash is deliberately forgiving about things that aren't part of the question, and
strict about everything else:

| Same hash | Different hash |
|---|---|
| extra whitespace, reflowed prompt | different model or provider |
| rotated API key, new `request_id` | changed message content |
| renamed tool-call ids | changed tool schema or sampling params |
| unicode written a different way | changed system prompt |

That trade-off is the whole design. Too strict and every fork misses; too loose and you
replay a stale answer to a different question. The rules live in
[docs/HASHING.md](docs/HASHING.md), and every one of them is pinned by a test.

## Try it

```ts
import { Recorder } from '@rewind/sdk-js/recorder';
import { fileStore } from '@rewind/sdk-js/store';

const recorder = new Recorder({ store: fileStore('.rewind') });

recorder.record({
  node: 'planner',
  kind: 'model',
  request: {
    kind: 'model',
    provider: 'anthropic',
    model_id: 'claude-opus-5',
    messages: [{ role: 'user', content: 'email ada@example.com about the invoice' }],
  },
  response: { content: 'I should look up the invoice first.' },
  latency_ms: 340,
  tokens: 128,
  cost_usd: 0.0019,
  provider: 'anthropic',
});

recorder.finish({ final_state_hash: 'sha256:deadbeef' });
```

Writes:

```
.rewind/
  runs/01M1R6N7J97KS52A9NDM7YCGHJ/run.json      summary, seed, totals, status
  runs/01M1R6N7J97KS52A9NDM7YCGHJ/steps.jsonl   one line per boundary crossing
  cassettes/630d1d52a167c725….json              the recorded request + response
```

`steps.jsonl` — the run's shape. Small, append-only, one line per step:

```json
{"run_id":"01M1R6N7…","seq":0,"node":"planner","kind":"model",
 "req_hash":"630d1d52a167c725…","cassette_ref":"630d1d52a167c725…",
 "match_tier":"recorded","latency_ms":340,"tokens":128,"cost_usd":0.0019,"error":null}
```

The cassette — the bytes, named by the hash, **written once**. Note the email:

```json
{"hash":"630d1d52a167c725…","hash_version":3,"kind":"model",
 "request":"{…\"content\":\"email [redacted:email:0] about the invoice\"}",
 "redaction_map":{"[redacted:email:0]":"email"}, …}
```

The map records *that* an email was there, never which one. Redaction is one-way by
design: a cassette store holds whatever your agent saw, so it is treated as a production
data store, not as test fixtures.

## Packages

```
packages/core/     Schema + canonicalization + hashing. No I/O, no network, no filesystem.
packages/sdk-js/   Recorder, redactor, cassette store, ULIDs.
```

`sdk-js` depends on `core`. Nothing depends on `sdk-js` — it is the only code that runs
inside your process, which is why the dependency arrow only points one way.

| Module | Does |
|---|---|
| `core/hash.ts` | Canonical form + `req_hash`. **A wire format** — changing it invalidates every recording |
| `core/schema.ts` | `Run`, `Step`, `Cassette`, `StepKind`, `MatchTier` |
| `sdk-js/recorder.ts` | Hash → redact → write cassette → append step → roll up totals |
| `sdk-js/redact.ts` | Regex matchers, stable tokens, map of token → matcher name |
| `sdk-js/store.ts` | `Store` interface + a filesystem implementation |
| `sdk-js/ulid.ts` | Time-sortable run ids |

## Two behaviours worth knowing

**The recorder fails open.** It runs inside your production agent, so a full disk or a
serialization bug is caught, counted, and logged at most once a minute — your graph keeps
running. The run is then marked `partial`, and a partial run is never a replay source. The
caller cannot override that.

**Cassettes are immutable.** `putCassette` skips a hash that already exists. A corrected
recording is a *new* cassette, never an overwrite — content addressing makes mutation a
contradiction.

## Develop

```bash
pnpm install
pnpm build
pnpm test        # 40 tests
```

The tests are load-bearing here rather than decorative: this project's failure mode is
silent. If canonicalization drifts, everything still runs and still writes files — it just
stops finding the right recordings. `core/test/hash.golden.json` pins ~12 requests to
exact hashes so drift fails loudly, and it fails equally loudly when you *meant* to change
canonicalization and didn't.

Never change canonicalization without bumping `HASH_VERSION` and regenerating the goldens:

```bash
UPDATE_GOLDENS=1 node --test packages/core/test/hash.test.ts   # then review the diff
```

## Next

[M1](docs/ROADMAP.md): `ReplayModel`, virtual clock, seeded RNG, deterministic scheduler —
replay a recorded run to an identical final-state hash with the network blocked. That
milestone is the one that proves the thesis.

Read [AGENTS.md](AGENTS.md) §3 before contributing.

## License

Apache-2.0
