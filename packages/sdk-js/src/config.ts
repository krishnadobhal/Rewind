/**
 * One config surface: `rewind.config.ts`, overridden by flags.
 * There is deliberately no second one — no env-only knobs, no per-call options bag.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RedactConfig } from './redact.ts';

export type RewindConfig = {
  project?: string;
  /** Cassette store root. Local directory today; a server URL when one exists. */
  dir?: string;
  redact?: RedactConfig;
  tools?: { replaySafe?: string[] };
  match?: { tier?: 'exact' | 'structural' | 'semantic'; semanticThreshold?: number };
  onMiss?: 'strict' | 'live' | 'stub';
  sampling?: number;
  budgetUsd?: number;
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
