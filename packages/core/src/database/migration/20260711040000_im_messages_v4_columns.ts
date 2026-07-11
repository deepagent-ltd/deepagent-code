import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: IM messages V4.0 columns (§B4)
 *
 * Adds the event-driven columns to `im_messages` WITHOUT breaking V3.8 queries
 * (§H compatibility — both nullable, ADD COLUMN is backward-compatible):
 * - event_id: the DeepAgent Event Bus event a message was produced from.
 * - delivery_status: pending | delivered | failed (event-driven messages only).
 * Plus the §B4 thread-pagination + event-lookup indexes.
 */
export default {
  id: "20260711040000_im_messages_v4_columns",
  up(tx) {
    return Effect.gen(function* () {
      // ADD COLUMN errors if the column exists (SQLite has no ADD COLUMN IF NOT EXISTS), so guard each
      // via a table_info check — mirrors 20260709000000_add_session_preview.
      const cols = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`im_messages\`)`)
      const has = (name: string) => cols.some((c) => c.name === name)
      if (!has("event_id")) {
        yield* tx.run(`ALTER TABLE \`im_messages\` ADD COLUMN \`event_id\` text;`)
      }
      if (!has("delivery_status")) {
        yield* tx.run(`ALTER TABLE \`im_messages\` ADD COLUMN \`delivery_status\` text;`)
      }

      // §B4 thread pagination: (group_id, reply_to_id, created_at). The spec's partial WHERE
      // deleted_at IS NULL predicate is dropped here (this repo's index builder omits it on the active
      // index too); the query filters deleted_at explicitly.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`idx_im_messages_thread\`
        ON \`im_messages\` (\`group_id\`, \`reply_to_id\`, \`created_at\`);
      `)
      // §B4 event linkage lookup.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`idx_im_messages_event\`
        ON \`im_messages\` (\`event_id\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
