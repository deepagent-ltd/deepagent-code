import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const migrationID = "20260907120000_provider_attempt_version"

export default {
  id: migrationID,
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE session_provider_attempt ADD COLUMN attempt_version integer NOT NULL DEFAULT 0")
      yield* tx.run("ALTER TABLE session_provider_attempt ADD COLUMN execution_claim_token integer NOT NULL DEFAULT 0")
    })
  },
} satisfies DatabaseMigration.Migration
