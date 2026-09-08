import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

/** How to invoke a command, and whether it needs a shell. */
type Resolved = { command: string; shell: boolean };

/**
 * Finds what a bare command name actually runs, on Windows.
 *
 * `node` is `node.exe` and can be spawned directly, which keeps arguments intact.
 * `pnpm` is `pnpm.cmd`, and Node refuses to spawn a `.cmd` without a shell — so those
 * still go through one, with the quoting caveat below.
 */
function resolveCommand(command: string): Resolved {
  // POSIX never needs a shell; spawn passes argv through untouched.
  if (process.platform !== 'win32') return { command, shell: false };
  // An explicit path or extension is already unambiguous.
  if (extname(command) !== '') return { command, shell: /\.(cmd|bat)$/i.test(command) };

  const extensions = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';');
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(dir, command + extension);
      if (!existsSync(candidate)) continue;
      // Found it. A .exe spawns directly; a .cmd shim does not.
      return { command: candidate, shell: /\.(cmd|bat)$/i.test(candidate) };
    }
  }
  // Not on PATH — hand it to spawn anyway so the error names the command.
  return { command, shell: false };
}

const quote = (argument: string) => (argument.includes(' ') ? `"${argument}"` : argument);

/** Runs the agent with extra env, returning its exit code. */
export function spawnAgent(argv: string[], env: Record<string, string>): number {
  const [name, ...args] = argv;
  const resolved = resolveCommand(name!);

  // Quote the command too: a path with spaces splits under cmd.exe.
  const child = spawnSync(resolved.shell ? quote(resolved.command) : resolved.command, resolved.shell ? args.map(quote) : args, {
    stdio: 'inherit', // the agent's output is the user's output
    env: { ...process.env, ...env },
    shell: resolved.shell,
  });

  if (child.error) {
    console.error(`rewind: could not run ${name}:`, child.error.message);
    return 1;
  }
  // The child's exit code is the command's result, not ours.
  return child.status ?? 0;
}
