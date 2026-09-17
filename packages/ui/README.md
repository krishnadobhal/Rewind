# @krishnadobhal/rewind-ui

The built [Rewind](https://github.com/krishnadobhal/Rewind) trace viewer, as static assets
you mount into a server you already run.

```bash
npm install @krishnadobhal/rewind-ui
```

## This package ships assets, not a process

It starts nothing and has **zero runtime dependencies** — React, the icons and the fonts
are already in the bundle. It exports one thing: where the files are.

```ts
import { createIngestServer } from '@krishnadobhal/rewind-server/ingest';
import { fileIngestStore } from '@krishnadobhal/rewind-server/files';
import { staticPath } from '@krishnadobhal/rewind-ui';

createIngestServer({ store: fileIngestStore('.rewind'), ui: staticPath }).listen(4000);
```

Open <http://localhost:4000>. That is the whole integration.

The viewer reads the same `/v1` routes the SDK writes to, so serving it from the same
origin as that API means **no proxy, no CORS, and one process on one port**. A viewer that
shipped its own server would have to solve all three and gain nothing for it.

`staticPath` is an absolute path to a directory. Any static handler can serve it —
`express.static(staticPath)`, a Fastify or Koa static plugin, or a CDN you sync it to.
Route `/v1` to your ingest server and give the viewer everything else, serving
`index.html` for unmatched paths since it is a single page holding its own state.

## What you get

**Run list** — every recorded run with step count, tokens, cost, latency and tier
breakdown. `partial` runs are flagged rather than blended in, because a run that dropped
events is not a complete account of what happened.

**Step timeline** — each boundary the agent crossed, in order, by node and kind, with the
hash that identifies it.

**Request vs. response** — the fully-resolved request beside what came back, in a
collapsible JSON tree. Redaction tokens are marked as removals rather than rendered as
ordinary strings, so you can tell "the redactor took this" from "the model said this".

**Two runs compared** — aligned by sequence, with the first differing step called out.
Everything above it is identical by hash, so that step is the finding.

**The same call elsewhere** — given a step, the other runs that made the identical request
(by hash), or failing that the same node asking something different. This is how you see
whether a bad output is a one-off or a pattern.

Dark, dense and monospaced: it is a debugging surface, not a dashboard.

## Requirements

The server side needs Node 22.6+ and ESM to import `staticPath`. The bundle itself is
plain static files and needs nothing.

## Building it yourself

The published `dist/` is produced by Vite from the sources in the
[repository](https://github.com/krishnadobhal/Rewind/tree/main/packages/ui). For local
development against a running ingest server:

```bash
pnpm -F @krishnadobhal/rewind-ui dev    # Vite on 4100, proxying /v1 to REWIND_SERVER
```

The dev proxy exists only in development, where there is no build to mount.

## License

Apache-2.0
