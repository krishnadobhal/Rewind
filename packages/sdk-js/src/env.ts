/**
 * The handshake between `rewind record` and the agent it wraps. The CLI sets these;
 * the SDK reads them inside the user's process, where redaction has to happen.
 */
import type { Run } from '@rewind/core/schema';
import { DEFAULT_DIR, loadConfig } from './config.ts';
import { Recorder } from './recorder.ts';
import { Replayer } from './replay.ts';
import { fileStore } from './store.ts';

export const ENV_ENABLED = 'REWIND_ENABLED';
export const ENV_DIR = 'REWIND_DIR';
export const ENV_CONFIG = 'REWIND_CONFIG';
/** Set by `rewind replay` to the run being replayed. */
export const ENV_REPLAY = 'REWIND_REPLAY';
export const ENV_ON_MISS = 'REWIND_ON_MISS';

/** Where the store lives for this process. */
async function storeRoot(): Promise<string> {
  const config = await loadConfig(process.env[ENV_CONFIG]); // may not exist
  return process.env[ENV_DIR] ?? config.dir ?? DEFAULT_DIR; // flag beats config
}

/**
 * Builds a Replayer when this process is replaying a run.
 *
 * Not memoized: unlike recording, replay throws on a bad run id rather than failing
 * open. A replay that cannot find its recording has not "degraded", it has no reason
 * to run at all.
 */
export async function replayerFromEnv(): Promise<Replayer | null> {
  const runId = process.env[ENV_REPLAY];
  if (runId === undefined || runId === '') return null;
  const onMiss = process.env[ENV_ON_MISS] === 'live' ? 'live' : 'strict'; // strict by default (I6)
  return new Replayer({ root: await storeRoot(), runId, onMiss });
}

/**
 * The process's current run. Memoized because a new Recorder means a new ULID and a
 * new Run row — two `withRewind` calls would otherwise split one agent's steps across
 * two runs, each incomplete, with nothing reporting that it happened.
 */
let current: Promise<Recorder | null> | null = null;

/** Returns this process's recorder, opening it once. */
export async function recorderFromEnv(run?: Partial<Run>): Promise<Recorder | null> {
  // Null means un-wrapped, so `recorder?.record()` costs nothing.
  current ??= build(run); // first caller's metadata wins; later callers join the run
  return current;
}

// Drops the memo so the next call opens a new run.
export function resetRecorder(): void {
  current = null;
}

/** Opens the run: reads config, picks a store, starts recording. */
async function build(run?: Partial<Run>): Promise<Recorder | null> {
  if (process.env[ENV_ENABLED] !== '1') return null;
  try {
    const config = await loadConfig(process.env[ENV_CONFIG]); // may not exist
    return new Recorder({ store: fileStore(await storeRoot()), redact: config.redact, run });
  } catch (error) {
    // Fails open (I1): a broken config must not take the agent down.
    console.warn('[rewind] recorder disabled:', error);
    return null;
  }
}
