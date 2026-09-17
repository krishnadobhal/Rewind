-- Rewind schema. Must agree with packages/core/src/types/schema.ts (DATA_MODEL.md).
--
-- Fork and Diff are in DATA_MODEL.md but not here: M2 is cut, and a table nothing
-- writes to is a promise the code does not keep.

create table if not exists runs (
  run_id          text        primary key,   -- ULID, sortable by creation
  thread_id       text        not null default '',
  graph_sha       text        not null default '',
  code_sha        text        not null default '',
  prompt_sha      text        not null default '',
  model_cfg       jsonb       not null default '{}',
  seed            bigint      not null,
  flags_snapshot  jsonb       not null default '{}',
  hash_version    int         not null,      -- replay refuses to mix versions (I2)
  started_at      timestamptz not null,
  ended_at        timestamptz,
  -- A partial run dropped events and is never a replay source (I1).
  status          text        not null check (status in ('complete', 'partial', 'error')),
  outcome         jsonb,
  tokens          int         not null default 0,
  cost_usd        numeric     not null default 0,
  latency_ms      int         not null default 0
);

-- Immutable and content-addressed: a corrected recording is a new row, never an update.
create table if not exists cassettes (
  hash            text        primary key,   -- sha256(HASH_VERSION ‖ jcs(canonical(req)))
  hash_version    int         not null,
  kind            text        not null,
  request         text        not null,      -- blob ref, not the body (ARCHITECTURE §13)
  response        text        not null,
  chunks          text,                      -- streaming chunk sequence, when recorded
  provider        text,
  model_version   text,
  redaction_map   jsonb       not null default '{}',  -- token → matcher, never plaintext
  refcount        int         not null default 1,
  recorded_at     timestamptz not null
);

-- Append-only. No foreign key to runs on purpose: if the run row is lost the steps are
-- still evidence, and a cascade would turn one dropped write into a lost trace.
create table if not exists steps (
  run_id          text        not null,
  seq             int         not null,      -- scheduler order, not arrival order
  node            text        not null,
  kind            text        not null,
  req_hash        text        not null,
  cassette_ref    text,
  match_tier      text        not null,      -- always stored, never inferred (I3)
  latency_ms      int         not null default 0,
  tokens          int,
  cost_usd        numeric,
  error           jsonb,
  primary key (run_id, seq)
);

create index if not exists steps_req_hash on steps (req_hash);
create index if not exists steps_kind_node on steps (kind, node);
create index if not exists runs_started_at on runs (started_at desc);
