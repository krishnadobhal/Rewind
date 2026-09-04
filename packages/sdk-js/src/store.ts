import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Cassette, Run, Step } from '@rewind/core/schema';

export type Store = {
  putRun(run: Run): void;
  appendStep(step: Step): void;
  putCassette(cassette: Cassette): void;
};

/**
 * A directory is the whole cassette store for now.
 *
 *   <root>/runs/<run_id>/run.json
 *   <root>/runs/<run_id>/steps.jsonl
 *   <root>/cassettes/<hash>.json
 *
 * ponytail: local filesystem, synchronous writes, no compression. Postgres + S3 + an
 * ingest API earn their place when a second process needs to read this; until then they
 * are infrastructure with nothing to do. Swap this function, not its callers.
 */
export function fileStore(root: string): Store {
  const write = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  return {
    putRun(run) {
      write(join(root, 'runs', run.run_id, 'run.json'), JSON.stringify(run, null, 2) + '\n');
    },
    appendStep(step) {
      const path = join(root, 'runs', step.run_id, 'steps.jsonl');
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(step) + '\n');
    },
    putCassette(cassette) {
      const path = join(root, 'cassettes', `${cassette.hash}.json`);
      // Content-addressed and immutable: a corrected recording is a new cassette,
      // never an overwrite of this one.
      if (existsSync(path)) return;
      write(path, JSON.stringify(cassette) + '\n');
    },
  };
}
