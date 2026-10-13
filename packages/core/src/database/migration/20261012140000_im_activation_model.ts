import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012140000_im_activation_model",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`ALTER TABLE im_dac_command ADD COLUMN model TEXT`)
      yield* tx.run(sql`CREATE TABLE im_activation (
        transaction_id TEXT PRIMARY KEY NOT NULL, source_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
        name TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('api_key','activation_code')),
        quote_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','unknown','succeeded','rejected')),
        charged_credits INTEGER, credential_stored INTEGER NOT NULL, code TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        CHECK((state IN ('pending','unknown') AND charged_credits IS NULL) OR
          (state = 'rejected' AND charged_credits = 0) OR
          (state = 'succeeded' AND charged_credits IN (0,1)))
      )`)
      yield* tx.run(sql`CREATE UNIQUE INDEX im_activation_pending_idx ON im_activation(source_hash) WHERE state IN ('pending','unknown')`)
      yield* tx.run(sql`CREATE INDEX im_activation_source_idx ON im_activation(source_hash, created_at)`)
    })
  },
} satisfies DatabaseMigration.Migration
