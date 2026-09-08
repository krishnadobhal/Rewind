/**
 * Entry point for the reference workload.
 *
 *   rewind record -- pnpm -F deep-research-agent start          one model
 *   rewind record -- pnpm -F deep-research-agent start:multi    two models
 *
 * Nothing here knows about recording. `buildGraph` instruments the models and tools
 * it was handed; outside `rewind record` that is a no-op and `recorder` is null, so
 * the same file ships to production.
 */
import { HumanMessage } from '@langchain/core/messages';
import { stateHash } from '@rewind/core/hash';
import { buildGraph, routerScript, script, webSearch } from './graph.ts';
import { ScriptedChatModel } from './model.ts';

const routed = process.argv.includes('--multi-model');
const question = process.argv.find((a) => !a.startsWith('--') && a.endsWith('?')) ?? 'How do you replay a LangGraph agent deterministically?';

// Raw models in, instrumented graph out — there is no wrapped/unwrapped pair to
// mismatch, and no second call that could open a rival run.
const { graph, recorder, replayer } = await buildGraph({
  model: new ScriptedChatModel({ responses: script(), model: 'scripted-planner-1' }),
  tools: [webSearch],
  // Cheap router, expensive planner. model_id is part of a request's identity, so
  // these two never share a cassette even on an identical prompt.
  router: routed ? new ScriptedChatModel({ responses: routerScript('research'), model: 'scripted-router-1' }) : undefined,
});

const finalState = await graph.invoke({ messages: [new HumanMessage(question)] });

// Canonical, not JSON.stringify: key order must not look like a changed outcome, and
// LangChain stamps a random UUID on every message that would otherwise land in here.
const finalStateHash = stateHash(finalState);
recorder?.finish({ final_state_hash: finalStateHash, messages: finalState.messages.length });

// Replaying: say whether the run reproduced, and exit 2 if it did no.
if (replayer) {
  const verdict = replayer.verdict(finalStateHash);
  const tiers = Object.entries(replayer.tiers).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`);
  console.log(`# replay of ${replayer.source.run.run_id}: ${verdict} · ${tiers.join(' · ')}`);
  if (verdict !== 'match') process.exitCode = 2;
}

console.log(routed ? '# two models: router + planner' : '# one model: planner');
for (const message of finalState.messages) {
  const role = message.getType().padEnd(9);
  const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  console.log(`${role} ${text || '(tool call)'}`);
}
