import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007064020_account_identity_generation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE account ADD COLUMN identity_generation TEXT CHECK(identity_generation IS NULL OR (typeof(identity_generation)='text' AND length(identity_generation)=64 AND identity_generation NOT GLOB '*[^0-9a-f]*'));`)
      yield* tx.run(`ALTER TABLE account_state ADD COLUMN selection_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(selection_revision)='integer' AND selection_revision>=0 AND selection_revision<=9007199254740991);`)
    })
  },
} satisfies DatabaseMigration.Migration
