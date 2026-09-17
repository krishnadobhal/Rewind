import type { Cassette, Run, Step } from '@rewind/core/schema';
import { fileStore, listRuns, readCassette, readTrace, type Trace } from '@rewind/sdk-js/store';
import type { IngestStore, StepHit, StepQuery } from './ingest.ts';

/** An IngestStore backed by a cassette directory. */
export function fileIngestStore(root: string): IngestStore {
  // The writer is the same one the SDK uses locally, so a run recorded through the
  // API and one recorded straight to disk are byte-identical.
  const store = fileStore(root);

  return {
    // Synchronous underneath; the async shape is the interface, not the cost.
    async putRun(run: Run) {
      store.putRun(run);
    },
    async appendStep(step: Step) {
      store.appendStep(step);
    },
    async putCassette(cassette: Cassette) {
      store.putCassette(cassette);
    },

    async readTrace(runId: string): Promise<Trace | null> {
      return readTrace(root, runId);
    },
    async listRuns(): Promise<string[]> {
      return listRuns(root);
    },
    async readCassette(hash: string): Promise<Cassette | null> {
      return readCassette(root, hash);
    },

    async findSteps(query: StepQuery): Promise<StepHit[]> {
      if (query.hash === undefined && query.node === undefined && query.kind === undefined) return [];
      const hits: StepHit[] = [];
      for (const id of listRuns(root)) {
        const trace = readTrace(root, id);
        if (trace === null) continue;
        for (const step of trace.steps) {
          if (query.hash !== undefined && step.req_hash !== query.hash) continue;
          if (query.node !== undefined && step.node !== query.node) continue;
          if (query.kind !== undefined && step.kind !== query.kind) continue;
          hits.push({
            run_id: step.run_id,
            seq: step.seq,
            node: step.node,
            kind: step.kind,
            req_hash: step.req_hash,
            match_tier: step.match_tier,
            started_at: trace.run.started_at,
            status: trace.run.status,
          });
        }
      }
      // Newest run first, matching what the list pane shows.
      hits.sort((a, b) => (a.started_at === b.started_at ? a.seq - b.seq : b.started_at.localeCompare(a.started_at)));
      return hits.slice(0, Math.min(query.limit ?? 50, 200));
    },

  };
}
