/**
 * One run's boundary crossings, in `seq` order.
 *
 * The rail down the left is the run: each step is a node on it, and the kind icon says
 * what the agent reached for. A `partial` run gets a banner rather than a chip, because
 * it is not merely a status — such a run can never be replayed.
 */
import { AlertTriangle, Brain, Clock, Dice5, Hand, Terminal, Variable, type LucideIcon } from 'lucide-react';
import type { Loadable, Trace } from '../api.ts';
import { Empty, Failed, Pane, Skeleton, TierChip } from './Primitives.tsx';
import styles from './Timeline.module.css';

/** A drawn icon per boundary kind — never an emoji standing in for one. */
const ICON: Record<string, LucideIcon> = {
  model: Brain,
  tool: Terminal,
  clock: Clock,
  rng: Dice5,
  human: Hand,
  env: Variable,
};

export function Timeline({
  trace,
  selected,
  onSelect,
}: {
  trace: Loadable<Trace> | null;
  selected: number | null;
  onSelect: (seq: number) => void;
}) {
  if (trace === null) {
    return (
      <Pane title="Steps">
        <Empty icon={Brain} title="Pick a run" hint="Its boundary crossings appear here, in order." />
      </Pane>
    );
  }
  if (trace.status === 'loading') return <Pane title="Steps"><Skeleton rows={4} /></Pane>;
  if (trace.status === 'error') return <Pane title="Steps"><Failed message={trace.message} /></Pane>;

  const { run } = trace.data;
  const steps = trace.data.steps;

  return (
    <Pane title="Steps" count={steps.length}>
      {run.status === 'partial' && (
        <p className={styles.partial}>
          <AlertTriangle size={14} strokeWidth={2} aria-hidden />
          <span>
            <strong>Events were dropped.</strong> This run cannot be used as a replay source.
          </span>
        </p>
      )}

      {steps.length === 0 ? (
        <Empty icon={Brain} title="No steps recorded" hint="The agent finished without crossing a boundary." />
      ) : (
        <ol className={styles.rail} role="listbox" aria-label="Steps">
          {steps.map((step) => {
            const Icon = ICON[step.kind] ?? Brain;
            return (
              <li key={step.seq}>
                <button
                  type="button"
                  role="option"
                  aria-selected={step.seq === selected}
                  className={styles.step}
                  data-selected={step.seq === selected || undefined}
                  data-miss={step.match_tier === 'miss' || undefined}
                  onClick={() => onSelect(step.seq)}
                >
                  <span className={styles.marker} aria-hidden>
                    <Icon size={13} strokeWidth={1.75} />
                  </span>
                  <span className={styles.body}>
                    <span className={styles.top}>
                      <span className={styles.seq}>{step.seq}</span>
                      <span className={styles.node}>{step.node}</span>
                      <span className={styles.kind}>{step.kind}</span>
                    </span>
                    <span className={styles.bottom}>
                      <TierChip tier={step.match_tier} />
                      <span className={styles.hash}>{step.req_hash.slice(0, 12)}</span>
                      {step.latency_ms > 0 && <span className={styles.latency}>{step.latency_ms}ms</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </Pane>
  );
}
