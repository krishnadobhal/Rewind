import { GitCompareArrows, Inbox } from 'lucide-react';
import type { Loadable, RunSummary, Tier } from '../api.ts';
import { Empty, Failed, Pane, Skeleton, StatusChip, TierChip } from './Primitives.tsx';
import styles from './RunList.module.css';

const ORDER: Tier[] = ['miss', 'exact', 'recorded'];

const when = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function RunList({
  runs,
  selected,
  against,
  onSelect,
  onCompare,
}: {
  runs: Loadable<RunSummary[]>;
  selected: string | null;

  against: string | null;
  onSelect: (id: string) => void;
  onCompare: (id: string) => void;
}) {
  if (runs.status === 'loading') return <Pane title="Runs"><Skeleton rows={5} /></Pane>;
  if (runs.status === 'error') return <Pane title="Runs"><Failed message={runs.message} /></Pane>;

  if (runs.data.length === 0) {
    return (
      <Pane title="Runs" count={0}>
        <Empty
          icon={Inbox}
          title="No runs recorded yet"
          hint={<>Run your agent with <code>REWIND_ENABLED=1</code> and it will appear here.</>}
        />
      </Pane>
    );
  }

  return (
    <Pane title="Runs" count={runs.data.length}>
      <ul className={styles.list} role="listbox" aria-label="Recorded runs">
        {runs.data.map((run) => (
          <li key={run.run_id} className={styles.item}>
            <button
              type="button"
              role="option"
              aria-selected={run.run_id === selected}
              className={styles.row}
              data-selected={run.run_id === selected || undefined}
              data-against={run.run_id === against || undefined}
              onClick={() => onSelect(run.run_id)}
            >
              <span className={styles.id}>{run.run_id}</span>
              <span className={styles.meta}>
                <StatusChip status={run.status} />
                <span className={styles.sep} aria-hidden>·</span>
                <span className={styles.num}>{run.steps}</span> steps
                <span className={styles.sep} aria-hidden>·</span>
                <span className={styles.num}>{when(run.started_at)}</span>
              </span>
              <span className={styles.tiers}>
                {ORDER.filter((t) => run.tiers[t]).map((t) => (
                  <TierChip key={t} tier={t} count={run.tiers[t]} />
                ))}
              </span>
            </button>

            {selected !== null && run.run_id !== selected && (
              <button
                type="button"
                className={styles.compare}
                data-on={run.run_id === against || undefined}
                onClick={() => onCompare(run.run_id)}
                title={run.run_id === against ? 'Stop comparing' : 'Compare with the open run'}
                aria-pressed={run.run_id === against}
              >
                <GitCompareArrows size={12} strokeWidth={2} aria-hidden />
                <span className={styles.srOnly}>Compare with the open run</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </Pane>
  );
}
