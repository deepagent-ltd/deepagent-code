import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Durable-only task migration: `task_run` gains an explicit execution authority marker. Historical
// rows keep the `'v1'` default (the legacy app-layer TaskDispatcher owns them); every row written
// by the Core V2 `TaskRunAuthority` carries `'v2'`, and its claim/recovery paths filter on `'v2'`
// so the native authority never adopts old V1 work.
export default {
  id: "20260918101443_v2_task_run_execution_runtime",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`task_run\` ADD \`execution_runtime\` text DEFAULT 'v1' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
