/**
 * One config surface: `rewind.config.ts`, overridden by the environment.
 * Only what is read lives here — a knob nothing consumes is a promise the code breaks.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RedactConfig } from './redact.ts';

export type RewindConfig = {
  /** Cassette store root. A directory; REWIND_SERVER switches the store instead. */
  dir?: string;
  redact?: RedactConfig;
};

/** Identity function giving config files type inference. */
export function defineConfig(config: RewindConfig): RewindConfig {
  return config; // no validation yet, TypeScript is the check
}

/** Store root used when nothing else says otherwise. */
export const DEFAULT_DIR = '.rewind';

/** Imports rewind.config.ts if the user wrote one. */
export async function loadConfig(path?: string): Promise<RewindConfig> {
  const file = resolve(path ?? 'rewind.config.ts'); // absolute, import() needs it
  if (!existsSync(file)) return {}; // unconfigured is valid, not an error
  // Node strips types on import, so a .ts config needs no build step.
  const module = (await import(pathToFileURL(file).href)) as { default?: RewindConfig };
  return module.default ?? {}; // a config with no default export is empty
}
