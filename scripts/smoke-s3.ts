/**
 * Smoke-tests the blob store against a real S3 endpoint.
 *
 *   docker compose up -d minio
 *   node --env-file=.env scripts/smoke-s3.ts
 *
 * The unit tests use a stubbed client, so they check key layout and error handling but
 * have never spoken S3. This is the part that needs a server: real PUT/GET, a real
 * 404, and the path-style addressing MinIO requires and AWS does not.
 */
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { s3Blobs } from '@rewind/server/s3';
import { loadEnvFile } from '@rewind/sdk-js/env';

loadEnvFile();

const endpoint = process.env['S3_ENDPOINT'];
const bucket = process.env['S3_BUCKET'] ?? 'rewind';
if (endpoint === undefined) throw new Error('S3_ENDPOINT is not set — copy .env.example to .env');

const client: S3Client = new S3Client({
  endpoint,
  region: process.env['AWS_REGION'] ?? 'us-east-1',
  // MinIO serves buckets as a path, not a subdomain. AWS accepts both.
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? '',
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
  },
});

const checks: string[] = [];
const check = (name: string, ok: boolean) => {
  checks.push(`${ok ? '✔' : '✖'} ${name}`);
  if (!ok) process.exitCode = 1;
};

/** Creates the bucket if this is the first run against this endpoint. */
async function ensureBucket(): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

await ensureBucket();
const blobs = s3Blobs({ client, bucket });

// A hash nobody else will use, so repeated runs do not collide.
const hash = createHash('sha256').update(`smoke-${Date.now()}`).digest('hex');
const body = JSON.stringify({ kind: 'model', messages: [{ role: 'user', content: 'hello' }] });

try {
  const ref = await blobs.put(hash, 'request', body);
  check('put returns an s3:// ref', ref === `s3://${bucket}/cassettes/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}/request.json`);
  check('a body round-trips through a real bucket', (await blobs.get(ref)) === body);

  // The re-PUT path: identical content, no HEAD first.
  await blobs.put(hash, 'request', body);
  check('writing the same hash twice is harmless', (await blobs.get(ref)) === body);

  const missing = `s3://${bucket}/cassettes/00/00/${'0'.repeat(64)}/request.json`;
  // The one that matters: a real NoSuchKey must read as absent, not as a failure.
  // Reporting an outage as "no such cassette" would turn it into a replay miss,
  // which reads as divergence — a wrong answer that looks like a result.
  check('a missing object reads as absent', (await blobs.get(missing)) === null);

  check('a file:// ref is declined', (await blobs.get(`file://${hash}/request`)) === null);

  await blobs.put(hash, 'response', '{"content":"hi"}');
  await blobs.remove(hash);
  check('remove clears every part', (await blobs.get(ref)) === null);
} finally {
  await blobs.remove(hash); // leave the bucket as it was found
  client.destroy();
}

console.log(`endpoint ${endpoint} · bucket ${bucket}`);
console.log(checks.join('\n'));
console.log(process.exitCode ? 'smoke: FAILED' : 'smoke: ok, objects removed');
