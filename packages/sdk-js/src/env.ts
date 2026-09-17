import type { Run } from '@krishnadobhal/rewind-core/schema';
import { DEFAULT_DIR, loadConfig } from './config.ts';
import { bufferedStore } from './emitter.ts';
import { httpStore } from './http.ts';
import { Recorder } from './recorder.ts';
import { fileStore, type Store } from './store.ts';

export const ENV_ENABLED = 'REWIND_ENABLED';
export const ENV_DIR = 'REWIND_DIR';
export const ENV_CONFIG = 'REWIND_CONFIG';
export const ENV_SERVER = 'REWIND_SERVER';
export const ENV_TOKEN = 'REWIND_TOKEN';
export const ENV_FILE = 'REWIND_ENV_FILE';

// Loads a .env into process.env, once per process.

let envFileLoaded = false;
export function loadEnvFile(path?: string): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  const file = path ?? process.env[ENV_FILE] ?? '.env';
  if (file === '0') return; // explicitly opted out
  try {
    process.loadEnvFile(file);
  } catch {
    // No .env is the normal case for a library consumer, not an error.
  }
}

/** Where the store lives for this process. */
async function storeRoot(): Promise<string> {
  const config = await loadConfig(process.env[ENV_CONFIG]); // may not exist
  return process.env[ENV_DIR] ?? config.dir ?? DEFAULT_DIR; // flag beats config
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
  loadEnvFile(); // before the check, so a .env can switch recording on
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
