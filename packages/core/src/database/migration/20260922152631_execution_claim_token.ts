import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260922152631_execution_claim_token",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` RENAME COLUMN \`time_suspended\` TO \`execution_claim_token\`;`)
      yield* tx.run(`DROP INDEX \`session_time_suspended_idx\`;`)
      yield* tx.run(`CREATE INDEX \`session_execution_claim_token_idx\` ON \`session\` (\`execution_claim_token\`) WHERE "session"."execution_claim_token" is not null;`)
    })
  },
} satisfies DatabaseMigration.Migration
