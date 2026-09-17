/**
 * Runs the ingest server — the one API the SDK writes to and the viewer reads from.
 *
 *   pnpm serve                 # a local directory, zero configuration
 *   pnpm serve   (with .env)   # Postgres, and S3 if S3_ENDPOINT is set
 *
 * The viewer is mounted here rather than run beside it, so it is served from the same
 * origin as the API it reads — no proxy, no CORS, one process, one port.
 *
 * This is the process an operator runs. It holds the database credentials and the
 * 4 MB AWS SDK so the agent does not have to — which is the whole reason the HTTP
 * hop exists.
 */
import { existsSync } from 'node:fs';
import { S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { fileBlobs, type BlobStore } from '@krishnadobhal/rewind-server/blobs';
import { fileIngestStore } from '@krishnadobhal/rewind-server/files';
import { createIngestServer, type IngestStore } from '@krishnadobhal/rewind-server/ingest';
import { migrate, pgStore, type Sql } from '@krishnadobhal/rewind-server/pg';
import { s3Blobs } from '@krishnadobhal/rewind-server/s3';
import { loadEnvFile } from '@krishnadobhal/rewind-sdk-js/env';
import { staticPath } from '@krishnadobhal/rewind-ui';

loadEnvFile();

const port = Number(process.env['REWIND_PORT'] ?? 4000);
const schema = process.env['REWIND_SCHEMA'] ?? 'public';
const token = process.env['REWIND_TOKEN'];

/** Refuses the template's placeholder, which is what a fresh `cp` leaves behind. */
function requireReal(name: string, value: string, placeholder: string): string {
  if (value.includes(placeholder)) {
    throw new Error(`${name} is still the .env.example placeholder — put a real value in .env`);
  }
  return value;
}

/** S3 when an endpoint is configured, a directory otherwise. */
function blobs(): { store: BlobStore; where: string } {
  const endpoint = process.env['S3_ENDPOINT'];
  if (endpoint === undefined || endpoint === '') {
    const dir = process.env['REWIND_BLOB_DIR'] ?? '.rewind-blobs';
    return { store: fileBlobs(dir), where: `files ${dir}` };
  }
  const client = new S3Client({
    endpoint,
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    forcePathStyle: true, // MinIO serves buckets as a path, not a subdomain
    credentials: {
      accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? '',
      secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
    },
  });
  const bucket = process.env['S3_BUCKET'] ?? 'rewind';
  return { store: s3Blobs({ client, bucket }), where: `s3 ${endpoint}/${bucket}` };
}

/**
 * Postgres when `DATABASE_URL` is set, a cassette directory otherwise.
 *
 * Directory mode is not a toy: it is what lets the viewer run against `.rewind/` with
 * nothing installed, over the same `/v1/*` routes it uses in production. One API, two
 * backings, and no second implementation to drift.
 */
async function openStore(): Promise<{ store: IngestStore; where: string; close: () => Promise<void> }> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    const dir = process.env['REWIND_DIR'] ?? '.rewind';
    return { store: fileIngestStore(dir), where: `files ${dir}`, close: async () => {} };
  }

  // node-postgres is changing how it reads libpq's sslmode; say what we mean instead.
  const dsn = new URL(requireReal('DATABASE_URL', url, 'user:password@host'));
  for (const param of ['sslmode', 'channel_binding']) dsn.searchParams.delete(param);
  const pool = new pg.Pool({ connectionString: dsn.href, ssl: { rejectUnauthorized: true } });

  const sql: Sql = {
    query: async (text, params) => {
      const client = await pool.connect();
      try {
        await client.query(`set search_path to ${schema}`);
        return await client.query(text, params as unknown[]);
      } finally {
        client.release();
      }
    },
  };

  if (schema !== 'public') await pool.query(`create schema if not exists ${schema}`);
  await migrate(sql); // applied on boot, so there is no separate migrate step

  const { store: blobStore, where } = blobs();
  return { store: pgStore(sql, blobStore), where: `postgres ${schema} · blobs ${where}`, close: () => pool.end() };
}

const { store, where, close } = await openStore();
// The built viewer, when it has been built: a missing dist/ only costs the UI.
const ui = existsSync(staticPath) ? staticPath : undefined;
const server = createIngestServer({ store, token, ui });

server.listen(port, () => {
  console.log(`rewind ingest  http://localhost:${port}  ${where}${token ? '  · token required' : ''}`);
  console.log(ui === undefined ? 'viewer         not built — run pnpm -F @krishnadobhal/rewind-ui build' : `viewer         http://localhost:${port}`);
});

// Close the pool on Ctrl-C so a restart does not leak connections against a pooler.
process.on('SIGINT', () => {
  server.close();
  void close().then(() => process.exit(0));
});
