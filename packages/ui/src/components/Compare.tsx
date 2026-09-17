/**
 * Two runs side by side, aligned by seq.
 *
 * This is the question the project exists to answer, asked by hand: two recordings,
 * where did they stop agreeing? Everything above `divergesAt` is identical by hash and
 * needs no reading; the first row that is not `same` is the whole finding.
 */
import { ArrowLeftRight, Check, GitCompareArrows, Minus, Plus, X } from 'lucide-react';
import type { Loadable, Trace } from '../api.ts';
import { compare, type Change, type Row } from '../compare.ts';
import { Empty, Failed, Pane, Skeleton } from './Primitives.tsx';
import styles from './Compare.module.css';

const MARK: Record<Change, typeof Check> = {
  same: Check,
  changed: ArrowLeftRight,
  removed: Minus,
  added: Plus,
};

export function Compare({
  left,
  right,
  onClose,
  onPickStep,
}: {
  left: Loadable<Trace>;
  right: Loadable<Trace>;
  onClose: () => void;
  onPickStep: (seq: number) => void;
}) {
  const loading = left.status === 'loading' || right.status === 'loading';
  const failed = left.status === 'error' ? left : right.status === 'error' ? right : null;

  return (
    <Pane
      title="Compare"
      count={
        <button type="button" className={styles.close} onClick={onClose} aria-label="Stop comparing">
          <X size={12} strokeWidth={2.5} aria-hidden />
        </button>
      }
    >
      {loading ? (
        <Skeleton rows={4} />
      ) : failed !== null ? (
        <Failed message={failed.message} />
      ) : (
        <Body left={(left as { data: Trace }).data} right={(right as { data: Trace }).data} onPickStep={onPickStep} />
      )}
    </Pane>
  );
}

function Body({ left, right, onPickStep }: { left: Trace; right: Trace; onPickStep: (seq: number) => void }) {
  const { rows, divergesAt, counts } = compare(left, right);

  return (
    <div className={styles.body}>
      <p className={divergesAt === null ? styles.matches : styles.differs}>
        <GitCompareArrows size={14} strokeWidth={2} aria-hidden />
        {divergesAt === null ? (
          <span>
            <strong>Identical.</strong> All {counts.same} steps match by request hash.
          </span>
        ) : (
          <span>
            <strong>First difference at step {divergesAt}.</strong> {counts.same} matched before it.
          </span>
        )}
      </p>

      <div className={styles.heads}>
        <span className={styles.headId}>{left.run.run_id.slice(0, 12)}…</span>
        <span className={styles.headId}>{right.run.run_id.slice(0, 12)}…</span>
      </div>

      <ol className={styles.rows}>
        {rows.map((row) => (
          <RowView key={row.seq} row={row} diverged={divergesAt !== null && row.seq === divergesAt} onPick={onPickStep} />
        ))}
      </ol>
    </div>
  );
}

function RowView({ row, diverged, onPick }: { row: Row; diverged: boolean; onPick: (seq: number) => void }) {
  const Mark = MARK[row.change];
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        data-change={row.change}
        data-diverged={diverged || undefined}
        onClick={() => onPick(row.seq)}
        // Everything before the first difference is identical by hash; the one that
        // matters gets said out loud rather than left to the colour.
        aria-label={`Step ${row.seq}: ${row.change}${diverged ? ', first difference' : ''}`}
      >
        <span className={styles.seq}>{row.seq}</span>
        <span className={styles.mark} aria-hidden><Mark size={11} strokeWidth={2.5} /></span>
        <Side step={row.left} />
        <Side step={row.right} />
      </button>
    </li>
  );
}

/** One run's step at this position, or a gap where it has none. */
function Side({ step }: { step: Row['left'] }) {
  if (step === null) return <span className={styles.gap} aria-label="no step">—</span>;
  return (
    <span className={styles.side}>
      <span className={styles.node}>{step.node}</span>
      <span className={styles.hash}>{step.req_hash.slice(0, 8)}</span>
    </span>
  );
}
