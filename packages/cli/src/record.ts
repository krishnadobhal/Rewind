/**
 * `rewind record -- <cmd>` — runs the user's agent with recording switched on.
 *
 * The wrapper never touches the agent's data. It sets the handshake env vars, gets out
 * of the way, and reports which runs appeared. Redaction and hashing happen inside the
 * child, in the user's process, which is the only place they may happen (I4).
 */
import { resolve } from 'node:path';
import { listRuns } from '@rewind/sdk-js/store';
import { ENV_CONFIG, ENV_DIR, ENV_ENABLED } from '@rewind/sdk-js/env';
import { ulid } from '@rewind/sdk-js/ulid';
import { spawnAgent } from './spawn.ts';

/** Spawns the agent with recording env, reports new runs. */
export function record(root: string, argv: string[], configPath?: string): number {
  if (argv.length === 0) {
    console.error('rewind: nothing to run — usage: rewind record -- <cmd> [args]');
    return 1;
  }
  // ULIDs sort by time, so a watermark id separates before from after.
  const watermark = ulid().slice(0, 10);

  const status = spawnAgent(argv, {
    [ENV_ENABLED]: '1',
    [ENV_DIR]: resolve(root), // absolute: the child may chdir
    ...(configPath ? { [ENV_CONFIG]: resolve(configPath) } : {}),
  });

  const fresh = listRuns(root).filter((id) => id.slice(0, 10) >= watermark);
  if (fresh.length === 0) {
    // Not an error: the agent may simply never have called the SDK.
    console.error('rewind: no runs recorded — is the agent calling recorderFromEnv()?');
  } else {
    for (const id of fresh) console.error(`rewind: recorded ${id}`);
  }
  // The child's exit code is the command's result, not ours.
  return status;
}
