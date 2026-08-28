import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import type { DatabaseMigration } from "../database/migration"

// C5-09 — IM single-write receipt ledger. Design authority: docs/core-v2.0-beta/design.md §B1
// (the IM double-write: a persisted user message ALSO publishes `im.message.created` and feeds the
// legacy synchronous @mention path). The single-write consolidation records ONE durable IM input
// receipt and binds it to ONE execution owner, so the event path and the legacy path cannot both
// become the authority for the same IM message (contract error code `im_double_write_attempted`).
//
// The ledger is keyed by the IM message id (the natural dedupe identity of a user message). It records
// the admission event ref (the EventV2 work envelope identity), the single execution owner, and the
// durable receipt reference handed back by the E4a admission bridge. Like the other event-hotspot
// schemas, the migration is defined HERE so the tests create it with `DatabaseMigration.applyOnly`;
// wiring it into the shared migration registry is the main agent's / database hotspot's job.

export type ImSingleWriteStatus = "single_written" | "refused"

export const ImSingleWriteTable = sqliteTable("deepagent_im_single_write", {
  // The durable dedupe identity of the IM user message (never a second authority for it).
  im_message_id: text().primaryKey(),
  // The EventV2 work envelope identity admitted via the E4a admission bridge.
  event_ref: text().notNull(),
  // The single execution owner that claims this IM input (process/SessionExecution owner token).
  owner_id: text().notNull(),
  generation: integer().notNull(),
  // The durable admission receipt reference returned by the E4a admission bridge.
  receipt_ref: text().notNull(),
  status: text().$type<ImSingleWriteStatus>().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  index("deepagent_im_single_write_event_idx").on(table.event_ref),
  index("deepagent_im_single_write_owner_idx").on(table.owner_id),
])

/** Idempotent migration that creates the IM single-write receipt ledger. */
export const imSingleWriteMigration: DatabaseMigration.Migration = {
  id: "20260829010000_deepagent_im_single_write",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_im_single_write\` (
          \`im_message_id\` text PRIMARY KEY,
          \`event_ref\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`receipt_ref\` text NOT NULL,
          \`status\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`deepagent_im_single_write_status_check\` CHECK(\`status\` IN ('single_written', 'refused'))
        );
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_im_single_write_event_idx\` ON \`deepagent_im_single_write\`(\`event_ref\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_im_single_write_owner_idx\` ON \`deepagent_im_single_write\`(\`owner_id\`);
      `)
    })
  },
}

export * as ImSingleWriteSql from "./im-single-write-sql"
