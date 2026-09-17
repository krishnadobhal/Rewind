import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { BlobPart, BlobStore } from './blobs.ts';
import { shard } from './blobs.ts';

export type S3Like = Pick<S3Client, 'send'>;

export type S3BlobOptions = {
  client: S3Like;
  bucket: string;
  prefix?: string;
};

/** Content-addressed blob store backed by an S3 bucket. */
export function s3Blobs({ client, bucket, prefix = 'cassettes' }: S3BlobOptions): BlobStore {
  const keyFor = (hash: string, part: string) => `${prefix}/${shard(hash).replace(/\\/g, '/')}/${part}.json`;

  return {
    async put(hash, part, body) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: keyFor(hash, part),
        Body: body,
        ContentType: 'application/json',
      }));
      return `s3://${bucket}/${keyFor(hash, part)}`;
    },

    async get(ref) {
      const parsed = /^s3:\/\/([^/]+)\/(.+)$/.exec(ref);
      if (parsed === null) return null; // not ours — a file:// ref lands here
      try {
        const out = (await client.send(new GetObjectCommand({ Bucket: parsed[1]!, Key: parsed[2]! }))) as {
          Body?: { transformToString: () => Promise<string> };
        };
        return (await out.Body?.transformToString()) ?? null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async remove(hash) {
      // The three parts are the whole object set for a hash; no listing needed.
      const parts: BlobPart[] = ['request', 'response', 'chunks'];
      await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: parts.map((part) => ({ Key: keyFor(hash, part) })), Quiet: true },
      }));
    },
  };
}

/** S3 reports an absent key several ways depending on the operation. */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}
