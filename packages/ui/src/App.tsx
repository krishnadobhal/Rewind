/**
 * Three panes, left to right: choose a run, choose a step, read what it sent and got.
 * Pick a second run and the middle pane becomes a comparison instead.
 *
 * Selection is the whole state of this app — three ids. Nothing here needs a store,
 * and a store would be more machinery than the thing it manages.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Rewind } from 'lucide-react';
import { useResource, type RunSummary, type Trace } from './api.ts';
import { Compare } from './components/Compare.tsx';
import { RunList } from './components/RunList.tsx';
import { StepDetail } from './components/StepDetail.tsx';
import { Timeline } from './components/Timeline.tsx';
import styles from './App.module.css';

export function App() {
  const [runId, setRunId] = useState<string | null>(null);
  const [againstId, setAgainstId] = useState<string | null>(null);
  const [seq, setSeq] = useState<number | null>(null);

  const runs = useResource<RunSummary[]>('/v1/runs');
  const trace = useResource<Trace>(runId === null ? null : `/v1/runs/${runId}`);
  const against = useResource<Trace>(againstId === null ? null : `/v1/runs/${againstId}`);
  const loaded = runId === null ? null : trace;

  const step = useMemo(
    () => (loaded?.status === 'ready' ? (loaded.data.steps.find((s) => s.seq === seq) ?? null) : null),
    [loaded, seq],
  );
  // The same position in the other run, so the detail pane can show both requests.
  const otherStep = useMemo(
    () => (againstId !== null && against.status === 'ready' ? (against.data.steps.find((s) => s.seq === seq) ?? null) : null),
    [against, againstId, seq],
  );

  /**
   * Opens a run, optionally at a step.
   *
   * A new run starts unselected unless a seq is named: keeping seq 2 across runs would
   * show a step from a different trace, which is the kind of wrong that looks right.
   */
  const open = useCallback((id: string, at: number | null = null) => {
    setRunId(id);
    setSeq(at);
    setAgainstId((current) => (current === id ? null : current));
  }, []);

  /** Re-picking the open run is not a change, so the step stays where it is. */
  const pickRun = useCallback(
    (id: string) => {
      if (id !== runId) open(id);
    },
    [open, runId],
  );

  /** The second slot. Comparing a run with itself is not a question. */
  const pickAgainst = useCallback(
    (id: string) => setAgainstId((current) => (current === id ? null : id === runId ? null : id)),
    [runId],
  );

  // ↑/↓ walk the steps once a run is open — the pane you scan most.
  useEffect(() => {
    if (loaded?.status !== 'ready' || loaded.data.steps.length === 0) return;
    const steps = loaded.data.steps;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.isContentEditable) return;
      event.preventDefault();
      const at = steps.findIndex((s) => s.seq === seq);
      const next = event.key === 'ArrowDown' ? Math.min(at + 1, steps.length - 1) : Math.max(at - 1, 0);
      setSeq(steps[at === -1 ? 0 : next]!.seq);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loaded, seq]);

  const total = runs.status === 'ready' ? runs.data.length : null;

  return (
    <div className={styles.app}>
      <header className={styles.bar}>
        <span className={styles.brand}>
          <Rewind size={15} strokeWidth={2.25} aria-hidden />
          Rewind
        </span>
        <span className={styles.tagline}>Recorded agent runs</span>
        <span className={styles.spacer} />
        {total !== null && (
          <span className={styles.stat}>
            <span className={styles.statNum}>{total}</span> {total === 1 ? 'run' : 'runs'}
          </span>
        )}
      </header>

      <main className={styles.panes}>
        <RunList
          runs={runs}
          selected={runId}
          against={againstId}
          onSelect={pickRun}
          onCompare={pickAgainst}
        />
        {againstId !== null ? (
          <Compare left={trace} right={against} onClose={() => setAgainstId(null)} onPickStep={setSeq} />
        ) : (
          <Timeline trace={loaded} selected={seq} onSelect={setSeq} />
        )}
        <StepDetail step={step} against={otherStep} onJump={open} />
      </main>
    </div>
  );
}
