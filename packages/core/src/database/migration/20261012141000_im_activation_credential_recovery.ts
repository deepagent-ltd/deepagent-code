import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012141000_im_activation_credential_recovery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`DROP INDEX im_activation_pending_idx`)
      yield* tx.run(sql`CREATE UNIQUE INDEX im_activation_pending_idx ON im_activation(source_hash)
        WHERE state IN ('pending','unknown') OR (state = 'succeeded' AND credential_stored = 0)`)
    })
  },
} satisfies DatabaseMigration.Migration
