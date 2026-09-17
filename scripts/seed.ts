/**
 * Writes a few runs into a store, so the viewer has something to show.
 *
 *   pnpm seed                            # into .rewind
 *   pnpm seed .rewind-ui                 # or any directory
 *   pnpm seed http://localhost:4000      # or through the ingest server, into
 *                                        # whatever that server is backed by
 *
 * Agents repeat themselves, and the viewer has a pane about exactly that — three of
 * these runs ask the same three questions, and the fourth diverges on its last step.
 */
import { bufferedStore } from '@krishnadobhal/rewind-sdk-js/emitter';
import { httpStore } from '@krishnadobhal/rewind-sdk-js/http';
import { Recorder } from '@krishnadobhal/rewind-sdk-js/recorder';
import { fileStore, type Store } from '@krishnadobhal/rewind-sdk-js/store';

const target = process.argv[2] ?? '.rewind';
const overHttp = target.startsWith('http://') || target.startsWith('https://');

// Over HTTP the writes are buffered and flushed, exactly as an agent's would be —
// the point of seeding a server is to exercise the path the SDK actually takes.
const buffered = overHttp
  ? bufferedStore({ target: httpStore({ url: target, token: process.env['REWIND_TOKEN'] }), batchMs: 0 })
  : null;
const store: Store = buffered ?? fileStore(target);
const NODES = ['plan', 'search', 'summarize'];
const ASKED = [
  'What changed in the retrieval pipeline last quarter?',
  'Summarise the three candidate designs.',
  'Which of them survives a 10x traffic increase?',
];

for (let run = 0; run < 4; run++) {
  const recorder = new Recorder({ store, log: () => {} });
  // The last run diverges at the final step, which is what a miss looks like on replay.
  const asked = run === 3 ? [...ASKED.slice(0, 2), 'And what would break first?'] : ASKED;
  asked.forEach((question, i) => {
    recorder.record({
      node: NODES[i]!,
      kind: i === 1 ? 'tool' : 'model',
      request:
        i === 1
          ? { kind: 'tool', tool_name: 'web_search', args: { query: question } }
          : { kind: 'model', provider: 'anthropic', model_id: 'claude-opus-5', messages: [{ role: 'user', content: question }] },
      response: { content: `Answer to: ${question}` },
      latency_ms: 420 + i * 130,
      tokens: 900 + i * 210,
      cost_usd: 0.004,
    });
  });
  recorder.finish({ final_state_hash: `sha256:seed-${run}` });
  console.log(`seeded ${recorder.run.run_id} — ${asked.length} steps`);
}

// Nothing has left the process until this resolves, and a drop here is silent otherwise.
if (buffered !== null) {
  await buffered.flush();
  console.log(`flushed to ${target}`);
}
