import type { Cassette, Run, Step } from '@rewind/core/schema';

/** Two lifetimes: a run and its steps belong to one run, cassettes are shared. */
export type Store = {
  putRun(run: Run): void;
  appendStep(step: Step): void;
  putCassette(cassette: Cassette): void;
};
