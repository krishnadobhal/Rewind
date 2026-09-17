/**
 * A read-only JSON tree: syntax coloured, collapsible, and it knows what a redaction
 * token is.
 *
 * bull-board reaches for CodeMirror here. CodeMirror is an editor — folding, colour and
 * a key count is the whole requirement, and that is this file rather than a dependency
 * tree. Collapsing matters more than colour: a recorded request runs to kilobytes, and
 * the question is almost always "which field differs", not "read it all".
 */
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import styles from './Json.module.css';

/** Anything the recorder wrote. Cassettes hold plain JSON by definition. */
type Value = null | boolean | number | string | Value[] | { [k: string]: Value };

/** A redaction token is data the redactor removed, not a string the agent wrote. */
const REDACTED = /^\[redacted:[a-z]+:\d+\]$/;

/** Objects and arrays past this depth start closed, so the shape reads first. */
const OPEN_TO = 2;

export function Json({ value, label }: { value: unknown; label?: string }) {
  return (
    <div className={styles.root}>
      {label !== undefined && <div className={styles.label}>{label}</div>}
      <pre className={styles.pre}>
        <Node value={value as Value} depth={0} />
      </pre>
    </div>
  );
}

/** Renders one value, recursing into objects and arrays. */
function Node({ value, depth, trailing }: { value: Value; depth: number; trailing?: boolean }) {
  const comma = trailing === true ? <span className={styles.punct}>,</span> : null;

  if (value === null) return <><span className={styles.null}>null</span>{comma}</>;
  if (typeof value === 'boolean') return <><span className={styles.bool}>{String(value)}</span>{comma}</>;
  if (typeof value === 'number') return <><span className={styles.num}>{value}</span>{comma}</>;
  if (typeof value === 'string') return <><Str value={value} />{comma}</>;
  return <Branch value={value} depth={depth} trailing={trailing} />;
}

/** A string, with redaction tokens marked so they read as removals. */
function Str({ value }: { value: string }) {
  if (!value.includes('[redacted:')) return <span className={styles.str}>"{value}"</span>;
  // Split on the token so the surrounding text stays readable around it.
  const parts = value.split(/(\[redacted:[a-z]+:\d+\])/);
  return (
    <span className={styles.str}>
      "{parts.map((part, i) => (REDACTED.test(part) ? <mark key={i} className={styles.redacted}>{part}</mark> : part))}"
    </span>
  );
}

/** An object or array: a disclosure, a preview when closed, its children when open. */
function Branch({ value, depth, trailing }: { value: Value[] | { [k: string]: Value }; depth: number; trailing?: boolean }) {
  const [open, setOpen] = useState(depth < OPEN_TO);
  const array = Array.isArray(value);
  const entries: [string, Value][] = array
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  const [openBrace, closeBrace] = array ? ['[', ']'] : ['{', '}'];

  if (entries.length === 0) {
    return <span className={styles.punct}>{openBrace}{closeBrace}{trailing === true ? ',' : ''}</span>;
  }

  return (
    <span className={styles.branch}>
      <button
        type="button"
        className={styles.toggle}
        data-open={open || undefined}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${entries.length} ${array ? 'items' : 'keys'}`}
      >
        <ChevronRight size={11} strokeWidth={2.5} aria-hidden />
        <span className={styles.punct}>{openBrace}</span>
      </button>

      {!open && (
        // Closed: say how much is hidden, so collapsing never loses the scale.
        <button type="button" className={styles.summary} onClick={() => setOpen(true)}>
          {entries.length} {array ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'}
        </button>
      )}

      {open && (
        <span className={styles.children}>
          {entries.map(([key, child], i) => (
            <span key={key} className={styles.line}>
              {!array && <><span className={styles.key}>"{key}"</span><span className={styles.punct}>: </span></>}
              <Node value={child} depth={depth + 1} trailing={i < entries.length - 1} />
            </span>
          ))}
        </span>
      )}

      <span className={styles.punct}>{closeBrace}{trailing === true ? ',' : ''}</span>
    </span>
  );
}
