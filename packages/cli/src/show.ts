/**
 * `rewind show <run_id>` — the M0 gate's inspector. A recorded run must be readable
 * without a server, a UI, or a replay, or there is no way to tell recording worked.
 */
import { readTrace } from '@rewind/sdk-js/store';

/** Prints one run's trace as JSON or a table. */
export function show(root: string, runId: string, asJson: boolean): number {
  const trace = readTrace(root, runId);
  if (trace === null) {
    console.error(`rewind: no run ${runId} in ${root}`);
    return 1; // exit 1 is usage/config per CLI.md
  }
  if (asJson) {
    // Shape is `{run, steps}` so `jq '.steps[]'` works as documented.
    console.log(JSON.stringify(trace, null, 2));
    return 0;
  }

  const { run, steps } = trace;
  const cost = run.cost_usd.toFixed(4); // 4dp, sub-cent calls are normal
  console.log(`${run.run_id}  ${run.status}  ${steps.length} steps  ${run.tokens} tokens  $${cost}  ${run.latency_ms}ms`);
  if (run.status === 'partial') {
    // Loud, because a partial run is never a valid replay source.
    console.log('  ! partial — events were dropped; not usable as a replay source');
  }
  console.log('');
  console.log('  seq  node                 kind    tier      req_hash          latency');
  for (const step of steps) {
    const seq = String(step.seq).padStart(5);
    const node = step.node.slice(0, 20).padEnd(20); // truncate, keep columns aligned
    const kind = step.kind.padEnd(7);
    const tier = step.match_tier.padEnd(9); // always shown, never inferred (I3)
    const hash = step.req_hash.slice(0, 16); // 16 hex is plenty to eyeball
    console.log(`${seq}  ${node} ${kind} ${tier} ${hash}  ${String(step.latency_ms).padStart(6)}ms`);
  }
  return 0;
}
