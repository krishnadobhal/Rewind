/**
 * `rewind record -- <cmd>` — runs the user's agent with recording switched on.
 *
 * The wrapper never touches the agent's data. It sets the handshake env vars, gets out
 * of the way, and reports which runs appeared. Redaction and hashing happen inside the
 * child, in the user's process, which is the only place they may happen (I4).
 */
import { spawnSync } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { listRuns } from '@rewind/sdk-js/store';
import { ENV_CONFIG, ENV_DIR, ENV_ENABLED } from '@rewind/sdk-js/env';
import { ulid } from '@rewind/sdk-js/ulid';

/** Spawns the agent with recording env, reports new runs. */
export function record(root: string, argv: string[], configPath?: string): number {
  if (argv.length === 0) {
    console.error('rewind: nothing to run — usage: rewind record -- <cmd> [args]');
    return 1;
  }
  // ULIDs sort by time, so a watermark id separates before from after.
  const watermark = ulid().slice(0, 10);
  const [command, ...args] = argv;

  const child = spawnSync(command!, args, {
    stdio: 'inherit', // the agent's output is the user's output
    env: {
      ...process.env,
      [ENV_ENABLED]: '1',
      [ENV_DIR]: resolve(root), // absolute: the child may chdir
      ...(configPath ? { [ENV_CONFIG]: resolve(configPath) } : {}),
    },
    // Windows resolves a bare `pnpm` to a .cmd shim, which needs a shell. A path
    // that already has an extension must not get one, or a space in it splits
    // the command. ponytail: args with spaces stay unquoted in the shell case.
    shell: process.platform === 'win32' && extname(command!) === '',
  });

  if (child.error) {
    console.error(`rewind: could not run ${command}:`, child.error.message);
    return 1;
  }

  const fresh = listRuns(root).filter((id) => id.slice(0, 10) >= watermark);
  if (fresh.length === 0) {
    // Not an error: the agent may simply never have called the SDK.
    console.error('rewind: no runs recorded — is the agent calling recorderFromEnv()?');
  } else {
    for (const id of fresh) console.error(`rewind: recorded ${id}`);
  }
  // The child's exit code is the command's result, not ours.
  return child.status ?? 0;
}
