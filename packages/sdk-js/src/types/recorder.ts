import type { RewindRequest } from '@rewind/core/request';
import type { Run, StepKind } from '@rewind/core/schema';
import type { RedactConfig } from './redact.ts';
import type { Store } from './store.ts';

/** One boundary crossing, as the SDK observes it. */
export type Observation = {
  node: string;
  kind: StepKind;
  request: RewindRequest;
  response: unknown;
  latency_ms: number;
  tokens?: number;
  cost_usd?: number;
  error?: unknown;
  provider?: string;
  model_version?: string;
};

export type RecorderOptions = {
  store: Store;
  redact?: RedactConfig;
  run?: Partial<Run>;
  log?: (message: string, error: unknown) => void;
};
