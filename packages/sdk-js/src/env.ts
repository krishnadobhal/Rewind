/**
 * The environment is the interface: set these before the agent starts and the SDK
 * reads them inside the user's process, where redaction has to happen.
 */
import type { Run } from '@rewind/core/schema';
import { DEFAULT_DIR, loadConfig } from './config.ts';
import { bufferedStore } from './emitter.ts';
import { httpStore } from './http.ts';
import { Recorder } from './recorder.ts';
import { Replayer } from './replay.ts';
import { fileStore, type Store } from './store.ts';

export const ENV_ENABLED = 'REWIND_ENABLED';
export const ENV_DIR = 'REWIND_DIR';
export const ENV_CONFIG = 'REWIND_CONFIG';
/** The run to replay. Its presence puts this process in replay. */
export const ENV_REPLAY = 'REWIND_REPLAY';
export const ENV_ON_MISS = 'REWIND_ON_MISS';
/** Ingest server URL. Its presence sends writes over HTTP instead of to a directory. */
export const ENV_SERVER = 'REWIND_SERVER';
export const ENV_TOKEN = 'REWIND_TOKEN';

/** Where the store lives for this process. */
async function storeRoot(): Promise<string> {
  const config = await loadConfig(process.env[ENV_CONFIG]); // may not exist
  return process.env[ENV_DIR] ?? config.dir ?? DEFAULT_DIR; // flag beats config
}

export async function replayerFromEnv(): Promise<Replayer | null> {
  const runId = process.env[ENV_REPLAY];
  if (runId === undefined || runId === '') return null;
  const onMiss = process.env[ENV_ON_MISS] === 'live' ? 'live' : 'strict'; // strict by default (I6)
  const root = await storeRoot();
  const replayer = new Replayer({ root, runId, onMiss });

  // A replay writes nothing: it reads cassettes and sets the exit code, which is
  // what makes a wrapper unnecessary.
  replayer.onExit();
  return replayer;
}

let current: Promise<Recorder | null> | null = null;

/** Returns this process's recorder, opening it once. */
export async function recorderFromEnv(run?: Partial<Run>): Promise<Recorder | null> {
  current ??= build(run); // first caller's metadata wins; later callers join the run
  return current;
}

// Drops the memo so the next call opens a new run.
export function resetRecorder(): void {
  current = null;
}

function chooseStore(root: string): { store: Store; flush?: () => Promise<unknown> } {
  const url = process.env[ENV_SERVER];
  if (url === undefined || url === '') return { store: fileStore(root) };
  const buffered = bufferedStore({
    target: httpStore({ url, token: process.env[ENV_TOKEN] }),
  });
  return { store: buffered, flush: buffered.flush };
}

/** Opens the run: reads config, picks a store, starts recording. */
async function build(run?: Partial<Run>): Promise<Recorder | null> {
  if (process.env[ENV_ENABLED] !== '1') return null;
  try {
    const config = await loadConfig(process.env[ENV_CONFIG]); // may not exist
    const { store, flush } = chooseStore(await storeRoot());

    if (flush) flushOnExit(flush);
    return new Recorder({ store, redact: config.redact, run });
  } catch (error) {
    // Fails open (I1): a broken config must not take the agent down.
    console.warn('[rewind] recorder disabled:', error);
    return null;
  }
}

function flushOnExit(flush: () => Promise<unknown>): void {
  let done = false;
  process.on('beforeExit', () => {
    if (done) return; // beforeExit can fire more than once
    done = true;
    void flush().catch(() => {}); // failing to flush must not become an exception
  });
}
