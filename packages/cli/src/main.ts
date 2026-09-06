#!/usr/bin/env node
/**
 * Entry point. Parses global flags, resolves the one config surface, dispatches.
 * Exit codes follow docs/CLI.md: 0 ok · 1 usage/config · 2 gate failed ·
 * 3 unreplayable · 4 server unreachable.
 */
import { parseArgs } from 'node:util';
import { DEFAULT_DIR, loadConfig } from '@rewind/sdk-js/config';
import { record } from './record.ts';
import { show } from './show.ts';

const USAGE = `rewind — deterministic record & replay for LangGraph agents

  rewind record [--dir <path>] -- <cmd> [args]   run an agent with recording on
  rewind show <run_id> [--json]                  print a recorded trace

  --config <path>   default: ./rewind.config.ts
  --dir <path>      cassette store root; overrides config.dir
  --json            machine-readable output
`;

/** Parses argv, loads config, runs one command. */
async function main(argv: string[]): Promise<number> {
  // Everything after `--` belongs to the child, not to us.
  const cut = argv.indexOf('--');
  const own = cut === -1 ? argv : argv.slice(0, cut);
  // example: rewind record -- node agent.js 
  // own = ['record']
  // childArgv = ['node', 'agent.js']
  const childArgv = cut === -1 ? [] : argv.slice(cut + 1);

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      config: { type: 'string' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined ? 1 : 0; // no command is a usage error
  }

  // Flags beat the config file, which beats the built-in default.
  const config = await loadConfig(values.config);
  const root = values.dir ?? config.dir ?? DEFAULT_DIR;

  switch (command) {
    case 'record':
      return record(root, childArgv, values.config);
    case 'show': {
      const runId = rest[0];
      if (runId === undefined) {
        console.error('rewind: show needs a run id');
        return 1;
      }
      return show(root, runId, values.json);
    }
    default:
      console.error(`rewind: unknown command '${command}'\n\n${USAGE}`);
      return 1;
  }
}

// Top-level await keeps the exit code honest; a rejected promise must not exit 0.
process.exitCode = await main(process.argv.slice(2));
