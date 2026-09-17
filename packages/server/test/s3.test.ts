/**
 * The S3 blob store, against a stubbed client.
 *
 * Honest about what this proves: it checks the code in `s3.ts` — key layout, ref
 * shape, not-found handling — not that AWS behaves as expected. There is no bucket
 * and no MinIO here. Point it at `docker compose up minio` before trusting it in a
 * deployment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s3Blobs, type S3Like } from '../src/s3.ts';

/** An in-memory bucket that answers the three commands s3Blobs sends. */
function bucket(options: { failWith?: { name?: string; status?: number } } = {}) {
  const objects = new Map<string, string>();
  const sent: string[] = [];

  // Not a real S3Client — the cast is the honest admission of that.
  const client = {
    async send(command: unknown) {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push(c.constructor.name);
      const key = String(c.input['Key'] ?? '');

      if (c.constructor.name === 'PutObjectCommand') {
        objects.set(key, String(c.input['Body']));
        return {};
      }
      if (c.constructor.name === 'GetObjectCommand') {
        if (options.failWith) throw Object.assign(new Error('nope'), { name: options.failWith.name, $metadata: { httpStatusCode: options.failWith.status } });
        const body = objects.get(key);
        if (body === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => body } };
      }
      // DeleteObjectsCommand
      for (const o of (c.input['Delete'] as { Objects: { Key: string }[] }).Objects) objects.delete(o.Key);
      return {};
    },
  };
  return { client: client as unknown as S3Like, objects, sent };
}

const HASH = 'a'.repeat(64);

test('a body round-trips, and the ref is an s3 URL', async () => {
  const { client, objects } = bucket();
  const blobs = s3Blobs({ client, bucket: 'rewind' });

  const ref = await blobs.put(HASH, 'request', '{"kind":"model"}');
  assert.equal(ref, `s3://rewind/cassettes/aa/aa/${HASH}/request.json`);
  // Forward slashes, always — a Windows path separator in an S3 key creates a
  // literal backslash in the object name rather than a folder.
  assert.doesNotMatch(ref, /\\/);
  assert.equal(objects.size, 1);
  assert.equal(await blobs.get(ref), '{"kind":"model"}');
});

test('the key layout matches the filesystem store', async () => {
  const { client } = bucket();
  const ref = await s3Blobs({ client, bucket: 'b', prefix: 'tenant-7' }).put(HASH, 'response', 'x');
  // Same two-level shard as fileBlobs, so a corpus moves between a bucket and a
  // directory without rewriting a single ref.
  assert.equal(ref, `s3://b/tenant-7/aa/aa/${HASH}/response.json`);
});

test('a missing object is absent, not an error', async () => {
  const { client } = bucket();
  const blobs = s3Blobs({ client, bucket: 'rewind' });
  assert.equal(await blobs.get(`s3://rewind/cassettes/aa/aa/${HASH}/request.json`), null);
});

test('a 404 without a name is still absent', async () => {
  // MinIO and S3 do not always agree on the error name, so status counts too.
  const { client } = bucket({ failWith: { status: 404 } });
  assert.equal(await s3Blobs({ client, bucket: 'rewind' }).get(`s3://rewind/x/y.json`), null);
});

test('a real failure is raised, not swallowed as absent', async () => {
  // Reporting a 500 as "no such cassette" would turn an outage into a replay miss,
  // which reads as divergence — a wrong answer that looks like a result.
  const { client } = bucket({ failWith: { name: 'InternalError', status: 500 } });
  await assert.rejects(() => s3Blobs({ client, bucket: 'rewind' }).get('s3://rewind/x/y.json'));
});

test('a foreign ref is declined rather than guessed at', async () => {
  const { client, sent } = bucket();
  assert.equal(await s3Blobs({ client, bucket: 'rewind' }).get(`file://${HASH}/request`), null);
  assert.deepEqual(sent, [], 'no request was made for a ref that is not ours');
});

test('writing the same hash twice writes identical bytes', async () => {
  const { client, objects, sent } = bucket();
  const blobs = s3Blobs({ client, bucket: 'rewind' });
  await blobs.put(HASH, 'request', 'body');
  await blobs.put(HASH, 'request', 'body');

  assert.equal(objects.size, 1);
  // No HEAD before each PUT: the body is fixed by the hash, so one request beats two.
  assert.deepEqual(sent, ['PutObjectCommand', 'PutObjectCommand']);
});

test('remove clears every part of a hash', async () => {
  const { client, objects } = bucket();
  const blobs = s3Blobs({ client, bucket: 'rewind' });
  await blobs.put(HASH, 'request', 'a');
  await blobs.put(HASH, 'response', 'b');
  await blobs.remove(HASH);
  assert.equal(objects.size, 0, 'GC must not leave a body behind — cassettes are a PII store');
});
