import type { Cassette, Run, Step } from '@rewind/core/schema';
import type { AsyncStore, BatchWrite } from './emitter.ts';

export type HttpStoreOptions = {
  /** Base URL of the ingest server */
  url: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** An AsyncStore that POSTs batches to an ingest server. */
export function httpStore(options: HttpStoreOptions): AsyncStore {
  const { url, token, timeoutMs = 10_000 } = options;
  const send = options.fetchImpl ?? globalThis.fetch;
  const endpoint = `${url.replace(/\/$/, '')}/v1/ingest`;

  /** POSTs one batch, throwing on anything but success. */
  const post = async (writes: BatchWrite[]): Promise<void> => {
    // A hung server would otherwise hold the queue open until the process ends.
    const abort = AbortSignal.timeout(timeoutMs);
    const response = await send(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ writes }),
      signal: abort,
    });
    
    if (!response.ok) throw new Error(`ingest ${response.status} ${response.statusText}`);
  };

  return {
    // The batch path is the one that runs; these three exist so the store still
    // satisfies AsyncStore for a caller that bypasses the emitter.
    putRun: (run: Run) => post([{ kind: 'run', run }]),
    appendStep: (step: Step) => post([{ kind: 'step', step }]),
    putCassette: (cassette: Cassette) => post([{ kind: 'cassette', cassette }]),
    putBatch: post,
  };
}
