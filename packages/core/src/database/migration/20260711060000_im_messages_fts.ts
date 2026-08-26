import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: IM message full-text search (§B3 搜索)
 *
 * Creates an FTS5 virtual table `im_messages_fts` mirroring `im_messages.content`, plus triggers that
 * keep it synced with the base table. `im_messages` has a TEXT primary key (not an integer rowid), so
 * an external-content FTS5 table is not a natural fit; instead this is an own-content FTS5 table with an
 * extra UNINDEXED `msg_id` column carrying the message id, which the search query JOINs back to
 * `im_messages` for the full row + permission scoping.
 *
 * The FTS table holds ONLY active (deleted_at IS NULL) messages — the delete/soft-delete triggers evict
 * rows — so a soft-deleted message never surfaces in search even before the query's explicit
 * `deleted_at IS NULL` filter.
 *
 * FALLBACK: if this SQLite build lacks the FTS5 module, `CREATE VIRTUAL TABLE` throws. We catch that and
 * skip FTS setup so the migration still completes; the repository detects the missing table at runtime
 * and falls back to a LIKE-based scan (the search method + endpoint work either way).
 */
export default {
  id: "20260711060000_im_messages_fts",
  up(tx) {
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        // Own-content FTS5 table. `msg_id UNINDEXED` stores the message id without tokenizing it.
        yield* tx.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS \`im_messages_fts\` USING fts5(
            content,
            msg_id UNINDEXED
          );
        `)

        // Keep the FTS index synced with the base table. All triggers key off the message id in the
        // UNINDEXED column (a regular own-content FTS5 table supports arbitrary WHERE by that column).
        yield* tx.run(`
          CREATE TRIGGER IF NOT EXISTS \`im_messages_fts_ai\`
          AFTER INSERT ON \`im_messages\`
          WHEN new.deleted_at IS NULL
          BEGIN
            INSERT INTO \`im_messages_fts\`(content, msg_id) VALUES (new.content, new.id);
          END;
        `)
        // Content edit: refresh the indexed text for that message.
        yield* tx.run(`
          CREATE TRIGGER IF NOT EXISTS \`im_messages_fts_au_content\`
          AFTER UPDATE OF content ON \`im_messages\`
          WHEN new.deleted_at IS NULL
          BEGIN
            DELETE FROM \`im_messages_fts\` WHERE msg_id = new.id;
            INSERT INTO \`im_messages_fts\`(content, msg_id) VALUES (new.content, new.id);
          END;
        `)
        // Soft-delete: evict when deleted_at flips to non-null; re-index on un-delete.
        yield* tx.run(`
          CREATE TRIGGER IF NOT EXISTS \`im_messages_fts_au_delete\`
          AFTER UPDATE OF deleted_at ON \`im_messages\`
          BEGIN
            DELETE FROM \`im_messages_fts\` WHERE msg_id = new.id;
            INSERT INTO \`im_messages_fts\`(content, msg_id)
              SELECT new.content, new.id WHERE new.deleted_at IS NULL;
          END;
        `)
        // Hard delete: evict.
        yield* tx.run(`
          CREATE TRIGGER IF NOT EXISTS \`im_messages_fts_ad\`
          AFTER DELETE ON \`im_messages\`
          BEGIN
            DELETE FROM \`im_messages_fts\` WHERE msg_id = old.id;
          END;
        `)

        // Backfill existing active messages (no-op on a fresh install).
        yield* tx.run(`
          INSERT INTO \`im_messages_fts\`(content, msg_id)
          SELECT content, id FROM \`im_messages\` WHERE deleted_at IS NULL;
        `)
      }).pipe(
        // FTS5 unavailable in this build → skip (repository uses the LIKE fallback). Any partial state is
        // harmless: the runtime feature-detects the table's presence.
        Effect.catchCause(() => Effect.void),
      )
    })
  },
} satisfies DatabaseMigration.Migration
