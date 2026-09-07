import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Cassette, Run, Step } from '@rewind/core/schema';

export type Store = {
  putRun(run: Run): void;
  appendStep(step: Step): void;
  putCassette(cassette: Cassette): void;
};

/** One recorded run: its metadata plus its ordered steps. */
export type Trace = { run: Run; steps: Step[] };

/** Creates a Store backed by a local directory. */
export function fileStore(root: string): Store {
  // Shared by putRun and putCassette, both whole-file writes.
  const write = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true }); // parents may not exist yet
    writeFileSync(path, body);
  };
  return {
    putRun(run) {
      // Rewritten on finish, so the last write wins.
      write(join(root, 'runs', run.run_id, 'run.json'), JSON.stringify(run, null, 2) + '\n');
    },
    appendStep(step) {
      const path = join(root, 'runs', step.run_id, 'steps.jsonl');
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(step) + '\n'); // append-only, one step per line
    },
    putCassette(cassette) {
      const path = join(root, 'cassettes', `${cassette.hash}.json`);
      // Content-addressed and immutable: a corrected recording is a new
      // cassette, never an overwrite of this one.
      if (existsSync(path)) return;
      write(path, JSON.stringify(cassette) + '\n');
    },
  };
}

function orNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null; // unreadable, corrupt, or not the shape we expected
  }
}

/** Reads one run and its steps back off disk. */
export function readTrace(root: string, runId: string): Trace | null {
  const dir = join(root, 'runs', runId);
  return orNull(() => {
    const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Run;
    const jsonl = existsSync(join(dir, 'steps.jsonl')) ? readFileSync(join(dir, 'steps.jsonl'), 'utf8') : '';
    // Trim first: a trailing newline would split into one empty line.
    const steps = jsonl.trim() === '' ? [] : jsonl.trim().split('\n').map((line) => JSON.parse(line) as Step);
    return { run, steps };
  });
}

/** Lists run ids, oldest first, ULIDs sort by time. */
export function listRuns(root: string): string[] {
  // Not a directory is as good as empty: nothing has been recorded here.
  return orNull(() => readdirSync(join(root, 'runs')).sort()) ?? [];
}

/** Reads one cassette by its content hash. */
export function readCassette(root: string, hash: string): Cassette | null {
  return orNull(() => JSON.parse(readFileSync(join(root, 'cassettes', `${hash}.json`), 'utf8')) as Cassette);
}
