import { AlertTriangle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Tier } from '../api.ts';
import styles from './Primitives.module.css';

export function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return 'just now';
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function Pane({ title, count, children }: { title: string; count?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.pane}>
      <header className={styles.paneHead}>
        <h2>{title}</h2>
        {count !== undefined && <span className={styles.count}>{count}</span>}
      </header>
      <div className={styles.paneBody}>{children}</div>
    </section>
  );
}

export function Empty({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <Icon size={18} strokeWidth={1.5} aria-hidden />
      <p className={styles.emptyTitle}>{title}</p>
      {hint !== undefined && <p className={styles.emptyHint}>{hint}</p>}
    </div>
  );
}

export function Failed({ message }: { message: string }) {
  return (
    <div className={styles.empty}>
      <AlertTriangle size={18} strokeWidth={1.5} aria-hidden className={styles.failedIcon} />
      <p className={styles.emptyTitle}>{message}</p>
      <p className={styles.emptyHint}>
        Is <code>pnpm serve</code> running?
      </p>
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.skelRow} style={{ animationDelay: `${i * 60}ms` }}>
          <span className={styles.skelBar} style={{ width: `${62 - i * 4}%` }} />
          <span className={styles.skelBarDim} style={{ width: `${38 - i * 3}%` }} />
        </div>
      ))}
    </div>
  );
}

export function TierChip({ tier, count }: { tier: Tier; count?: number }) {
  return (
    <span className={`${styles.tier} ${styles[tier] ?? ''}`}>
      <span className={styles.dot} aria-hidden />
      {tier}
      {count !== undefined && <span className={styles.tierCount}>{count}</span>}
    </span>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tone = status === 'complete' ? styles.ok : status === 'partial' ? styles.warn : styles.bad;
  return <span className={`${styles.status} ${tone}`}>{status}</span>;
}
