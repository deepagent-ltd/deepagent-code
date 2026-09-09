import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260909041049_session_delete_tombstone",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`event_aggregate_tombstone\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`deleted_at\` integer NOT NULL,
          \`retention_until\` integer NOT NULL,
          \`reason\` text NOT NULL,
          \`deletion_event_id\` text
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
