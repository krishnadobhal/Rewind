/**
 * Runs inside the user's production agent and fails open : a store outage, a full
 * disk, a serialization bug — none of them throw into the graph. The run goes `partial`.
 */
import { HASH_VERSION, reqHash } from '@rewind/core/hash';
import type { Cassette, Run, Step } from '@rewind/core/schema';
import { redact } from './redact.ts';
import type { Observation, RecorderOptions } from './types/recorder.ts';
import type { RedactConfig } from './types/redact.ts';
import type { Store } from './types/store.ts';
import { ulid } from './ulid.ts';

export type { Observation, RecorderOptions } from './types/recorder.ts';

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
    // Written before the first step, so a process that dies mid-run still leaves an
    // inspectable trace instead of orphaned steps.
    this.#guard('putRun', () => this.#store.putRun(this.run));
  }

  /**
   * Record one boundary crossing. Never throws.
   * hash → redact → write cassette → append step → roll up totals.
   */
  record(observation: Observation): void {
    this.#guard('record', () => {
      // Hashed before redaction: a digest of a secret is not the secret, and it keeps
      // req_hash stable when the redaction config changes.
      const hash = reqHash(observation.request);
      const seq = this.#seq++;
      const safe = redact({ request: observation.request, response: observation.response }, this.#redact);
      const body = safe.value as { request: unknown; response: unknown };

      const cassette: Cassette = {
        hash,
        hash_version: HASH_VERSION,
        kind: observation.kind,
        // Inline, not an s3:// ref — externalize when these outgrow a single file read.
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
        // Arrival order until the deterministic scheduler owns `seq` (B6).
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
    // An incomplete recording is never a replay source; the caller cannot override that.
    this.run.status = this.stats.dropped > 0 ? 'partial' : status;
    this.#guard('finish', () => this.#store.putRun(this.run));
  }

  /** The one place a store failure may land: count it, degrade the run, carry on. */
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
