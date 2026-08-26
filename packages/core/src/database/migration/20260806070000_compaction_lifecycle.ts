import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// BUG-005: introduce the durable compaction lifecycle tables and the PromptEpoch table.
//
// compaction_run tracks logical compaction attempts (one per hard decision).
// compaction_summary_attempt tracks physical Provider dispatches within a run (max 2 per run).
// session_prompt_epoch is the unique history boundary authority (replaces summary-scan heuristic).
//
// These three tables share the existing shared SQLite database alongside the core session tables.
// Migrations are additive; no existing data is touched.
export default {
  id: "20260806070000_compaction_lifecycle",
  up(tx) {
    return Effect.gen(function* () {
      // ── compaction_run ──────────────────────────────────────────────────
      // One row per logical compaction decision.  A session may have many runs
      // (one per hard overflow event) but at most one "active" (requested/summarizing) run.
      yield* tx.run(`
        CREATE TABLE compaction_run (
          run_id         TEXT NOT NULL PRIMARY KEY,
          session_id     TEXT NOT NULL,
          from_prompt_epoch INTEGER NOT NULL,
          target_prompt_epoch INTEGER,
          trigger        TEXT NOT NULL CHECK (trigger IN ('turn_start', 'provider_overflow', 'manual')),
          marker_message_id TEXT,
          marker_part_id TEXT,
          committed_summary_message_id TEXT,
          checkpoint_ref TEXT,
          checkpoint_hash TEXT,
          state          TEXT NOT NULL CHECK (state IN
                           ('requested', 'summarizing', 'committed', 'failed', 'indeterminate')),
          terminal_failure_kind TEXT,
          created_at     INTEGER NOT NULL,
          committed_at   INTEGER
        )
      `)
      // At most one active run per session (state in requested|summarizing|indeterminate).
      yield* tx.run(`
        CREATE UNIQUE INDEX compaction_run_session_active_idx
          ON compaction_run (session_id)
          WHERE state IN ('requested', 'summarizing', 'indeterminate')
      `)
      yield* tx.run(`CREATE INDEX compaction_run_session_idx ON compaction_run (session_id, created_at)`)

      // ── compaction_summary_attempt ──────────────────────────────────────
      // One row per physical Provider dispatch within a compaction_run.
      // ordinal is 1-based; max 2 dispatches per run (BUG-006 hard upper bound).
      yield* tx.run(`
        CREATE TABLE compaction_summary_attempt (
          summary_attempt_id TEXT NOT NULL PRIMARY KEY,
          run_id             TEXT NOT NULL REFERENCES compaction_run(run_id) ON DELETE CASCADE,
          ordinal            INTEGER NOT NULL CHECK (ordinal >= 1),
          parent_attempt_id  TEXT,
          provider_id        TEXT NOT NULL,
          model_id           TEXT NOT NULL,
          protocol           TEXT NOT NULL,
          request_hash       TEXT,
          idempotency_key    TEXT,
          state              TEXT NOT NULL CHECK (state IN
                               ('prepared', 'dispatching', 'streaming', 'settled', 'failed',
                                'indeterminate_after_crash')),
          retry_reason       TEXT,
          failure_kind       TEXT,
          prepared_at        INTEGER NOT NULL,
          dispatched_at      INTEGER,
          completed_at       INTEGER,
          UNIQUE (run_id, ordinal)
        )
      `)

      // ── session_prompt_epoch ────────────────────────────────────────────
      // The ONLY history boundary authority for a session.  Exactly one row has
      // state='active' per session at any time (enforced by the partial unique index).
      // checkpoint refs are null for Epoch 0 (bootstrap / no compaction yet).
      yield* tx.run(`
        CREATE TABLE session_prompt_epoch (
          session_id              TEXT NOT NULL,
          epoch                   INTEGER NOT NULL CHECK (epoch >= 0),
          state                   TEXT NOT NULL CHECK (state IN ('active', 'retired')),
          checkpoint_user_id      TEXT,
          checkpoint_assistant_id TEXT,
          retained_tail_start_id  TEXT,
          source_end_message_id   TEXT,
          checkpoint_hash         TEXT,
          reason                  TEXT NOT NULL CHECK (reason IN
                                    ('bootstrap', 'compaction', 'model', 'agent', 'directory',
                                     'workspace', 'tools', 'permission', 'renderer')),
          created_at              INTEGER NOT NULL,
          retired_at              INTEGER,
          PRIMARY KEY (session_id, epoch)
        )
      `)
      // At most one active epoch per session.
      yield* tx.run(`
        CREATE UNIQUE INDEX session_prompt_epoch_active_idx
          ON session_prompt_epoch (session_id)
          WHERE state = 'active'
      `)
    })
  },
} satisfies DatabaseMigration.Migration
