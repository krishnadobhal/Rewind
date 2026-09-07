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
import { createHash } from 'node:crypto';
import { HumanMessage } from '@langchain/core/messages';
import { buildGraph, routerScript, script, webSearch } from './graph.ts';
import { ScriptedChatModel } from './model.ts';

const routed = process.argv.includes('--multi-model');
const question = process.argv.find((a) => !a.startsWith('--') && a.endsWith('?')) ?? 'How do you replay a LangGraph agent deterministically?';

// Raw models in, instrumented graph out — there is no wrapped/unwrapped pair to
// mismatch, and no second call that could open a rival run.
const { graph, recorder } = await buildGraph({
  model: new ScriptedChatModel({ responses: script(), model: 'scripted-planner-1' }),
  tools: [webSearch],
  // Cheap router, expensive planner. model_id is part of a request's identity, so
  // these two never share a cassette even on an identical prompt.
  router: routed ? new ScriptedChatModel({ responses: routerScript('research'), model: 'scripted-router-1' }) : undefined,
});

const finalState = await graph.invoke({ messages: [new HumanMessage(question)] });

// ponytail: JSON digest of the final state. M1 needs a canonical one that survives
// key reordering — reuse core's canonicalize then, and bump nothing here until it does.
const finalStateHash = `sha256:${createHash('sha256').update(JSON.stringify(finalState)).digest('hex')}`;
recorder?.finish({ final_state_hash: finalStateHash, messages: finalState.messages.length });

console.log(routed ? '# two models: router + planner' : '# one model: planner');
for (const message of finalState.messages) {
  const role = message.getType().padEnd(9);
  const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  console.log(`${role} ${text || '(tool call)'}`);
}
