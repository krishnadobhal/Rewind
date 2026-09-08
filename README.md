<div align="center">

# ⏪ Rewind

**Deterministic record & replay for LangGraph agents.**

</div>

> **Status: record and replay both work.** An agent recorded under `rewind record`
> replays from its cassettes with the model never called, reproducing the same final
> state. Fork, sweep and bisect do not exist yet.

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
rewind replay <run_id> -- node your-agent.js
```

```
$ rewind replay 01M1Y7SNTZ0T2FQHAT9752AQ39 -- node agent.js
# replay of 01M1Y7SNTZ0T2FQHAT9752AQ39: match · exact 4
```

Four steps, every one answered from a cassette, and the final state hash identical to
the recording. The model was never called — the test that proves it swaps in a model
that throws if anything invokes it.

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
| ✅ `withRewind` | Wraps any number of LangGraph models and tools; every call becomes a step |
| ✅ Reference agent | `examples/deep-research-agent` — a real graph, runnable with no API key |
| ✅ `rewind replay` | Re-runs the agent answering from cassettes. `--on-miss=strict` by default |
| ✅ Match tiers | `exact` or `miss`, always counted and reported. `structural` lands with fork |
| ❌ Fork, sweep, bisect | Not built |
| ❌ Trace browser | Not built — a web viewer to browse recorded runs and step through them, the way you'd read a trace in LangSmith |
| ❌ Server, Python SDK | Not built |

## Wiring it into an agent

`rewind record` does not intercept anything. It can't — redaction and hashing have to
happen *inside* your process, because a wrapper watching from outside only sees bytes on
a socket, and by then the PII has already left the building.

So `record` sets three environment variables and gets out of the way. Instrument where
you build the graph — that is the one place holding every model and tool at once:

```ts
import { withRewind } from '@rewind/sdk-js/middleware';

export async function buildGraph({ model, tools, router }) {
  const rw = await withRewind({ model, tools });     // both wrapped
  const routerModel = rw.wrap(router);               // any number of extra models

  const graph = new StateGraph(MessagesAnnotation)
    .addNode('plan', speak(rw.model.bindTools(rw.tools)))
    .addNode('tools', new ToolNode(rw.tools))
    // …
    .compile();

  return { graph, recorder: rw.recorder };
}
```

Callers hand in raw models and get an instrumented graph back, so there is no
wrapped/unwrapped pair to mismatch — passing the graph an uninstrumented tool would
drop every tool step from the trace and report nothing wrong.

It wraps the **model** and the **tools**, not the compiled graph. A compiled graph's
nodes are opaque — `plan.bound` is a `RunnableCallable` whose model is captured inside a
closure — so there is no path from a compiled graph back to the objects that cross
boundaries. Wrapping `invoke` is the only interception point that exists.

`bindTools` stays wrapped, so what gets hashed is the JSON Schema the provider actually
receives. Node names come from LangGraph, so a step knows it happened in `plan` rather
than "somewhere".

Most agents run more than one model — a cheap router, an expensive planner. `model` and
`tools` are sugar for the common one-model shape; `wrap` records anything else.
`model_id` and `provider` are part of a request's identity, so the same prompt sent to
two models is two cassettes, not one overwriting the other.

**One process is one run.** `withRewind` memoizes the recorder, so calling it more than
once joins the existing run rather than opening a rival one — six models still means one
`run_id`, one `steps.jsonl`, and `seq` ordering them.

Outside a `rewind record` wrapper, `withRewind` hands back your model and tools
untouched, `wrap` is the identity function, and `recorder` is `null` — the same code
ships to production unchanged. If you are not on LangGraph, `recorderFromEnv()` gives you
the recorder directly and you call
`recorder?.record({ node, kind, request, response, latency_ms })` yourself.

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

## Runs, steps and cassettes

Three record types and four ids. Every command after `record` is phrased in them.

| id | names | comes from |
|---|---|---|
| `run_id` | one execution of your agent | a ULID, minted once when the recorder opens |
| `seq` | a step's position within that run | a counter, starting at 0 |
| `req_hash` | what was asked | SHA-256 of the canonical request |
| `cassette_ref` | which recording answered it | `= req_hash` while recording |

**A run** is one execution. `run_id` is a ULID — a millisecond timestamp followed by
randomness — so sorting run ids alphabetically sorts them by time. That is why `listRuns`
is a plain `.sort()` and why `record` can tell which run it just created.

**A step** is one boundary crossing: a model call, a tool call, a clock read. Small,
ordered, append-only. It records *that something happened* — where, how long, in what
order — and carries no request or response of its own.

**A cassette** is the payload, named by the hash of the request and shared by every step
that made the same call.

Steps point at cassettes, many to one. Two runs of a support agent that open identically
and diverge on the user's question:

```
RUN 01M1XSBGGK…                  RUN 01M1XSBGN8…
  seq 0  greet  → f0bff2af         seq 0  greet  → f0bff2af     ← same recording
  seq 1  answer → 2b181106         seq 1  answer → 3940b55a     ← different questions
```

Four steps, three cassettes. The greeting is stored once however many runs open that way;
at 500 runs that is 1000 steps and 501 cassettes.

### A step has no id of its own

`(run_id, seq)` is the key. Neither half identifies anything alone — every run has a
`seq 0`, and every run has many steps — but the pair always does.

| ask for | matches |
|---|---|
| `seq = 1` | 2 steps — every run has one |
| `run_id = 01M1XSBGN8…` | 2 steps — that run has several |
| both | 1 step |

A generated `step_id` would answer no question those two don't, and it could not express
`rewind fork <run_id> --at 7` — "run 1, step 7" *is* the pair.

`seq` counts **calls, not nodes**. A ReAct loop is one node that calls the model, calls a
tool, then calls the model again — one `node` value across six steps — while a node doing
only arithmetic produces none. Hence `--at 7` rather than `--at plan`, which could not say
which of the three.

### Why `cassette_ref` exists when replay resolves by hash

Replay never reads it. It hashes the request the agent is about to make and opens that
file; content-addressing means the request *is* the lookup key.

The back-pointer earns its twelve bytes when you delete a run. Drop the oldest hundred and
their cassettes should go too — unless another run still needs them. `cassette_ref` answers
that by reading JSONL. Without it you would re-execute all 500 agents to discover which
files they touched, because the requests that produced those hashes live inside the very
cassettes you are deciding about.

It is also where a substitution gets recorded once fork and structural matching exist:
`req_hash: abc…` with `cassette_ref: def…` and `match_tier: structural` says this call
matched nothing on disk but a near-match was accepted — precisely the thing a trace must
never hide.

## Packages

```
packages/core/     Schema, canonicalization, hashing. No I/O, no network, no filesystem.
packages/sdk-js/   withRewind, recorder, redactor, cassette store, config, env handshake.
packages/cli/      rewind record | show
examples/deep-research-agent/   The reference workload. `start` runs one model,
                                `start:multi` adds a cheap router in front of it.
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
pnpm test        # 76 tests
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

Everything deliberately skipped along the way — the clock and RNG shims, the batching
emitter, Postgres, `rewind doctor` — is logged with the trigger
that should pull it forward.

**M6 — the viewer.** `rewind show` is a table in a terminal; the same recordings deserve a
screen. A web UI to browse your runs, filter them by status, node or tag, open one and walk
its timeline, and read each step's request and response side by side — trace browsing in
the shape LangSmith taught everyone to expect, over cassettes already sitting on your disk.
The sweep view lands alongside it: two runs, one deliberate change, diffed step by step.

It reads through the server API rather than the filesystem, so it arrives after the server
does. And it stays a viewer over *your recordings* — Rewind is not becoming an
observability vendor, and it exports to LangSmith rather than replacing it.

## License

Apache-2.0
