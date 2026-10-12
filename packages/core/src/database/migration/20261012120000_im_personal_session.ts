import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012120000_im_personal_session",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`CREATE TABLE im_dac_binding (
        id TEXT PRIMARY KEY NOT NULL, identity_key TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL, account_key TEXT NOT NULL, executor_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL, group_id TEXT NOT NULL, project_id TEXT NOT NULL,
        directory TEXT NOT NULL, workspace_id TEXT, current_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation >= 1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`)
      yield* tx.run(sql`CREATE TABLE im_dac_command (
        id TEXT PRIMARY KEY NOT NULL, command_id TEXT NOT NULL,
        binding_id TEXT NOT NULL REFERENCES im_dac_binding(id) ON DELETE RESTRICT,
        request_hash TEXT NOT NULL, text TEXT NOT NULL, reference_ids TEXT NOT NULL,
        "references" TEXT NOT NULL, new_session INTEGER NOT NULL,
        session_id TEXT NOT NULL, input_id TEXT NOT NULL UNIQUE,
        delivery TEXT NOT NULL CHECK(delivery IN ('queue','steer')),
        state TEXT NOT NULL CHECK(state IN ('pending','admitted','rejected')),
        created_at INTEGER NOT NULL, admitted_at INTEGER,
        UNIQUE(binding_id, command_id)
      )`)
      yield* tx.run(sql`CREATE INDEX im_dac_command_pending_idx ON im_dac_command(state, created_at)`)
    })
  },
} satisfies DatabaseMigration.Migration
