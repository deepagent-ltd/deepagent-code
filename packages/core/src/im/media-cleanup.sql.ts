import { sql } from "drizzle-orm"
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// Write-side cleanup rotates durably past failures. A cursor never authorizes a file
// deletion or releases capacity; the exact attachment and file identity still do that.
export const MediaCleanupCursorTable = sqliteTable(
  "im_media_cleanup_cursor",
  {
    workspace_id: text().primaryKey().notNull(),
    after_created_at: integer(),
    after_id: text(),
    revision: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    check(
      "im_media_cleanup_cursor_workspace_check",
      // Implicit-local workspace identity is the directory, rather than an opaque ID.
      sql`typeof(${table.workspace_id}) = 'text' AND length(CAST(${table.workspace_id} AS BLOB)) BETWEEN 1 AND 16384 AND instr(${table.workspace_id}, char(0)) = 0`,
    ),
    check(
      "im_media_cleanup_cursor_position_check",
      sql`(${table.after_created_at} IS NULL AND ${table.after_id} IS NULL) OR (typeof(${table.after_created_at}) = 'integer' AND ${table.after_created_at} BETWEEN 0 AND 9007199254740991 AND typeof(${table.after_id}) = 'text' AND length(CAST(${table.after_id} AS BLOB)) BETWEEN 1 AND 512 AND instr(${table.after_id}, char(0)) = 0)`,
    ),
    check(
      "im_media_cleanup_cursor_revision_check",
      sql`typeof(${table.revision}) = 'integer' AND ${table.revision} BETWEEN 0 AND 9007199254740991 AND typeof(${table.updated_at}) = 'integer' AND ${table.updated_at} BETWEEN 0 AND 9007199254740991`,
    ),
  ],
)
