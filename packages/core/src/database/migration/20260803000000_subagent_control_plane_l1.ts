import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803000000_subagent_control_plane_l1",
  up(tx) {
    return Effect.gen(function* () {
      // ── task_run: run graph / lineage (L2) ────────────────────────────────
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN parent_run_id TEXT REFERENCES task_run(run_id) ON DELETE CASCADE`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN continuation_of_run_id TEXT REFERENCES task_run(run_id) ON DELETE CASCADE`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN depth INTEGER NOT NULL DEFAULT 1`)

      // ── task_run: origin identity ──────────────────────────────────────────
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'task_tool' CHECK (origin_kind IN ('task_tool','goal_role'))`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN origin_key TEXT`)

      // ── task_run: modes (immutable at admission) ───────────────────────────
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN effective_delivery_mode TEXT NOT NULL DEFAULT 'foreground'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN promoted_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'new'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'fresh'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN context_cutoff_message_id TEXT`)

      // ── task_run: capability / workspace policy (frozen at admission) ──────
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN mutation_capability TEXT NOT NULL DEFAULT 'write'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN tool_capability_hash TEXT NOT NULL DEFAULT 'legacy-unknown'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'shared'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_owner TEXT NOT NULL DEFAULT 'parent'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_visibility TEXT NOT NULL DEFAULT 'live'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN parent_dirty_policy TEXT NOT NULL DEFAULT 'allow_live'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_operation_key TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_revision INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN execution_spec TEXT`)

      // ── task_run: lifecycle / CAS ──────────────────────────────────────────
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN version INTEGER NOT NULL DEFAULT 0`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN control_state TEXT NOT NULL DEFAULT 'open'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN input_state TEXT NOT NULL DEFAULT 'legacy'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN child_message_id TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN input_admission_started_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN child_input_materialized_hash TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN child_input_part_count INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN execution_started_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN finalizer_started_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN interrupt_requested_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN interrupt_reason TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN close_requested_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN close_reason TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN start_attempts INTEGER NOT NULL DEFAULT 0`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN queue_reason TEXT`)

      // ── task_run: workspace provisioning receipts ──────────────────────────
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_preflight_state TEXT NOT NULL DEFAULT 'legacy'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_preflight_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_repository_root TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_base_commit TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_parent_branch TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_target_branch TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_status_hash TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_preflight_error_code TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_branch_state TEXT NOT NULL DEFAULT 'none'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN workspace_branch_started_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN worktree_directory TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN worktree_branch TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN worktree_state TEXT NOT NULL DEFAULT 'none'`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN worktree_started_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN pr_operation_key TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN pr_started_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN pr_id TEXT`)

      // ── task_run: goal-specific identity columns ───────────────────────────
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN goal_id TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN goal_tick_seq INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN goal_role TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN goal_ordinal INTEGER`)

      // ── task_run: result enrichment ────────────────────────────────────────
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN result_hash TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN usage TEXT`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN progress_seq INTEGER NOT NULL DEFAULT 0`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN last_progress_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_run ADD COLUMN finalizer_input_message_id TEXT`)

      // ── task_run: new indexes ──────────────────────────────────────────────
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS task_run_queue_idx
          ON task_run(state, available_at, priority DESC, time_created, generation)
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS task_run_goal_idx
          ON task_run(goal_id, goal_tick_seq, goal_role, goal_ordinal)
      `)

      // ── task_run: backfill steps ───────────────────────────────────────────
      // 1. Backfill origin_key from admission_key for historical task_tool rows
      yield* tx.run(`
        UPDATE task_run SET origin_key = (
          SELECT admission_key FROM task_admission WHERE task_admission.run_id = task_run.run_id
        ) WHERE origin_key IS NULL
      `)
      // 2. Rename historical 'error' state to 'failed' (design doc §13.1 step 3)
      yield* tx.run(`UPDATE task_run SET state = 'failed' WHERE state = 'error'`)
      // 3. Backfill available_at for old rows
      yield* tx.run(`UPDATE task_run SET available_at = time_created WHERE available_at = 0`)
      // 4. Backfill start_attempts from attempts for historical rows
      yield* tx.run(`UPDATE task_run SET start_attempts = attempts WHERE start_attempts = 0 AND attempts > 0`)
      // 5. Backfill effective_delivery_mode = delivery_mode
      yield* tx.run(`UPDATE task_run SET effective_delivery_mode = delivery_mode`)
      // 6. Set control_state = 'closed' for all terminal rows
      yield* tx.run(`UPDATE task_run SET control_state = 'closed' WHERE state IN ('completed','failed','cancelled','interrupted','closed')`)

      // ── task_run_event: new table ──────────────────────────────────────────
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

      // ── task_notification_outbox: new columns ──────────────────────────────
      yield* tx.run(`ALTER TABLE task_notification_outbox ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'terminal'`)
      yield* tx.run(`ALTER TABLE task_notification_outbox ADD COLUMN correlation_id TEXT`)
      yield* tx.run(`ALTER TABLE task_notification_outbox ADD COLUMN payload_hash TEXT`)
      yield* tx.run(`ALTER TABLE task_notification_outbox ADD COLUMN parent_input_message_id TEXT`)
      yield* tx.run(`ALTER TABLE task_notification_outbox ADD COLUMN response_message_id TEXT`)
      yield* tx.run(`ALTER TABLE task_notification_outbox ADD COLUMN response_started_at INTEGER`)
      yield* tx.run(`ALTER TABLE task_notification_outbox ADD COLUMN time_admitted INTEGER`)

      // ── task_notification_outbox: partial unique index ─────────────────────
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS task_notification_outbox_parent_processing_idx
          ON task_notification_outbox(parent_session_id)
          WHERE status = 'processing'
      `)
    })
  },
} satisfies DatabaseMigration.Migration
