import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Argument receipts are diagnostic evidence, so the stored row must distinguish raw visibility,
// schema admission, and the plan tool's semantic admission result without retaining the payload.
export default {
  id: "20260807123000_session_tool_argument_validation_outcome",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE session_tool_argument_receipt
        ADD COLUMN validation_outcome TEXT NOT NULL DEFAULT 'not_evaluated'
        CHECK (validation_outcome IN (
          'not_evaluated',
          'schema_valid',
          'schema_invalid',
          'semantic_valid',
          'semantic_invalid',
          'conflict',
          'no_progress'
        ))
      `)
    })
  },
} satisfies DatabaseMigration.Migration
