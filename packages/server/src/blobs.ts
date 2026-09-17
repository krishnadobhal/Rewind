import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Which body of a cassette a ref points at. */
export type BlobPart = 'request' | 'response' | 'chunks';

export type BlobStore = {
  /** Writes a body and returns its ref. Writing the same hash twice is a no-op. */
  put(hash: string, part: BlobPart, body: string): Promise<string>;
  get(ref: string): Promise<string | null>;
  /** Removes every body for a hash, for GC past the retention window. */
  remove(hash: string): Promise<void>;
};

/** Two levels of fan-out — 65k entries in one directory is slow everywhere. */
export const shard = (hash: string) => join(hash.slice(0, 2), hash.slice(2, 4), hash);

/** Content-addressed blob store rooted at a local directory. */
export function fileBlobs(root: string): BlobStore {
  const pathFor = (hash: string, part: string) => join(root, shard(hash), `${part}.json`);

  return {
    async put(hash, part, body) {
      const path = pathFor(hash, part);
      const ref = `file://${hash}/${part}`; // the ref is an address, not a path
      // Addressed by content: if it exists it already holds exactly this body.
      if (existsSync(path)) return ref;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      return ref;
    },

    async get(ref) {
      const parsed = /^file:\/\/([0-9a-f]{64})\/(request|response|chunks)$/.exec(ref);
      if (parsed === null) return null; // not ours — an s3:// ref lands here
      const path = pathFor(parsed[1]!, parsed[2]!);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    },

    async remove(hash) {
      rmSync(join(root, shard(hash)), { recursive: true, force: true });
    },
  };
}
