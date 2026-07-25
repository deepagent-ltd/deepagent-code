import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260724134000_task_run_delivery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS task_run (
          run_id TEXT PRIMARY KEY,
          root_run_id TEXT,
          request_hash TEXT NOT NULL,
          parent_session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          parent_message_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          child_session_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('foreground', 'background')),
          phase TEXT NOT NULL CHECK (phase IN ('admission', 'research', 'finalize', 'settled')),
          state TEXT NOT NULL CHECK (state IN ('admitted', 'provisioning', 'researching', 'finalizing', 'completed', 'error', 'cancelled', 'interrupted')),
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
          time_settled INTEGER
        )
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS task_run_child_generation_idx
        ON task_run (child_session_id, generation)
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS task_run_child_active_idx
        ON task_run (child_session_id)
        WHERE state IN ('admitted', 'provisioning', 'researching', 'finalizing')
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS task_run_parent_state_idx
        ON task_run (parent_session_id, state, time_updated)
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS task_run_root_idx
        ON task_run (root_run_id)
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS task_admission (
          admission_key TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES task_run(run_id) ON DELETE CASCADE,
          parent_session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          parent_message_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('foreground', 'background')),
          time_created INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS task_admission_run_idx
        ON task_admission (run_id)
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS task_notification_outbox (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE REFERENCES task_run(run_id) ON DELETE CASCADE,
          message_id TEXT NOT NULL UNIQUE,
          parent_session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          directory TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'dead')),
          attempts INTEGER NOT NULL DEFAULT 0,
          available_at INTEGER NOT NULL,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          last_error TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          time_delivered INTEGER
        )
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS task_notification_outbox_due_idx
        ON task_notification_outbox (status, available_at, lease_expires_at)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
