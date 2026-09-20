import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907130000_migration_journal_content_hash",
  up(tx) {
    return Effect.gen(function* () {
      const columns = yield* tx.all<{ name: string }>("PRAGMA table_info('migration')")
      if (!columns.some((column) => column.name === "content_hash"))
        yield* tx.run("ALTER TABLE migration ADD COLUMN content_hash TEXT")

      // The receipt table is created by the migration runner's bootstrap schema, not by
      // the historical `migration` table itself. Older fixture databases can therefore
      // legitimately reach this migration before that table exists. In that case there
      // is no durable evidence to backfill; leave the legacy rows NULL and continue.
      const receiptTable = yield* tx.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_migration_receipt' LIMIT 1",
      )
      if (receiptTable.length === 0) return

      // Only a durable receipt is evidence for an old journal row. Never stamp historical rows
      // from the current registry alone: an unverifiable legacy row stays NULL.
      yield* tx.run(`
        UPDATE migration
        SET content_hash = (
          SELECT receipt.content_hash
          FROM database_migration_receipt receipt
          WHERE receipt.migration_id = migration.id
          ORDER BY receipt.completed_at DESC
          LIMIT 1
        )
        WHERE content_hash IS NULL
          AND EXISTS (
            SELECT 1 FROM database_migration_receipt receipt
            WHERE receipt.migration_id = migration.id
          )
      `)
    })
  },
} satisfies DatabaseMigration.Migration
