/**
 * Authoritative vocabulary. Names follow docs/DATA_MODEL.md exactly.
 * No I/O, no network, no filesystem in this package.
 */

export const STEP_KINDS = ['model', 'tool', 'clock', 'rng', 'human', 'env'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const MATCH_TIERS = ['exact', 'miss', 'recorded'] as const;
export type MatchTier = (typeof MATCH_TIERS)[number];

export type RunStatus = 'complete' | 'partial' | 'error';

/** One execution of one graph, entry to terminal state. */
export type Run = {
  run_id: string;
  thread_id: string;
  graph_sha: string;
  code_sha: string;
  prompt_sha: string;
  model_cfg: Record<string, unknown>;
  /** Bigint in the DDL, number here — generate seeds below 2^53 or this lies. */
  seed: number;
  flags_snapshot: Record<string, string>;
  hash_version: number;
  started_at: string;
  ended_at: string | null;
  status: RunStatus;
  outcome: { final_state_hash: string; [k: string]: unknown } | null;
  tokens: number;
  cost_usd: number;
  latency_ms: number;
};

/** One boundary crossing. Append-only, ordered by `seq` within a run. */
export type Step = {
  run_id: string;
  /** Assigned by the deterministic scheduler, not by arrival order (B6). */
  seq: number;
  node: string;
  kind: StepKind;
  req_hash: string;
  /** = req_hash for recorded steps; null for replayed-from-shim. */
  cassette_ref: string | null;
  /** Never inferred, never omitted, never defaulted. */
  match_tier: MatchTier;
  latency_ms: number;
  tokens: number | null;
  cost_usd: number | null;
  error: unknown | null;
};

/** The recorded observation. Immutable, content-addressed, refcounted. */
export type Cassette = {
  hash: string;
  hash_version: number;
  kind: StepKind;
  request: string;
  response: string;
  chunks: string | null;
  provider: string | null;
  model_version: string | null;
  /** Written in the user's process, before the event leaves it. */
  redaction_map: Record<string, string>;
  refcount: number;
  recorded_at: string;
};
