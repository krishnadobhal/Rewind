# @krishnadobhal/rewind-server

The other end of [`@krishnadobhal/rewind-sdk-js`](https://www.npmjs.com/package/@krishnadobhal/rewind-sdk-js):
an HTTP ingest API, a Postgres index for runs and steps, and content-addressed blob storage for the bodies.

```bash
npm install @krishnadobhal/rewind-server
```

## Why a server at all

So your agent does not hold database credentials or a 4 MB AWS SDK. The agent POSTs
batches over one HTTP hop; this process owns the connection string, the bucket keys and
the migration. That separation is the entire reason the hop exists.

## Smallest thing that works

No database, no configuration — a directory, over the same routes a production deployment
answers:

```ts
import { createIngestServer } from '@krishnadobhal/rewind-server/ingest';
import { fileIngestStore } from '@krishnadobhal/rewind-server/files';

createIngestServer({ store: fileIngestStore('.rewind') }).listen(4000);
```

Point an agent at it and nothing in the agent changes:

```bash
REWIND_ENABLED=1 REWIND_SERVER=http://localhost:4000 node agent.js
```

## With the viewer mounted

Pass `ui` and the server also serves the built viewer — same origin as the API it reads,
so there is no proxy and no CORS:

```ts
import { createIngestServer } from '@krishnadobhal/rewind-server/ingest';
import { fileIngestStore } from '@krishnadobhal/rewind-server/files';
import { staticPath } from '@krishnadobhal/rewind-ui';

createIngestServer({ store: fileIngestStore('.rewind'), ui: staticPath }).listen(4000);
```

`/v1` and `/health` stay the API's; everything else is the viewer's, with unmatched paths
served the page since it is a single page holding its own state. The UI package ships built
assets and nothing else, so mounting it costs one option and adds no second process.

## Postgres and blobs

```ts
import pg from 'pg';
import { migrate, pgStore, type Sql } from '@krishnadobhal/rewind-server/pg';
import { fileBlobs } from '@krishnadobhal/rewind-server/blobs';
import { createIngestServer } from '@krishnadobhal/rewind-server/ingest';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql: Sql = { query: (text, params) => pool.query(text, params as unknown[]) };

await migrate(sql);   // idempotent; safe to run on every boot

createIngestServer({
  store: pgStore(sql, fileBlobs('.rewind-blobs')),
  token: process.env.REWIND_TOKEN,
}).listen(4000);
```

`Sql` is one method wide — `query(text, params)` — so any driver or pooler satisfies it.
That is also what lets the test suite run on [PGlite](https://pglite.dev) with no Docker.

For S3 or MinIO, swap the blob store and nothing else:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { s3Blobs } from '@krishnadobhal/rewind-server/s3';

const blobs = s3Blobs({
  client: new S3Client({ endpoint, forcePathStyle: true, region, credentials }),
  bucket: 'rewind',
});
```

**Blobs stay content-addressed files, not rows.** A cassette body is immutable and keyed by
its hash, so the same system prompt across 500 runs is stored once, and a corpus can be
committed to git and reviewed in a pull request.

## Routes

| | |
|---|---|
| `POST /v1/ingest` | apply a batch of writes |
| `GET /v1/runs` | run summaries — step counts and tier totals included |
| `GET /v1/runs/:id` | one run with its ordered steps |
| `GET /v1/steps` | `?hash=` the identical call · `?node=&kind=` the same position |
| `GET /v1/cassettes/:hash` | the row, with bodies reassembled from blob storage |
| `GET /health` | unauthenticated, so a load balancer needs no token |

`/v1/runs` returns summaries rather than bare ids because the viewer's list needs counts
and tiers, and a round trip per run to get them would be the wrong shape.

With `token` set, every route but `/health` requires `Authorization: Bearer <token>`.

## Writes are idempotent

Every write is an upsert keyed by content, so a retried batch is safe and a duplicate
delivery is a no-op. That matters because the SDK's emitter retries: it has to, since a
transient failure must not cost you a step.

The failure direction is deliberate. A failed batch answers **500**, never 200 — the
client then counts it as dropped and marks the run `partial`, which is the honest outcome.
A server that swallowed an error and replied 200 would leave you with a run that looks
complete and is not.

## Exports

| | |
|---|---|
| `/ingest` | `createIngestServer`, `IngestStore`, `StepQuery`, `RunSummary` |
| `/files` | `fileIngestStore` — a directory as the backing |
| `/pg` | `pgStore`, `migrate`, `Sql` |
| `/blobs` | `fileBlobs`, `BlobStore`, `shard` |
| `/s3` | `s3Blobs` for S3 or MinIO |

`migrations/001_init.sql` ships with the package; `migrate()` applies it.

## Requirements

Node 22.6+ (24 recommended) and ESM. Types ship with the package. `pg` and
`@aws-sdk/client-s3` are declared dependencies — you need `pg` only for `pgStore` and the
AWS SDK only for `s3Blobs`, but both install either way.

## Scope

**Replay from a server is not in this release.** A run recorded here can be listed, read
and browsed, but not re-executed against its cassettes — that needs the read path to be
async, and it is parked on the `replay-engine` branch.

## License

Apache-2.0
