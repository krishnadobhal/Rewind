/**
 * Aligning two recorded runs, step by step.
 *
 * Two runs of the same agent cross the same boundaries in the same order until
 * something changes. `req_hash` is what makes this cheap: it is the canonical identity
 * of a call, so equal hashes mean the same call and nothing needs re-reading to know it.
 *
 * Alignment is by position, not by hash. A run that inserts a step shifts everything
 * after it, and that shift is the finding — collapsing it away would hide where the two
 * runs actually parted.
 */
import type { Step, Trace } from './api.ts';

export type Change =
  /** Same call, same position. */
  | 'same'
  /** Same position, different request — this is where they parted. */
  | 'changed'
  /** Present in the left run only. */
  | 'removed'
  /** Present in the right run only. */
  | 'added';

export type Row = { seq: number; left: Step | null; right: Step | null; change: Change };

export type Comparison = {
  rows: Row[];
  /** First row that is not `same`, or null when the two runs agree throughout. */
  divergesAt: number | null;
  counts: Record<Change, number>;
};

/** Pairs two traces by seq and says how each position differs. */
export function compare(left: Trace, right: Trace): Comparison {
  const length = Math.max(left.steps.length, right.steps.length);
  const rows: Row[] = [];
  const counts: Record<Change, number> = { same: 0, changed: 0, removed: 0, added: 0 };

  for (let seq = 0; seq < length; seq++) {
    const a = left.steps[seq] ?? null;
    const b = right.steps[seq] ?? null;
    // One side ran out: the runs are different lengths from here on.
    const change: Change =
      a === null ? 'added' : b === null ? 'removed' : a.req_hash === b.req_hash ? 'same' : 'changed';
    counts[change]++;
    rows.push({ seq, left: a, right: b, change });
  }

  const diverged = rows.find((row) => row.change !== 'same');
  return { rows, divergesAt: diverged?.seq ?? null, counts };
}

/**
 * Which fields of two requests differ.
 *
 * The hash says *that* two calls differ; this says *what* differs, which is the
 * question anyone actually has. Compares one level deep — the top-level keys of a
 * canonical request are provider, model_id, messages, tool_schemas and the sampling
 * params, and that is the granularity a person reads at.
 */
export function differingFields(a: unknown, b: unknown): string[] {
  const left = (a ?? {}) as Record<string, unknown>;
  const right = (b ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const differs: string[] = [];
  for (const key of keys) {
    // Structural equality by serialisation: these came from JSON and go back to it.
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) differs.push(key);
  }
  return differs.sort();
}
