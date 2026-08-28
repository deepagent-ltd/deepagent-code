import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813121129_v2_provider_parity_response_fingerprint",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2_provider_parity_baseline\` ADD \`legacy_response_fingerprint\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
