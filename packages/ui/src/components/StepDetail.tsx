/**
 * One step's request beside its response — the thing a terminal cannot do.
 *
 * A miss has no cassette by definition, so that state is not an error page: it is the
 * answer, and it names the hash that did not resolve so it can be chased.
 */
import { FileSearch, History, ShieldCheck, SplitSquareHorizontal } from 'lucide-react';
import { differingFields } from '../compare.ts';
import type { Cassette, Step, StepHit } from '../api.ts';
import { useResource } from '../api.ts';
import { ago, Empty, Failed, Pane, Skeleton, TierChip } from './Primitives.tsx';
import { Json } from './Json.tsx';
import styles from './StepDetail.module.css';

/** Cassette bodies arrive as JSON strings; a bad one should not blank the pane. */
function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function StepDetail({
  step,
  against,
  onJump,
}: {
  step: Step | null;
  against?: Step | null;
  onJump?: (runId: string, seq: number) => void;
}) {
  // Hooks run unconditionally; a null path simply never fetches.
  const cassette = useResource<Cassette>(
    step !== null && step.cassette_ref !== null ? `/v1/cassettes/${step.req_hash}` : null,
  );
  // The same position in the run being compared against, when there is one.
  const other = useResource<Cassette>(
    against != null && against.cassette_ref !== null && against.req_hash !== step?.req_hash
      ? `/v1/cassettes/${against.req_hash}`
      : null,
  );

  if (step === null) {
    return (
      <Pane title="Step">
        <Empty icon={SplitSquareHorizontal} title="Pick a step" hint="Its request and response appear side by side." />
      </Pane>
    );
  }

  return (
    <Pane title="Step">
      <div className={styles.detail}>
        <header className={styles.head}>
          <h3 className={styles.title}>{step.node}</h3>
          <div className={styles.facts}>
            <span>seq <span className={styles.mono}>{step.seq}</span></span>
            <span className={styles.sep} aria-hidden>·</span>
            <span>{step.kind}</span>
            <span className={styles.sep} aria-hidden>·</span>
            <TierChip tier={step.match_tier} />
          </div>
          <p className={styles.hash} title="Canonical request hash">{step.req_hash}</p>
        </header>

        <Occurrences step={step} onJump={onJump} />

        {step.cassette_ref === null ? (
          <Empty
            icon={FileSearch}
            title="No cassette matched this request"
            hint="The step did not replay. A miss is a branch, not an approximation — nothing was returned in its place."
          />
        ) : cassette.status === 'loading' ? (
          <Skeleton rows={3} />
        ) : cassette.status === 'error' ? (
          <Failed message={cassette.message} />
        ) : (
          <>
            {other.status === 'ready' ? (
              <Diff mine={parse(cassette.data.request)} theirs={parse(other.data.request)} />
            ) : (
              <div className={styles.split}>
                <Json label="Request" value={parse(cassette.data.request)} />
                <Json label="Response" value={parse(cassette.data.response)} />
              </div>
            )}
            <Redactions map={cassette.data.redaction_map} />
          </>
        )}
      </div>
    </Pane>
  );
}

/**
 * Where else this call happened.
 *
 * `req_hash` is the identity of a call, so "the same question" is a lookup rather than
 * a guess: if the hashes match, the agent asked exactly this before. When nothing
 * matches, the same node is the next best question — that is how you see a step whose
 * content drifted while its position in the graph stayed put.
 */
function Occurrences({ step, onJump }: { step: Step; onJump?: (runId: string, seq: number) => void }) {
  const same = useResource<StepHit[]>(`/v1/steps?hash=${encodeURIComponent(step.req_hash)}&limit=25`);
  const identical = same.status === 'ready' ? same.data.filter((hit) => hit.run_id !== step.run_id) : [];
  // Only ask the second question once the first has come back empty.
  const kin = useResource<StepHit[]>(
    same.status === 'ready' && identical.length === 0
      ? `/v1/steps?node=${encodeURIComponent(step.node)}&kind=${encodeURIComponent(step.kind)}&limit=25`
      : null,
  );
  const varied = kin.status === 'ready' ? kin.data.filter((hit) => !(hit.run_id === step.run_id && hit.seq === step.seq)) : [];

  const exact = identical.length > 0;
  const hits = exact ? identical : varied;
  // A secondary panel stays quiet while it loads, and silent when it has nothing.
  if (same.status !== 'ready' || (!exact && kin.status !== 'ready')) return null;

  return (
    <section className={styles.seen}>
      <p className={styles.seenHead}>
        <History size={13} strokeWidth={1.75} aria-hidden />
        {hits.length === 0 ? (
          <span className={styles.seenOnce}>First time this call has been recorded</span>
        ) : exact ? (
          <>
            <strong>Same call</strong> in {hits.length} other {hits.length === 1 ? 'run' : 'runs'}
          </>
        ) : (
          <>
            <strong>No identical call.</strong> <code>{step.node}</code> ran {hits.length}{' '}
            {hits.length === 1 ? 'other time' : 'other times'}, asking something else
          </>
        )}
      </p>
      {hits.length > 0 && (
        <ul className={styles.seenList}>
          {hits.map((hit) => (
            <li key={`${hit.run_id}:${hit.seq}`}>
              <button
                type="button"
                className={styles.seenRow}
                disabled={onJump === undefined}
                onClick={() => onJump?.(hit.run_id, hit.seq)}
              >
                <span className={styles.seenRun}>{hit.run_id.slice(-8)}</span>
                <span className={styles.seenSeq}>seq {hit.seq}</span>
                {/* Only shown on the varied axis: on the exact one every hash is this one. */}
                {!exact && <span className={styles.seenHash}>{hit.req_hash.slice(0, 10)}</span>}
                <span className={styles.seenWhen}>{ago(hit.started_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The two requests at this position, and which top-level fields differ.
 *
 * The hash already said they differ; naming the fields is the part a person needs.
 * Most of the time it is one — `messages`, because the history grew, or `model_id`,
 * because something was pointed at a different model.
 */
function Diff({ mine, theirs }: { mine: unknown; theirs: unknown }) {
  const fields = differingFields(theirs, mine);
  return (
    <>
      <p className={styles.diffFields}>
        {fields.length === 0 ? (
          'Same request, different hash — check normalisation.'
        ) : (
          <>
            Differs in{' '}
            {fields.map((field, i) => (
              <span key={field}>
                {i > 0 && ', '}
                <code>{field}</code>
              </span>
            ))}
          </>
        )}
      </p>
      <div className={styles.split}>
        <Json label="This run" value={mine} />
        <Json label="Compared run" value={theirs} />
      </div>
    </>
  );
}

/**
 * What the redactor removed on the way in.
 *
 * It lists the token and the matcher, never the original — a map holding plaintext
 * would rebuild the breach it exists to record (I4).
 */
function Redactions({ map }: { map: Record<string, string> }) {
  const entries = Object.entries(map);
  return (
    <footer className={styles.redactions}>
      <ShieldCheck size={13} strokeWidth={1.75} aria-hidden />
      {entries.length === 0 ? (
        <span className={styles.clean}>Nothing redacted</span>
      ) : (
        <>
          <span className={styles.redLabel}>Redacted before storage</span>
          <span className={styles.chips}>
            {entries.map(([token, kind]) => (
              <span key={token} className={styles.chip}>
                <code>{token}</code>
                {kind}
              </span>
            ))}
          </span>
        </>
      )}
    </footer>
  );
}
