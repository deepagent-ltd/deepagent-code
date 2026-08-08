import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260805000000_repair_task_admission",
  up(tx) {
    return Effect.gen(function* () {
      // Early L1 builds could cascade-delete task_admission while rebuilding task_run with
      // foreign_keys still enabled. L1 persisted the canonical admission key on the run before
      // that drop, so restore the exact-retry authority when the row is otherwise missing.
      yield* tx.run(`
        INSERT INTO task_admission (
          admission_key, request_hash, run_id, parent_session_id, parent_message_id,
          tool_call_id, delivery_mode, time_created, origin_kind, origin_key
        )
        SELECT
          run.origin_key, run.request_hash, run.run_id, run.parent_session_id,
          run.parent_message_id, run.tool_call_id, run.delivery_mode, run.time_created,
          'task_tool', run.origin_key
        FROM task_run AS run
        WHERE run.origin_kind = 'task_tool'
          AND run.origin_key IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM task_admission AS admission WHERE admission.run_id = run.run_id
          )
        ON CONFLICT DO NOTHING
      `)
    })
  },
} satisfies DatabaseMigration.Migration
