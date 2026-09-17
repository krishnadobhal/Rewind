
import type { Cassette, Run, Step } from '@krishnadobhal/rewind-core/schema';
import type { Store } from './store.ts';

/** One queued write, in the shape the wire carries it. */
export type BatchWrite =
  | { kind: 'run'; run: Run }
  | { kind: 'step'; step: Step }
  | { kind: 'cassette'; cassette: Cassette };

/** A store that writes somewhere slow — Postgres, an ingest API, S3. */
export type AsyncStore = {
  putRun(run: Run): Promise<void>;
  appendStep(step: Step): Promise<void>;
  putCassette(cassette: Cassette): Promise<void>;
  putBatch?(writes: BatchWrite[]): Promise<void>;
};

export type EmitterOptions = {
  target: AsyncStore;
  /** Writes held before the newest are dropped. */
  maxQueue?: number;
  /** Writes sent in one call, when the target can take a batch. */
  maxBatch?: number;
  /** How long a write waits for company before the batch goes. */
  batchMs?: number;
  log?: (message: string, error: unknown) => void;
};

export type FlushResult = { written: number; dropped: number; pending: number };

/** Sends one write through the target's individual methods. */
function sendOne(target: AsyncStore, write: BatchWrite): Promise<void> {
  if (write.kind === 'run') return target.putRun(write.run);
  if (write.kind === 'step') return target.appendStep(write.step);
  return target.putCassette(write.cassette);
}

/** A Store that queues writes and drains them to a slow target. */
export function bufferedStore(options: EmitterOptions): Store & {
  flush: () => Promise<FlushResult>;
  stats: { written: number; dropped: number; queued: number };
} {
  const { target, maxQueue = 1000, maxBatch = 100, batchMs = 250 } = options;
  const log = options.log ?? ((m, e) => console.warn(`[rewind] ${m}`, e));
  const queue: BatchWrite[] = [];
  const stats = { written: 0, dropped: 0, queued: 0 };

  let draining: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastLoggedAt = 0;

  /** Counts losses and says so at most once a minute. */
  const drop = (count: number, why: string, error: unknown): void => {
    stats.dropped += count;
    const now = Date.now();
    if (now - lastLoggedAt < 60_000) return;
    lastLoggedAt = now;
    log(`${why} (${stats.dropped} dropped)`, error);
  };

  /** Sends queued writes in order, batching when the target allows. */
  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      // Splice, not slice: a batch that fails is gone, not retried forever.
      const batch = queue.splice(0, maxBatch);
      stats.queued = queue.length;

      if (target.putBatch) {
        try {
          await target.putBatch(batch);
          stats.written += batch.length;
        } catch (error) {
          // One request carried all of them, so all of them were lost (I1).
          drop(batch.length, `${batch.length} writes failed`, error);
        }
        continue;
      }

      // No batch support: one at a time, in order, each guarded on its own. A single
      // bad write must not take the rest of the batch with it — that is a property
      // the local store had before batching existed.
      for (const write of batch) {
        try {
          await sendOne(target, write);
          stats.written++;
        } catch (error) {
          drop(1, `${write.kind} write failed`, error);
        }
      }
    }
  };

  /** Starts a drain if one is not already running. */
  const schedule = (): void => {
    if (timer !== null || draining !== null) return;
    // Steps arrive in bursts; a short wait lets a whole node's worth queue up.
    timer = setTimeout(() => {
      timer = null;
      draining = drain().finally(() => {
        draining = null;
        if (queue.length > 0) schedule(); // more arrived while we were away
      });
    }, batchMs);
    timer.unref?.(); // never hold the process open on our account
  };

  /** Queues a write, or drops it if the queue is full. */
  const push = (write: BatchWrite): void => {
    if (queue.length >= maxQueue) {
      // Drop the newest, not the oldest: the start of a run explains more than its end.
      drop(1, `queue full at ${maxQueue}`, new Error('emitter backpressure'));
      return;
    }
    queue.push(write);
    stats.queued = queue.length;
    schedule();
  };

  return {
    stats,
    putRun: (run) => push({ kind: 'run', run }),
    appendStep: (step) => push({ kind: 'step', step }),
    putCassette: (cassette) => push({ kind: 'cassette', cassette }),
    
    async flush(): Promise<FlushResult> {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await draining; // let an in-flight drain finish before starting another
      await drain();
      return { written: stats.written, dropped: stats.dropped, pending: queue.length };
    },
  };
}
