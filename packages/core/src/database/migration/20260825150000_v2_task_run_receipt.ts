import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Capability port §16.3 order 2: TaskRun settlements gain a durable terminal authority
// (compensation receipt). Rows are admitted only in a terminal state, are immutable and
// append-only, and one receipt exists per run; the outcome hash pins the recorded settlement
// evidence so re-settlement converges or conflicts, never overwrites.
export default {
  id: "20260825150000_v2_task_run_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS session_v2_task_run_receipt (
          receipt_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          child_session_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          state TEXT NOT NULL,
          reason TEXT NOT NULL,
          outcome_hash TEXT NOT NULL,
          owner_token TEXT NOT NULL,
          time_created INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS session_v2_task_run_receipt_run_idx
        ON session_v2_task_run_receipt (run_id)
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS session_v2_task_run_receipt_session_idx
        ON session_v2_task_run_receipt (session_id, time_created)
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_task_run_receipt_insert_guard
        BEFORE INSERT ON session_v2_task_run_receipt
        WHEN NEW.receipt_id IS NULL
          OR length(trim(NEW.receipt_id)) = 0
          OR NEW.session_id IS NULL
          OR length(trim(NEW.session_id)) = 0
          OR NEW.run_id IS NULL
          OR length(trim(NEW.run_id)) = 0
          OR NEW.child_session_id IS NULL
          OR length(trim(NEW.child_session_id)) = 0
          OR NEW.generation IS NULL
          OR NEW.generation < 1
          OR NEW.state NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'closed')
          OR NEW.reason IS NULL
          OR length(trim(NEW.reason)) = 0
          OR NEW.outcome_hash IS NULL
          OR length(NEW.outcome_hash) != 64
          OR NEW.outcome_hash GLOB '*[^0-9a-f]*'
          OR NEW.owner_token IS NULL
          OR length(trim(NEW.owner_token)) = 0
        BEGIN
          SELECT RAISE(ABORT, 'invalid v2 task run receipt');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_task_run_receipt_update_guard
        BEFORE UPDATE ON session_v2_task_run_receipt
        BEGIN
          SELECT RAISE(ABORT, 'v2 task run receipt is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_task_run_receipt_delete_guard
        BEFORE DELETE ON session_v2_task_run_receipt
        BEGIN
          SELECT RAISE(ABORT, 'v2 task run receipt is append only');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
