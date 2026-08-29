/**
 * L1 Migration: Subagent Control Plane Schema
 *
 * Design: subagent-control-plane-design.zh-CN.md §13.1
 *
 * Strategy: shadow table rebuild for task_run, task_notification_outbox, and task_admission.
 *
 * The previous migration (20260724134000_task_run_delivery) used strict CHECK constraints
 * that only allow legacy state/phase/status values. Since ALTER TABLE ADD COLUMN cannot
 * modify existing CHECK constraints in SQLite, a shadow table approach is required:
 *   1. Create *_new tables with all columns (existing + new) and correct CHECKs
 *   2. Backfill: copy rows with vocabulary renames (error→failed, researching→running, etc.)
 *   3. Validate: check no constraint violations before committing
 *   4. Drop old table + rename new table
 *   5. Recreate indexes and FK-dependent structures
 *
 * IMPORTANT: This migration must run in a single SQLite transaction to ensure the rename
 * is atomic. If any step fails the entire migration rolls back leaving the old schema intact.
 *
 * Legacy writers (claimTaskProvisioning / startTaskRun / recoverExpiredTaskRuns / settleTaskRun
 * in task-run.ts) are updated in the same commit to write new vocabulary. Both old and new
 * vocabularies are accepted by the new CHECKs to allow zero-downtime deploys.
 */

import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803000001_subagent_control_plane_l1",
  up(tx) {
    return Effect.gen(function* () {
      // SQLite ignores PRAGMA foreign_keys changes made after a transaction begins. Keep a
      // transaction-local copy before dropping task_run so ON DELETE CASCADE cannot erase the
      // historical admission rows that must be rebuilt against the replacement table.
      yield* tx.run(`
        CREATE TEMP TABLE task_admission_l1_backup AS
        SELECT
          admission_key, request_hash, run_id, parent_session_id,
          parent_message_id, tool_call_id, delivery_mode, time_created
        FROM task_admission
      `)

      // ── Disable FK enforcement during rebuild (re-enabled at end) ─────────
      yield* tx.run(`PRAGMA foreign_keys = OFF`)

      // ── Step 1: Rebuild task_run with correct state/phase CHECKs ──────────
      // New CHECK accepts both legacy vocabulary (researching, error) for backward-compat
      // reads of any rows that pre-date this migration, and new vocabulary (running, failed,
      // queued, closed, recovery_required) required by the durable control plane.
      yield* tx.run(`
        CREATE TABLE task_run_new (
          run_id TEXT PRIMARY KEY,
          root_run_id TEXT,
          request_hash TEXT NOT NULL,
          parent_session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          parent_message_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          child_session_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('foreground', 'background')),
          phase TEXT NOT NULL CHECK (phase IN (
            'admission', 'research', 'finalize', 'settled',
            'queue', 'provision'
          )),
          state TEXT NOT NULL CHECK (state IN (
            'admitted', 'queued', 'provisioning', 'running', 'researching',
            'finalizing', 'completed', 'failed', 'error',
            'cancelled', 'interrupted', 'closed', 'recovery_required'
          )),
          reason TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          execution_owner TEXT,
          lease_expires_at INTEGER,
          raw_result_message_id TEXT,
          structured_result_message_id TEXT,
          output TEXT,
          error TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          time_settled INTEGER,

          -- L1: run graph / lineage
          parent_run_id TEXT REFERENCES task_run_new(run_id) ON DELETE CASCADE,
          continuation_of_run_id TEXT REFERENCES task_run_new(run_id) ON DELETE CASCADE,
          depth INTEGER NOT NULL DEFAULT 1,

          -- L1: origin identity
          origin_kind TEXT NOT NULL DEFAULT 'task_tool' CHECK (origin_kind IN ('task_tool','goal_role')),
          origin_key TEXT,

          -- L1: modes (immutable at admission)
          effective_delivery_mode TEXT NOT NULL DEFAULT 'foreground',
          promoted_at INTEGER,
          session_mode TEXT NOT NULL DEFAULT 'new',
          context_mode TEXT NOT NULL DEFAULT 'fresh',
          context_cutoff_message_id TEXT,

          -- L1: capability / workspace policy (frozen at admission)
          mutation_capability TEXT NOT NULL DEFAULT 'write',
          tool_capability_hash TEXT NOT NULL DEFAULT 'legacy-unknown',
          workspace_mode TEXT NOT NULL DEFAULT 'shared',
          workspace_owner TEXT NOT NULL DEFAULT 'parent',
          workspace_visibility TEXT NOT NULL DEFAULT 'live',
          parent_dirty_policy TEXT NOT NULL DEFAULT 'allow_live',
          workspace_operation_key TEXT,
          workspace_revision INTEGER,
          execution_spec TEXT,

          -- L1: lifecycle / CAS
          version INTEGER NOT NULL DEFAULT 0,
          control_state TEXT NOT NULL DEFAULT 'open',
          input_state TEXT NOT NULL DEFAULT 'legacy',
          child_message_id TEXT,
          input_admission_started_at INTEGER,
          child_input_materialized_hash TEXT,
          child_input_part_count INTEGER,
          execution_started_at INTEGER,
          finalizer_started_at INTEGER,
          interrupt_requested_at INTEGER,
          interrupt_reason TEXT,
          close_requested_at INTEGER,
          close_reason TEXT,
          claim_generation INTEGER NOT NULL DEFAULT 0,
          start_attempts INTEGER NOT NULL DEFAULT 0,
          available_at INTEGER NOT NULL DEFAULT 0,
          priority INTEGER NOT NULL DEFAULT 0,
          queue_reason TEXT,

          -- L1: workspace provisioning receipts
          workspace_preflight_state TEXT NOT NULL DEFAULT 'legacy',
          workspace_preflight_at INTEGER,
          workspace_repository_root TEXT,
          workspace_base_commit TEXT,
          workspace_parent_branch TEXT,
          workspace_target_branch TEXT,
          workspace_status_hash TEXT,
          workspace_preflight_error_code TEXT,
          workspace_branch_state TEXT NOT NULL DEFAULT 'none',
          workspace_branch_started_at INTEGER,
          worktree_directory TEXT,
          worktree_branch TEXT,
          worktree_state TEXT NOT NULL DEFAULT 'none',
          worktree_started_at INTEGER,
          pr_operation_key TEXT,
          pr_started_at INTEGER,
          pr_id TEXT,

          -- L1: goal-specific identity
          goal_id TEXT,
          goal_tick_seq INTEGER,
          goal_role TEXT,
          goal_ordinal INTEGER,

          -- L1: result enrichment
          result_hash TEXT,
          usage TEXT,
          progress_seq INTEGER NOT NULL DEFAULT 0,
          last_progress_at INTEGER,
          finalizer_input_message_id TEXT
        )
      `)

      // ── Step 2: Copy task_run rows with vocabulary renames ────────────────
      // state: error → failed, researching → running
      // phase: research stays 'research' (still valid), others unchanged
      // control_state: backfill 'closed' for all terminal rows
      yield* tx.run(`
        INSERT INTO task_run_new
        SELECT
          run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
          tool_call_id, child_session_id, generation, delivery_mode,
          phase,
          CASE state
            WHEN 'error'       THEN 'failed'
            WHEN 'researching' THEN 'running'
            ELSE state
          END,
          reason, attempts, execution_owner, lease_expires_at,
          raw_result_message_id, structured_result_message_id,
          output, error, time_created, time_updated, time_settled,
          NULL, NULL, 1,
          'task_tool', NULL,
          delivery_mode,
          NULL, 'new', 'fresh', NULL,
          'write', 'legacy-unknown',
          'shared', 'parent', 'live', 'allow_live',
          NULL, NULL, NULL,
          0,
          CASE
            WHEN state IN ('completed','error','failed','cancelled','interrupted','closed')
            THEN 'closed'
            ELSE 'open'
          END,
          'legacy',
          NULL, NULL, NULL, NULL,
          NULL, NULL,
          NULL, NULL, NULL, NULL,
          0, 0,
          time_created,
          0, NULL,
          'legacy', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          'none', NULL,
          NULL, NULL, 'none', NULL,
          NULL, NULL, NULL,
          NULL, NULL, NULL, NULL,
          NULL, NULL, 0, NULL, NULL
        FROM task_run
      `)

      // ── Step 3: Backfill origin_key from task_admission ───────────────────
      yield* tx.run(`
        UPDATE task_run_new SET origin_key = (
          SELECT admission_key FROM task_admission WHERE task_admission.run_id = task_run_new.run_id
        ) WHERE origin_key IS NULL
      `)

      // ── Step 4: Backfill start_attempts from attempts for historical rows ─
      yield* tx.run(`
        UPDATE task_run_new
        SET start_attempts = attempts
        WHERE start_attempts = 0 AND attempts > 0
      `)

      // ── Step 5: Validate — no orphan state after rename ───────────────────
      // Note: the INSERT above would already fail with a CHECK constraint violation if any row
      // had an invalid state. No additional validation step is needed.

      // ── Step 6: Rebuild task_notification_outbox with new status values ───
      yield* tx.run(`
        CREATE TABLE task_notification_outbox_new (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE REFERENCES task_run_new(run_id) ON DELETE CASCADE,
          message_id TEXT NOT NULL UNIQUE,
          parent_session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          directory TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'pending', 'admitting', 'admitted', 'processing', 'delivering', 'delivered', 'dead',
            'response_recovery_required'
          )),
          attempts INTEGER NOT NULL DEFAULT 0,
          available_at INTEGER NOT NULL,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          last_error TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          time_delivered INTEGER,
          -- L1 new columns
          event_kind TEXT NOT NULL DEFAULT 'terminal',
          correlation_id TEXT,
          payload_hash TEXT,
          parent_input_message_id TEXT,
          response_message_id TEXT,
          response_started_at INTEGER,
          time_admitted INTEGER
        )
      `)

      yield* tx.run(`
        INSERT INTO task_notification_outbox_new
        SELECT
          id, run_id, message_id, parent_session_id, directory, payload,
          -- status: map old values that still apply; 'delivering' → 'processing' for in-flight
          CASE status
            WHEN 'delivering' THEN 'processing'
            ELSE status
          END AS status,
          attempts, available_at, lease_owner, lease_expires_at,
          last_error, time_created, time_updated, time_delivered,
          'terminal', NULL, NULL, NULL, NULL, NULL, NULL
        FROM task_notification_outbox
      `)

      // ── Step 7: Drop old tables and rename new ones ───────────────────────
      // Drop indexes that reference the old tables first
      yield* tx.run(`DROP INDEX IF EXISTS task_run_child_generation_idx`)
      yield* tx.run(`DROP INDEX IF EXISTS task_run_child_active_idx`)
      yield* tx.run(`DROP INDEX IF EXISTS task_run_parent_state_idx`)
      yield* tx.run(`DROP INDEX IF EXISTS task_run_root_idx`)
      yield* tx.run(`DROP INDEX IF EXISTS task_notification_outbox_due_idx`)
      yield* tx.run(`DROP TABLE task_notification_outbox`)
      yield* tx.run(`DROP TABLE task_run`)
      yield* tx.run(`ALTER TABLE task_run_new RENAME TO task_run`)
      yield* tx.run(`ALTER TABLE task_notification_outbox_new RENAME TO task_notification_outbox`)

      // ── Step 8: Recreate indexes ──────────────────────────────────────────
      yield* tx.run(`
        CREATE UNIQUE INDEX task_run_child_generation_idx
        ON task_run (child_session_id, generation)
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX task_run_child_active_idx
        ON task_run (child_session_id)
        WHERE state IN ('admitted', 'provisioning', 'running', 'researching', 'finalizing')
      `)
      yield* tx.run(`
        CREATE INDEX task_run_parent_state_idx
        ON task_run (parent_session_id, state, time_updated)
      `)
      yield* tx.run(`
        CREATE INDEX task_run_root_idx
        ON task_run (root_run_id)
      `)
      yield* tx.run(`
        CREATE INDEX task_notification_outbox_due_idx
        ON task_notification_outbox (status, available_at, lease_expires_at)
      `)
      yield* tx.run(`
        CREATE INDEX task_run_queue_idx
        ON task_run(state, available_at, priority DESC, time_created, generation)
      `)
      yield* tx.run(`
        CREATE INDEX task_run_goal_idx
        ON task_run(goal_id, goal_tick_seq, goal_role, goal_ordinal)
      `)

      // ── Step 9: task_run_event (new table, no existing data) ─────────────
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS task_run_event (
          event_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES task_run(run_id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          type TEXT NOT NULL,
          from_state TEXT,
          to_state TEXT,
          reason TEXT,
          data TEXT,
          time_created INTEGER NOT NULL,
          UNIQUE(run_id, version)
        )
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS task_run_event_time_idx
        ON task_run_event(time_created, event_id)
      `)

      // ── Step 10: Unique index on outbox per-parent processing ─────────────
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS task_notification_outbox_parent_processing_idx
          ON task_notification_outbox(parent_session_id)
          WHERE status = 'processing'
      `)

      // ── task_admission: shadow table rebuild (add origin fields) ──────────
      yield* tx.run(`
        CREATE TABLE task_admission_new (
          admission_key TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES task_run(run_id) ON DELETE CASCADE,
          parent_session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          parent_message_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('foreground', 'background')),
          time_created INTEGER NOT NULL,
          -- L1: origin identity fields
          origin_kind TEXT NOT NULL DEFAULT 'task_tool' CHECK (origin_kind IN ('task_tool','goal_role')),
          origin_key TEXT
        )
      `)
      yield* tx.run(`
        INSERT INTO task_admission_new
        SELECT
          admission_key, request_hash, run_id, parent_session_id,
          parent_message_id, tool_call_id, delivery_mode, time_created,
          'task_tool', admission_key
        FROM task_admission_l1_backup
      `)
      yield* tx.run(`DROP INDEX IF EXISTS task_admission_run_idx`)
      yield* tx.run(`DROP TABLE task_admission`)
      yield* tx.run(`ALTER TABLE task_admission_new RENAME TO task_admission`)
      yield* tx.run(`
        CREATE INDEX task_admission_run_idx ON task_admission (run_id)
      `)
      yield* tx.run(`DROP TABLE task_admission_l1_backup`)

      // ── Step 11: Re-enable FK enforcement ────────────────────────────────
      yield* tx.run(`PRAGMA foreign_keys = ON`)
    })
  },
} satisfies DatabaseMigration.Migration
