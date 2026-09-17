<div align="center">

# ⏪ Rewind

**Deterministic record & replay for LangGraph agents.**

</div>

> **Status: record and replay both work.** A recorded agent replays from its cassettes
> with the model never called, reproducing the same final state. There is a viewer for
> reading those runs, and an ingest server that puts them in Postgres.

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
REWIND_ENABLED=1 node your-agent.js                  # record
REWIND_REPLAY=<run_id> node your-agent.js            # replay, exit 2 if it diverged
pnpm serve && pnpm -F @rewind/ui dev                 # read what happened
```

```
$ REWIND_REPLAY=01M1Y7SNTZ0T2FQHAT9752AQ39 node agent.js
$ echo $?
0
```

Four steps, every one answered from a cassette, and the final state hash identical to
the recording. The model was never called — the test that proves it swaps in a model
that throws if anything invokes it.

| | |
|---|---|
| ✅ Canonical request hashing | Decides whether two calls are *the same call*. `HASH_VERSION 3` |
| ✅ Recorder | A Step + a content-addressed Cassette per boundary crossing, and it never throws into your graph |
| ✅ Write-time redaction | Emails, phones, cards, bearer tokens — stripped before anything is written |
| ✅ `withRewind` | Wraps any number of LangGraph models and tools; every call becomes a step |
| ✅ Replay | Re-runs the agent answering from cassettes. `strict` on a miss by default |
| ✅ Match tiers | `exact` or `miss`, always counted and reported |
| ✅ Cassette stores | A directory by default; Postgres + S3/MinIO behind an ingest server |
| ✅ Ingest server | Batched HTTP → Postgres → content-addressed blobs, with bearer auth |
| ✅ Trace browser | Browse runs, step through a timeline, read request beside response, compare two runs |
| ✅ Reference agent | `examples/deep-research-agent` — a real graph, runnable with no API key |

## Wiring it into an agent

Rewind intercepts nothing from outside. It can't — redaction and hashing have to happen
*inside* your process, because a wrapper watching from outside only sees bytes on a
socket, and by then the PII has already left the building.

So an environment variable turns it on, and you instrument where you build the graph —
that is the one place holding every model and tool at once:

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

With `REWIND_ENABLED` unset, `withRewind` hands back your model and tools untouched,
`wrap` is the identity function, and `recorder` is `null` — the same code ships to
production unchanged. If you are not on LangGraph, `recorderFromEnv()` gives you the
recorder directly and you call
`recorder?.record({ node, kind, request, response, latency_ms })` yourself.

## Adding Rewind to another project

```bash
pnpm add @rewind/sdk-js
```

> Not published yet. Inside this workspace use `workspace:*`; from another repo,
> `pnpm link` the package or install from a git ref.

Instrument `buildGraph` as above, then run your agent with recording on:

```bash
REWIND_ENABLED=1 node agent.js                  # writes .rewind/
REWIND_REPLAY=<run_id> node agent.js            # answers from cassettes, exits 2 if it diverged
```

### The environment is the interface

There is no CLI to wrap your command. These variables are the whole surface:

| Variable | Effect |
|---|---|
| `REWIND_ENABLED` | `1` turns recording on. Absent means `withRewind` is a no-op |
| `REWIND_REPLAY` | The run id to replay. Its presence selects replay over recording |
| `REWIND_DIR` | Path to the cassette store. Overrides `dir` in the config file |
| `REWIND_ON_MISS` | `strict` (default) or `live` |
| `REWIND_CONFIG` | Path to `rewind.config.ts` |
| `REWIND_SERVER` | Ingest URL. Its presence swaps the directory for batched HTTP |
| `REWIND_TOKEN` | Bearer token for that server |

One consequence worth knowing: `REWIND_ENABLED=1` in a shell profile would record every
Node process you start. Set it on the command that needs it.

### The one file you do write

`rewind.config.ts` in your project root, and it is optional:

```ts
import { defineConfig } from '@rewind/sdk-js/config';

export default defineConfig({
  dir: '.rewind',                 // where cassettes live
  redact: {
    preset: 'default',            // emails, phones, cards, tokens, AWS keys, JWTs
    custom: [/acct_[a-z0-9]{16}/gi],
    fields: ['headers.authorization', 'args.apiKey'],
  },
});
```

Add `.rewind/` to your `.gitignore`. A cassette holds whatever your agent saw, so
treat that directory as a production data store, not as test fixtures.

## Recording to Postgres and S3

By default everything lands in `.rewind/` next to your agent. That is right while the
agent and the viewer share a disk. When they don't — the agent runs on a server and you
look from your laptop — point it at an ingest server instead.

**Your agent never talks to Postgres.** It POSTs batches to a server that does. Two
reasons, and the second is the one that matters: `sdk-js` ships inside your process
under a 60 kB budget (`pg` alone is 145 kB, the AWS SDK 4.2 MB), and a recorder holding
database credentials inside a customer-facing process is a much worse thing to have
than one that can POST some JSON.

```
your agent                                    your infrastructure
──────────                                    ───────────────────
withRewind → emitter ──── HTTP ────→ ingest server → Postgres
             (batches,                             → S3 / MinIO
              never blocks)
```

### 1. Bring up the backends

```bash
docker compose up -d minio     # or point at real S3
```

Postgres can be anything — Neon, RDS, a container. `docker-compose.yml` has one if you
want it local.

### 2. Configure the server

Start from the tracked template — it holds every name, and no values:

```bash
cp .env.example .env
```

`.env` is gitignored (`.gitignore` covers `.env` and `.env.*`, with `.env.example`
excepted), so a connection string put there cannot be committed by accident. Nothing
auto-loads it: the scripts pass `--env-file=.env` explicitly, which is Node's built-in
flag and needs no `dotenv`.

Fill it in:

```bash
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
S3_ENDPOINT=http://127.0.0.1:9000     # omit entirely to keep blobs on local disk
S3_BUCKET=rewind
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
AWS_REGION=us-east-1
REWIND_TOKEN=<generate one, see below>  # optional; when set, every write must carry it
```

| Variable | Read by | Effect |
|---|---|---|
| `DATABASE_URL` | the server | Postgres for runs, steps and the cassette catalogue |
| `S3_ENDPOINT` | the server | Bucket for cassette bodies. Unset means local files |
| `S3_BUCKET`, `AWS_*` | the server | Standard S3 credentials; MinIO uses the same ones |
| `REWIND_TOKEN` | both | Bearer token. **Unset means the server accepts anything**  |
| `REWIND_PORT` | the server | Defaults to 4000 |
| `REWIND_SCHEMA` | the server | Postgres schema, defaults to `public` |

**About `REWIND_TOKEN`.** It is a shared bearer token, nothing cleverer — the server
compares `Authorization: Bearer <token>` against the one string it was started with.
Generate one rather than inventing it:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Leave it unset and the server takes writes from anything that can reach the port. That
endpoint accepts runs into your trace store and serves recordings back, and recordings
hold whatever your agent saw — so unset is only reasonable on a loopback address.

What it is not: there is no rotation, no per-agent identity, and no rate limiting. It is
enough for a server on a private network behind something that already does auth. It is
not enough to put on the public internet.

### 3. Run the server

```bash
pnpm serve
# rewind ingest  http://localhost:4000  postgres public · blobs s3 http://127.0.0.1:9000/rewind
```

It applies the migration on boot, so there is no separate migrate step. Embedding it in
a service you already run is four lines:

```ts
import { createIngestServer } from '@rewind/server/ingest';
import { migrate, pgStore } from '@rewind/server/pg';
import { s3Blobs } from '@rewind/server/s3';

await migrate(sql);
createIngestServer({ store: pgStore(sql, s3Blobs({ client, bucket })), token }).listen(4000);
```

### 4. Point the agent at it

```bash
REWIND_ENABLED=1 REWIND_SERVER=http://localhost:4000 REWIND_TOKEN="$REWIND_TOKEN" node agent.js
```

That is the only change. Your agent code is identical — the SDK reads `REWIND_SERVER`
and swaps the directory for a batching HTTP client, so a deployment can export it once.

### What happens when the server is down

The agent keeps running. That is invariant I1 and it does not bend for a network. Writes
queue in memory, the queue is bounded, and what will not fit is dropped and counted —
bounded memory beats complete telemetry. The run is marked `partial`, and a partial run
is never used as a replay source. What Rewind will not do is finish quietly and let you
believe the recording is complete.

One gap worth knowing: the queue is flushed on `beforeExit`, which does not fire on
`process.exit()` or an uncaught throw. Writes still queued at that moment are lost, and
reported rather than hidden.

### Blobs on disk instead of S3

Leave `S3_ENDPOINT` unset. Postgres holds the index, bodies go to `REWIND_BLOB_DIR`
(default `.rewind-blobs`), content-addressed with the same layout as the bucket — so a
corpus moves between the two without rewriting a ref. That is the right shape for a
single-node self-host, and it is what keeps `bench/corpus/` committable to git.

## Reading what happened

```bash
pnpm serve                     # the ingest server, on :4000
pnpm -F @rewind/ui dev         # the viewer, on :4100
```

Three panes: pick a run, walk its steps, read the request beside the response. A step
that missed says so rather than showing you a plausible substitute. Pick a second run and
the middle pane becomes a comparison — two recordings, one deliberate change, diffed step
by step, which is the question the project exists to answer.

The viewer also answers *"has this exact call happened before?"* — `req_hash` is the
identity of a call, so every other run that made it is one query away.

It reads through the server's `/v1/*` routes rather than the filesystem, so it works the
same whether those are backed by Postgres or by a directory. Read-only by design.

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

Too strict and every replay misses; too loose and you replay a stale answer to a different
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

Three record types and four ids. Everything downstream is phrased in them.

| id | names | comes from |
|---|---|---|
| `run_id` | one execution of your agent | a ULID, minted once when the recorder opens |
| `seq` | a step's position within that run | a counter, starting at 0 |
| `req_hash` | what was asked | SHA-256 of the canonical request |
| `cassette_ref` | which recording answered it | `= req_hash` while recording |

**A run** is one execution. `run_id` is a ULID — a millisecond timestamp followed by
randomness — so sorting run ids alphabetically sorts them by time. That is why `listRuns`
is a plain `.sort()`, and why the newest run is the last one written.

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

A generated `step_id` would answer no question those two don't: "run 1, step 7" *is* the
pair, and that is how the viewer addresses a step you click.

`seq` counts **calls, not nodes**. A ReAct loop is one node that calls the model, calls a
tool, then calls the model again — one `node` value across six steps — while a node doing
only arithmetic produces none. So a step is addressed by its number rather than by its
node name, which could not say which of the three.

### Why `cassette_ref` exists when replay resolves by hash

Replay never reads it. It hashes the request the agent is about to make and opens that
file; content-addressing means the request *is* the lookup key.

The back-pointer earns its twelve bytes when you delete a run. Drop the oldest hundred and
their cassettes should go too — unless another run still needs them. `cassette_ref` answers
that by reading JSONL. Without it you would re-execute all 500 agents to discover which
files they touched, because the requests that produced those hashes live inside the very
cassettes you are deciding about.

It is also where a substitution would be recorded if a looser match tier is ever accepted:
`req_hash: abc…` with `cassette_ref: def…` says this call matched nothing on disk but a
near-match was used — precisely the thing a trace must never hide.

## Packages

```
packages/core/     Schema, canonicalization, hashing. No I/O, no network, no filesystem.
packages/sdk-js/   withRewind, recorder, redactor, cassette store, config, env handshake.
packages/server/   The ingest API, Postgres index, and content-addressed blob stores.
packages/ui/       The viewer. React, reads /v1/* and nothing else.
examples/deep-research-agent/   The reference workload — see its own README.
                                `start` runs one model, `start:multi` adds a router.
```

Dependencies point one way, into `core`. Nothing imports upward. `sdk-js` is the only code
that runs inside your process, which is why it stays small and why the store sits behind a
three-method interface — swap `fileStore` for a real backend and nothing upstream changes.

## Two behaviours worth knowing

**The recorder fails open.** It runs inside your production agent, so a full disk or a
serialization bug is caught, counted, and logged at most once a minute — your graph keeps
running. The run is then marked `partial`, and a partial run is never a replay source. The
caller cannot override that.

**Match tier is always reported.** Every step carries the tier it resolved at, and the
viewer always shows it. A run that resolved 96% exact is evidence; one that resolved 40%
by fuzzy match is a hypothesis. The code must never let those two look alike.

## Develop

```bash
pnpm install
pnpm build
pnpm test              # 109 unit tests
pnpm test:determinism  # 20/20 corpus runs replay identically, 0 network
pnpm test:redaction    # no PII survives a record → store round trip
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

## License

Apache-2.0
