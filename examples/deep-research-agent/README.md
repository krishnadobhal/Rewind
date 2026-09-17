# deep-research-agent

The reference workload. Every gate in the project runs against this graph, and it is
the smallest thing that crosses every boundary Rewind has to record.

```
                 ┌──────────────────── --multi-model only
                 ▼
START ──► route ──► plan ──► tools ──► summarize ──► END
         (model)  (model)   (tool)     (model)
            │
            └── "direct" ──────────────────────────► END
```

Three node kinds, because three is what it takes: a model call that emits tool calls,
a tool that returns data, and a second model call that reads the tool's output. The
third one is the important one — it is the step whose request contains the previous
two, so it is where a drifting hash shows up first.

## Run it

```bash
pnpm -F deep-research-agent start          # one model
pnpm -F deep-research-agent start:multi    # a cheap router in front of the planner
```

No API key, no network, no services. It prints the conversation and exits.

With Rewind switched on, the same file records every boundary it crosses:

```bash
REWIND_ENABLED=1 pnpm -F deep-research-agent start
cat .rewind/runs/*/steps.jsonl | jq '{seq,node,kind,req_hash}'
```

One environment variable, and `src/` is unchanged. Unset it and `withRewind` hands back
the original model and tools, so an uninstrumented run costs nothing.

Then look at what it recorded:

```bash
pnpm -F deep-research-agent view           # http://localhost:4100
```

`src/viewer.ts` is the whole thing: `fileIngestStore` over this example's own `.rewind`
directory, with the viewer's built assets mounted into the same server. No database, no
second process, no proxy. It answers the same `/v1` routes a Postgres-backed deployment
does, which is why the page cannot tell the two apart.

## Why the model is scripted

`ScriptedChatModel` returns a fixed list of `AIMessage`s, one per call. It is a real
`BaseChatModel` — `bindTools`, callbacks and LangGraph's plumbing all behave exactly as
they would with Anthropic behind it — but it answers from a script.

Two reasons, and neither is convenience:

- **A stranger has to be able to run the gates.** `pnpm test:determinism` replays 20
  recorded runs; if that needed a provider key, the number would not be reproducible.
- **AGENTS.md §8 forbids benchmarking against a live provider.** Numbers that move when
  a model is retrained are not numbers.

Swapping in a real model is one line in `main.ts` — `new ChatAnthropic({ … })` instead
of `new ScriptedChatModel({ … })`. Nothing else in the graph changes, which is the
point of wrapping the model rather than the graph.

LangChain's own `FakeStreamingChatModel` does not work here: it returns `responses[0]`
on every call, so an agent loop never advances and never terminates.

## Where the instrumentation lives

**In `buildGraph`, not in `main.ts`.** That is the one place holding every model and
tool at once:

```ts
export async function buildGraph(binding: Binding) {
  const rw = await withRewind({
    model: binding.model,
    tools: binding.tools,
    recorder: binding.recorder,   // injected by tests
    replayer: binding.replayer,   // injected by tests
    revive: reviveLangChain,
  });
  const router = binding.router ? rw.wrap(binding.router) : undefined;
  // … nodes are built from rw.model / rw.tools …
  return { graph, recorder: rw.recorder, replayer: rw.replayer };
}
```

Callers hand in **raw** models and tools and get an instrumented graph back. There is no
wrapped/unwrapped pair to mismatch — handing the graph an uninstrumented tool would drop
every tool step from the trace and report nothing wrong, which is the failure that only
surfaces later as an unexplained replay miss.

`recorder` and `replayer` are optional so tests can inject their own and assert on steps
without touching env or disk. With neither variable set both are null, `withRewind` returns
the originals untouched, and the file ships to production unchanged.

### `reviveLangChain`

A cassette holds JSON. LangGraph wants an `AIMessage` back, not
`{lc:1,type:"constructor",…}` — hand it the raw JSON and the *next* request it builds
differs from the recording, so every later step misses. `sdk-js` cannot revive that
without depending on `@langchain/*`, so the reviver lives here, next to the framework
that needs it.

This is not hypothetical: the first replay attempt failed at `summarize` for exactly
this reason.

## Files

| | |
|---|---|
| `src/model.ts` | `ScriptedChatModel` — a real `BaseChatModel` answering from a list |
| `src/graph.ts` | the tool, the scripts, and `buildGraph` — where `withRewind` goes |
| `src/main.ts` | entry point; picks the models, runs the graph, prints the transcript |
| `src/viewer.ts` | serves `.rewind` over `/v1` with the viewer mounted — `pnpm … view` |
| `test/agent.test.ts` | records, replays, and asserts the trace |

`src/graph.ts` is exported, so `test/` and the repo's scripts import the same graph the
example runs — a change to the shape changes every gate that reads it.

## Recording it to a server

**The example runs with no `.env` at all.** It has no keys and reaches nothing — that is
the whole reason it can be the reference workload, and why a stranger can clone the repo
and run every gate.

It will read one if you put it here, though, and there is a `.env.example` for that:

```bash
cp .env.example .env
```

**The SDK loads it, not the start script.** `recorderFromEnv()` calls `loadEnvFile()`
*before* it checks `REWIND_ENABLED`, so a value in this file can switch recording on
without touching the shell — and a missing file is the normal case rather than an error,
which is what keeps the example runnable with nothing configured. `REWIND_ENV_FILE`
points somewhere else, or `0` opts out. `.env` is gitignored at every level, so a key
put here cannot be committed.

**`REWIND_SERVER` and `REWIND_TOKEN` can go in this file**, since the agent is the process
that reads them — though a server URL and a bearer token belong to a deployment more than
to a checked-out example, so the shell is usually the better home.

Database credentials are not these. Those belong to the *server*, a separate process that
holds them so your agent does not have to. From the repo root:

```bash
cp .env.example .env          # then fill in DATABASE_URL and, if using S3, the S3_* keys
docker compose up -d minio    # only if you want blobs in a bucket rather than on disk
pnpm serve                    # applies the migration on boot
```

`pnpm serve` serves the viewer too, on the same port — the ingest API owns `/v1`, the
viewer gets everything else. Open <http://localhost:4000> once a run has landed.

Then point the agent at it. The example is unchanged:

```bash
REWIND_ENABLED=1 REWIND_SERVER=http://localhost:4000 REWIND_TOKEN="$REWIND_TOKEN" \
  pnpm -F deep-research-agent start
```

Nothing in `src/` knows where writes went. The SDK reads `REWIND_SERVER`, swaps its
directory store for a batching HTTP client, and the graph
is none the wiser — which is the same property that lets `withRewind` be a no-op when
nobody is recording.

The full variable table is in the root [README](../../README.md#recording-to-postgres-and-s3).

## The same thing outside this repo

In here the example links to the workspace. From anywhere else, the four packages are on
npm and the code is identical:

```bash
pnpm add @krishnadobhal/rewind-sdk-js      # instrument an agent
pnpm add @krishnadobhal/rewind-server      # ...and self-host the store
pnpm add @krishnadobhal/rewind-ui          # ...and the viewer's built assets
```

`@krishnadobhal/rewind-core` arrives as a dependency of the other two; you rarely import
it directly.

```ts
import { withRewind } from '@krishnadobhal/rewind-sdk-js/middleware';

const rw = await withRewind({ model, tools });
// rw.model and rw.tools are instrumented; hand them to your graph.
```

Your own ingest server, with the viewer mounted in it, is six lines. This is the
[bull-board](https://github.com/felixmosh/bull-board) arrangement: the UI package ships
built assets, and the server you already run mounts them.

```ts
import { createIngestServer } from '@krishnadobhal/rewind-server/ingest';
import { fileIngestStore } from '@krishnadobhal/rewind-server/files';
import { staticPath } from '@krishnadobhal/rewind-ui';

createIngestServer({ store: fileIngestStore('.rewind'), ui: staticPath }).listen(4000);
```

Same origin for the page and the API it reads, so there is no proxy and no CORS. Swap
`fileIngestStore` for `pgStore` when a directory stops being enough — the routes and the
viewer do not change.

## What it deliberately does not exercise

No clock, no randomness, no streaming, no human-in-the-loop, no subgraphs — those
boundaries are listed in [docs/DETERMINISM.md](../../docs/DETERMINISM.md) and deferred in
[docs/WISHLIST.md](../../docs/WISHLIST.md). It does cross the RNG boundary by accident:
LangChain stamps a random UUID on every message. Canonicalization scrubs those to
ordinals, which is why two recordings of the same question hash identically.
