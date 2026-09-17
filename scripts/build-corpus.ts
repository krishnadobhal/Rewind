/**
 * Builds `bench/corpus/` — the recorded runs the determinism suite replays.
 *
 * Committed to git so the numbers are reproducible by a stranger, which is why the
 * reference agent is scripted rather than pointed at a provider (AGENTS §8: do not
 * benchmark against a live provider).
 *
 *   node scripts/build-corpus.ts
 *
 * Rebuilding is destructive and changes every hash if canonicalization moved. Run
 * `pnpm test:redaction` before committing the result — I4 is not advisory.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { HumanMessage } from '@langchain/core/messages';
import { HASH_VERSION, stateHash } from '@rewind/core/hash';
import { Recorder } from '@rewind/sdk-js/recorder';
import { fileStore } from '@rewind/sdk-js/store';
import { buildGraph, routerScript, script, webSearch } from 'deep-research-agent/graph';
import { ScriptedChatModel } from 'deep-research-agent/model';

const ROOT = 'bench/corpus';

/** One recorded run: what it was asked, and what shape it took. */
type Entry = { run_id: string; question: string; routed: boolean; steps: number; final_state_hash: string };

/**
 * The population. Both graph shapes, varied lengths.
 *
 * Deliberately PII-free. The manifest records each question verbatim so the run can be
 * replayed, and the manifest is committed — so anything unpublishable in a question is
 * unpublishable in git, redactor or no redactor. Redaction coverage comes from
 * `test/redaction`, which records real PII into a temp store instead.
 */
const QUESTIONS: { question: string; routed?: boolean }[] = [
  { question: 'How do you replay a LangGraph agent deterministically?' },
  { question: 'What did the tool call return?', routed: true },
  { question: 'Why is canonicalization a wire format?' },
  { question: 'What happens on a miss?' },
  { question: 'How is a partial run different from a failed one?', routed: true },
  { question: 'Which fields are excluded from the hash?' },
  { question: 'What does an exact match mean here?' },
  { question: 'Why are tool schemas part of a request identity?', routed: true },
  { question: 'How does redaction avoid invalidating a corpus?' },
  { question: 'What is a cassette?' },
  { question: 'Why is seq not arrival order?', routed: true },
  { question: 'What makes a run unreplayable?' },
  { question: 'How many boundaries does this agent cross?', routed: true },
  { question: 'Why does the recorder fail open?' },
  { question: 'What would a second model change here?', routed: true },
  { question: 'When is a step marked diverged?' },
  { question: 'How does the viewer read the store?', routed: true },
  { question: 'What does the deny-all fixture prove?' },
  { question: 'Why is the corpus committed to git?', routed: true },
  { question: 'What does a tier distribution tell a reader?' },
];

/** Records one run into the corpus and returns its manifest entry. */
async function record(question: string, routed: boolean, index: number): Promise<Entry> {
  // A fixed seed per slot, so rebuilding the corpus produces a reviewable diff
  // instead of twenty changed run.json files.
  const recorder = new Recorder({ store: fileStore(ROOT), log: () => {}, run: { seed: 1_000_000 + index } });
  const { graph } = await buildGraph({
    model: new ScriptedChatModel({ responses: script(), model: 'scripted-planner-1' }),
    tools: [webSearch],
    router: routed ? new ScriptedChatModel({ responses: routerScript('research'), model: 'scripted-router-1' }) : undefined,
    recorder,
  });
  const state = await graph.invoke({ messages: [new HumanMessage(question)] });
  const hash = stateHash(state);
  recorder.finish({ final_state_hash: hash, messages: state.messages.length });
  return { run_id: recorder.run.run_id, question, routed, steps: recorder.stats.steps, final_state_hash: hash };
}

rmSync(ROOT, { recursive: true, force: true }); // a rebuild replaces, never merges
mkdirSync(ROOT, { recursive: true });

const runs: Entry[] = [];
for (const [i, { question, routed }] of QUESTIONS.entries()) runs.push(await record(question, routed ?? false, i));

// The manifest is what makes a corpus reviewable in a pull request.
writeFileSync(
  `${ROOT}/manifest.json`,
  JSON.stringify({ name: 'deep-research', hash_version: HASH_VERSION, runs }, null, 2) + '\n',
);

const partial = runs.filter((r) => r.steps === 0);
console.log(`corpus: ${runs.length} runs, ${runs.reduce((n, r) => n + r.steps, 0)} steps, HASH_VERSION ${HASH_VERSION}`);
if (partial.length > 0) throw new Error(`${partial.length} runs recorded no steps`);
