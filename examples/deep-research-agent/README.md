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

With Rewind switched on, the same file records and replays:

```bash
REWIND_ENABLED=1 pnpm -F deep-research-agent start
REWIND_REPLAY=<run_id> pnpm -F deep-research-agent start   # exits 2 if it diverged
```

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
| `test/agent.test.ts` | records, replays, and asserts the trace |

`src/graph.ts` is also imported by `scripts/build-corpus.ts` and by the determinism
suite, so a change to the graph shape changes `bench/corpus` and the gate along with it.

## Recording it to a server

**The example runs with no `.env` at all.** It has no keys and reaches nothing — that
is the whole reason it can be the reference workload, and why a stranger can clone the
repo and run the gates.

There is a `.env.example` here for the one case where you would want one — swapping
`ScriptedChatModel` for a real provider in `src/main.ts`:

```bash
cp .env.example .env    # then set ANTHROPIC_API_KEY
```

The `start` scripts load it with `--env-file-if-exists`, not `--env-file` — absent is a
valid state, and the example must keep running without one. `.env` is gitignored at
every level, so a key put here cannot be committed.

**`REWIND_SERVER` and `REWIND_TOKEN` can go in this file**, since the agent is the process
that reads them — but a server URL and a bearer token belong to a deployment rather than to
a checked-out example, so the shell that starts the agent is the better place.

The database credentials are not these. Those belong to the *server*, a separate process
that holds them so your agent does not have to. From the repo root:

```bash
cp .env.example .env          # then fill in DATABASE_URL and, if using S3, the S3_* keys
docker compose up -d minio    # only if you want blobs in a bucket rather than on disk
pnpm serve                    # applies the migration on boot
```

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

## What it deliberately does not exercise

No clock, no randomness, no streaming, no human-in-the-loop, no subgraphs — those
boundaries are listed in [docs/DETERMINISM.md](../../docs/DETERMINISM.md) and deferred in
[docs/WISHLIST.md](../../docs/WISHLIST.md). It does cross the RNG boundary by accident:
LangChain stamps a random UUID on every message. Canonicalization scrubs those to
ordinals, which is why two recordings of the same question hash identically.
