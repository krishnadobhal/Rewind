/**
 * The recorder runs inside the user's production agent. It fails open, always (I1):
 * a full disk, a serialization bug, a store outage — none of these may throw into the
 * user's graph. Errors are counted, logged once a minute, and the run continues
 * unrecorded and marked `partial`.
 */
import { HASH_VERSION, reqHash } from '@rewind/core/hash';
import type { RewindRequest } from '@rewind/core/request';
import type { Cassette, Run, Step, StepKind } from '@rewind/core/schema';
import { redact, type RedactConfig } from './redact.ts';
import type { Store } from './store.ts';
import { ulid } from './ulid.ts';

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
  /** Injectable so tests can assert on the log instead of scraping stderr. */
  log?: (message: string, error: unknown) => void;
};

const LOG_INTERVAL_MS = 60_000;

export class Recorder {
  readonly run: Run;
  readonly stats = { dropped: 0, steps: 0 };

  #store: Store;
  #redact: RedactConfig;
  #log: (message: string, error: unknown) => void;
  #lastLoggedAt = 0;
  #seq = 0;

  constructor(options: RecorderOptions) {
    this.#store = options.store;
    this.#redact = options.redact ?? {};
    this.#log = options.log ?? ((m, e) => console.warn(`[rewind] ${m}`, e));
    this.run = {
      run_id: ulid(),
      thread_id: '',
      graph_sha: '',
      code_sha: '',
      prompt_sha: '',
      model_cfg: {},
      seed: Math.floor(Math.random() * 2 ** 48),
      flags_snapshot: {},
      hash_version: HASH_VERSION,
      started_at: new Date().toISOString(),
      ended_at: null,
      status: 'complete',
      outcome: null,
      tokens: 0,
      cost_usd: 0,
      latency_ms: 0,
      ...options.run,
    };
    this.#guard('putRun', () => this.#store.putRun(this.run));
  }

  /** Record one boundary crossing. Never throws. */
  record(observation: Observation): void {
    this.#guard('record', () => {
      // Hash the plaintext canonical form; store the redacted body. A digest of a
      // secret is not the secret, and this keeps req_hash stable when the redaction
      // config changes — otherwise editing a matcher would invalidate the corpus.
      const hash = reqHash(observation.request);
      const seq = this.#seq++;
      const safe = redact({ request: observation.request, response: observation.response }, this.#redact);
      const body = safe.value as { request: unknown; response: unknown };

      const cassette: Cassette = {
        hash,
        hash_version: HASH_VERSION,
        kind: observation.kind,
        // ponytail: blobs inline, not an s3:// ref. Externalize when a cassette
        // outgrows a file read, which --max-cassette-mb already caps at 8.
        request: JSON.stringify(body.request),
        response: JSON.stringify(body.response),
        chunks: null,
        provider: observation.provider ?? null,
        model_version: observation.model_version ?? null,
        redaction_map: safe.map,
        refcount: 1,
        recorded_at: new Date().toISOString(),
      };
      this.#store.putCassette(cassette);

      const step: Step = {
        run_id: this.run.run_id,
        // ponytail: arrival order. The deterministic scheduler owns `seq` from M1 (B6);
        // until it exists there is nothing else to assign it.
        seq,
        node: observation.node,
        kind: observation.kind,
        req_hash: hash,
        cassette_ref: hash,
        match_tier: 'recorded',
        latency_ms: observation.latency_ms,
        tokens: observation.tokens ?? null,
        cost_usd: observation.cost_usd ?? null,
        error: observation.error ?? null,
      };
      this.#store.appendStep(step);

      this.stats.steps++;
      this.run.tokens += observation.tokens ?? 0;
      this.run.cost_usd += observation.cost_usd ?? 0;
      this.run.latency_ms += observation.latency_ms;
    });
  }

  /** Close the run out. Never throws. */
  finish(outcome: Run['outcome'], status: Run['status'] = 'complete'): void {
    this.run.ended_at = new Date().toISOString();
    this.run.outcome = outcome;
    // A dropped event means the recording is incomplete, and an incomplete recording is
    // never a replay source. The caller's own status cannot override that.
    this.run.status = this.stats.dropped > 0 ? 'partial' : status;
    this.#guard('finish', () => this.#store.putRun(this.run));
  }

  #guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.stats.dropped++;
      this.run.status = 'partial';
      const now = Date.now();
      if (now - this.#lastLoggedAt >= LOG_INTERVAL_MS) {
        this.#lastLoggedAt = now;
        this.#log(`${what} failed; run ${this.run.run_id} is partial (${this.stats.dropped} dropped)`, error);
      }
    }
  }
}
