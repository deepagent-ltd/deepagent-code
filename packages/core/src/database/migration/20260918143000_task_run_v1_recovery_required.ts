import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// V1 task execution chain removal: the app-layer legacy executor/dispatcher/delivery loops are
// deleted; every non-terminal `execution_runtime='v1'` task_run row can never be claimed again
// (the Core V2 authority's claim/settle fences filter on 'v2'). Flip those rows to the explicit
// quiescent recovery_required state so task_status/task_read/task_recovery surface them honestly
// for explicit resolution. Terminal v1 rows stay untouched as immutable history.
export default {
  id: "20260918143000_task_run_v1_recovery_required",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `UPDATE \`task_run\` SET \`state\` = 'recovery_required', \`control_state\` = 'closed', \`reason\` = 'v1 execution chain removed' ` +
          `WHERE \`execution_runtime\` = 'v1' AND \`state\` NOT IN ` +
          `('completed', 'failed', 'error', 'cancelled', 'interrupted', 'closed', 'recovery_required');`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
