/**
 * `rewind replay <run_id> -- <cmd>` — run the agent again, answering from cassettes.
 *
 * Symmetric with `record` on purpose: the same command, the same process, the same
 * agent code. Only the env handshake differs, so the agent cannot tell which mode it
 * is in — which is what makes a replay a replay rather than a second run.
 */
import { resolve } from 'node:path';
import { ENV_CONFIG, ENV_DIR, ENV_ON_MISS, ENV_REPLAY } from '@rewind/sdk-js/env';
import { readTrace } from '@rewind/sdk-js/store';
import { spawnAgent } from './spawn.ts';

export type ReplayOptions = { onMiss: 'strict' | 'live'; configPath?: string };

/** Re-runs the agent with replay switched on. */
export function replay(root: string, runId: string, argv: string[], options: ReplayOptions): number {
  if (argv.length === 0) {
    console.error('rewind: nothing to run — usage: rewind replay <run_id> -- <cmd> [args]');
    return 1;
  }
  // Fail before spawning: an unknown run id is a usage error, not a crash mid-run.
  const source = readTrace(root, runId);
  if (source === null) {
    console.error(`rewind: no run ${runId} in ${root}`);
    return 1;
  }
  if (source.run.status === 'partial') {
    console.error(`rewind: run ${runId} is partial — dropped events make it unusable as a replay source`);
    return 1;
  }

  // Exit 2 is "gate failed" per CLI.md — the agent signals a failed replay by
  // exiting non-zero after comparing its own state hash.
  return spawnAgent(argv, {
    [ENV_REPLAY]: runId, // presence of this is what selects replay mode
    [ENV_DIR]: resolve(root),
    [ENV_ON_MISS]: options.onMiss,
    ...(options.configPath ? { [ENV_CONFIG]: resolve(options.configPath) } : {}),
  });
}
