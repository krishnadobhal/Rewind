/**
 * The handshake between `rewind record` and the agent it wraps. The CLI sets these;
 * the SDK reads them inside the user's process, where redaction has to happen.
 */
import type { Run } from '@rewind/core/schema';
import { DEFAULT_DIR, loadConfig } from './config.ts';
import { Recorder } from './recorder.ts';
import { fileStore } from './store.ts';

export const ENV_ENABLED = 'REWIND_ENABLED';
export const ENV_DIR = 'REWIND_DIR';
export const ENV_CONFIG = 'REWIND_CONFIG';

/** Builds a Recorder if this process is being recorded. */
export async function recorderFromEnv(run?: Partial<Run>): Promise<Recorder | null> {
  // Null means un-wrapped, so `recorder?.record()` costs nothing.
  if (process.env[ENV_ENABLED] !== '1') return null;
  try {
    const config = await loadConfig(process.env[ENV_CONFIG]); // may not exist
    const dir = process.env[ENV_DIR] ?? config.dir ?? DEFAULT_DIR; // flag beats config
    return new Recorder({ store: fileStore(dir), redact: config.redact, run });
  } catch (error) {
    // Fails open (I1): a broken config must not take the agent down.
    console.warn('[rewind] recorder disabled:', error);
    return null;
  }
}
