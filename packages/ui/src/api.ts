/**
 * The viewer's read side.
 *
 * It talks to the ingest server's `/v1/*` routes — the same ones the SDK writes to.
 * The viewer has no backend of its own, so there is no second implementation of these
 * four endpoints to drift from the first.
 */
import { useEffect, useState } from 'react';

export type Tier = 'exact' | 'miss' | 'recorded';

export type RunSummary = {
  run_id: string;
  status: 'complete' | 'partial' | 'error';
  steps: number;
  tokens: number;
  cost_usd: number;
  latency_ms: number;
  started_at: string;
  tiers: Partial<Record<Tier, number>>;
};

export type Step = {
  run_id: string;
  seq: number;
  node: string;
  kind: string;
  req_hash: string;
  cassette_ref: string | null;
  match_tier: Tier;
  latency_ms: number;
  tokens: number | null;
  cost_usd: number | null;
  error: unknown;
};

/** Where else a call happened: one row per occurrence, newest run first. */
export type StepHit = {
  run_id: string;
  seq: number;
  node: string;
  kind: string;
  req_hash: string;
  match_tier: Tier;
  started_at: string;
  status: string;
};

export type Trace = {
  run: RunSummary & { hash_version: number; ended_at: string | null; outcome: unknown };
  steps: Step[];
};

export type Cassette = {
  hash: string;
  kind: string;
  request: string;
  response: string;
  provider: string | null;
  model_version: string | null;
  redaction_map: Record<string, string>;
  recorded_at: string;
};

/** GETs one route, turning a failure into a message worth showing. */
async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  // 404 on a replay route means "never replayed", which callers treat as absence.
  if (response.status === 404) throw new Error('Not found');
  // A 401 here means the server wants a token the dev proxy is not sending; say that
  // rather than "failed to fetch", which sends you debugging the network.
  if (response.status === 401) throw new Error('The server requires a token');
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export type Loadable<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; message: string };

/**
 * Loads a path, and reloads when it changes.
 *
 * Every pane needs the same three states, so they are modelled once rather than as
 * three booleans per component — a loading flag and a data field can disagree.
 */
export function useResource<T>(path: string | null): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });

  useEffect(() => {
    if (path === null) return;
    let live = true; // a fast click must not let a stale response win
    setState({ status: 'loading' });
    get<T>(path)
      .then((data) => live && setState({ status: 'ready', data }))
      .catch((error: Error) => live && setState({ status: 'error', message: error.message }));
    return () => {
      live = false;
    };
  }, [path]);

  return state;
}
