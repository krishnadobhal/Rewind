import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Store } from './types/store.ts';

export type { Store } from './types/store.ts';

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
