import { HASH_VERSION, reqHash } from '@rewind/core/hash';
import type { RewindRequest } from '@rewind/core/request';
import type { MatchTier, Step, StepKind } from '@rewind/core/schema';
import { readCassette, readTrace, type Trace } from './store.ts';

/** What to do when no cassette matches (docs/HASHING.md §5). */
export type OnMiss = 'strict' | 'live';

/** A hit carries the recorded response; a miss carries nothing. */
export type Resolution = { hit: true; response: unknown; tier: MatchTier } | { hit: false };

/** Thrown under strict miss policy, naming the hash that did not resolve. */
export class MissError extends Error {
  node: string;
  seq: number;
  hash: string;
  // Assigned in the body, not the signature: parameter properties are not erasable.
  constructor(node: string, seq: number, hash: string) {
    super(`rewind: no cassette for ${node} at seq ${seq} (${hash.slice(0, 16)}…)`);
    this.name = 'MissError';
    this.node = node;
    this.seq = seq;
    this.hash = hash;
  }
}

export type ReplayerOptions = { root: string; runId: string; onMiss?: OnMiss };

export class Replayer {
  /** The run being replayed, for comparison at the end. */
  readonly source: Trace;
  readonly onMiss: OnMiss;
  /** Every tier is counted, including the zeroes — never inferred, never omitted (I3). */
  readonly tiers: Record<MatchTier, number> = { exact: 0, miss: 0, recorded: 0 };
  /** The trace this replay produced, which is what gets compared to `source`. */
  readonly steps: Step[] = [];
  /** First step that stopped matching the recording; null while it still does. */
  divergenceSeq: number | null = null;

  #root: string;
  #seq = 0;

  constructor(options: ReplayerOptions) {
    const source = readTrace(options.root, options.runId);
    if (source === null) throw new Error(`rewind: no run ${options.runId} in ${options.root}`);
    // A partial run dropped events, so its trace is not authoritative (I1).
    if (source.run.status === 'partial') throw new Error(`rewind: run ${options.runId} is partial and cannot be replayed`);
    // Mixing hash versions silently misses on every step, so refuse by name (I2).
    if (source.run.hash_version !== HASH_VERSION) {
      throw new Error(`rewind: run ${options.runId} was recorded under HASH_VERSION ${source.run.hash_version}, this build is ${HASH_VERSION}`);
    }
    this.source = source;
    this.#root = options.root;
    this.onMiss = options.onMiss ?? 'strict';
  }

  /** Looks a call up by hash and records which tier answered. */
  resolve(node: string, kind: StepKind, request: RewindRequest): Resolution {
    const hash = reqHash(request);
    const seq = this.#seq++; // claimed whether we hit or miss, so seq stays dense
    const cassette = readCassette(this.#root, hash);

    if (cassette === null) {
      this.#step(seq, node, kind, hash, 'miss', null);
      return { hit: false };
    }
    this.#step(seq, node, kind, hash, 'exact', hash);
    return { hit: true, response: JSON.parse(cassette.response) as unknown, tier: 'exact' };
  }

  /** True when every step resolved from a cassette. */
  get faithful(): boolean {
    return this.tiers.miss === 0;
  }


  get reproduced(): boolean {
    return this.divergenceSeq === null && this.steps.length === this.source.steps.length;
  }

  settle(): void {
    // Exit 2 is "gate failed" per docs/RECORDING.md.
    if (!this.reproduced) process.exitCode = 2;
  }

  /** Settles once, whenever the process ends, however it ends. */
  onExit(): void {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      this.settle();
    };
    process.on('beforeExit', once);
    process.on('exit', once);
  }

  #step(seq: number, node: string, kind: StepKind, hash: string, tier: MatchTier, ref: string | null): void {
    this.tiers[tier]++;

    if (tier === 'miss' || this.source.steps[seq]?.req_hash !== hash) this.divergenceSeq ??= seq;
    this.steps.push({
      run_id: this.source.run.run_id,
      seq,
      node,
      kind,
      req_hash: hash,
      cassette_ref: ref,
      match_tier: tier,
      // Replay takes no real time and spends no real money; the recorded values are
      // on the source step and must not be copied here as if they happened again.
      latency_ms: 0,
      tokens: null,
      cost_usd: null,
      error: null,
    });
  }
}
