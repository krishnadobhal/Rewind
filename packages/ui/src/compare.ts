import type { Step, Trace } from './api.ts';

export type Change =

  | 'same'

  | 'changed'

  | 'removed'

  | 'added';

export type Row = { seq: number; left: Step | null; right: Step | null; change: Change };

export type Comparison = {
  rows: Row[];

  divergesAt: number | null;
  counts: Record<Change, number>;
};

export function compare(left: Trace, right: Trace): Comparison {
  const length = Math.max(left.steps.length, right.steps.length);
  const rows: Row[] = [];
  const counts: Record<Change, number> = { same: 0, changed: 0, removed: 0, added: 0 };

  for (let seq = 0; seq < length; seq++) {
    const a = left.steps[seq] ?? null;
    const b = right.steps[seq] ?? null;

    const change: Change =
      a === null ? 'added' : b === null ? 'removed' : a.req_hash === b.req_hash ? 'same' : 'changed';
    counts[change]++;
    rows.push({ seq, left: a, right: b, change });
  }

  const diverged = rows.find((row) => row.change !== 'same');
  return { rows, divergesAt: diverged?.seq ?? null, counts };
}

export function differingFields(a: unknown, b: unknown): string[] {
  const left = (a ?? {}) as Record<string, unknown>;
  const right = (b ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const differs: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) differs.push(key);
  }
  return differs.sort();
}
