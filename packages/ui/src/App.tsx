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

  const otherStep = useMemo(
    () => (againstId !== null && against.status === 'ready' ? (against.data.steps.find((s) => s.seq === seq) ?? null) : null),
    [against, againstId, seq],
  );

  const open = useCallback((id: string, at: number | null = null) => {
    setRunId(id);
    setSeq(at);
    setAgainstId((current) => (current === id ? null : current));
  }, []);

  const pickRun = useCallback(
    (id: string) => {
      if (id !== runId) open(id);
    },
    [open, runId],
  );

  const pickAgainst = useCallback(
    (id: string) => setAgainstId((current) => (current === id ? null : id === runId ? null : id)),
    [runId],
  );

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
