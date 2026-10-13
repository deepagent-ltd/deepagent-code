import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ImportJobSchema } from "./import-job/schema"

export const ImportJobTable = sqliteTable(
  "import_job",
  {
    job_id: text().primaryKey(),
    operator_id: text().notNull(),
    request_id: text().notNull(),
    request_digest: text().notNull(),
    request: text({ mode: "json" }).$type<ImportJobSchema.Request>().notNull(),
    state: text().$type<ImportJobSchema.State>().notNull(),
    revision: integer().notNull(),
    source_digest: text(),
    source_snapshot_path: text(),
    source_format_revision: integer().notNull(),
    total_sessions: integer().notNull(),
    target: text({ mode: "json" }).$type<ImportJobSchema.Target>(),
    target_key: text().notNull(),
    migration_digest: text().notNull(),
    owner_id: text(),
    owner_lease_expires_at: integer(),
    active_batch_id: text(),
    committed_batches: integer().notNull(),
    failed_batches: integer().notNull(),
    cancel_requested_at: integer(),
    stop_confirmed_at: integer(),
    error_code: text(),
    error_detail: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    settled_at: integer(),
  },
  (table) => [
    uniqueIndex("import_job_request_idx").on(table.operator_id, table.request_id),
    index("import_job_created_idx").on(table.operator_id, table.created_at, table.job_id),
    index("import_job_target_idx").on(table.target_key, table.state),
    check("import_job_operator_check", sql`${table.operator_id} = 'server'`),
    check(
      "import_job_state_check",
      sql`${table.state} IN ('preflight','ready','running','cancel_requested','completed','failed','cancelled','cancelled_partial','recovery_required')`,
    ),
    check(
      "import_job_counts_check",
      sql`${table.revision} >= 0 AND ${table.total_sessions} >= 0 AND ${table.committed_batches} >= 0 AND ${table.failed_batches} >= 0`,
    ),
    check(
      "import_job_digest_check",
      sql`length(${table.request_digest}) = 64 AND ${table.request_digest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "import_job_stop_check",
      sql`${table.state} NOT IN ('cancelled','cancelled_partial') OR ${table.stop_confirmed_at} IS NOT NULL`,
    ),
  ],
)

// This receipt lives in the actual destination DB. There is deliberately no FK to the
// control DB's job row: copy imports and their authority are different databases.
export const ImportBatchReceiptTable = sqliteTable(
  "import_batch_receipt",
  {
    job_id: text().notNull(),
    batch_id: text().notNull(),
    source_id: text().notNull(),
    source_digest: text().notNull(),
    target_id: text().notNull(),
    result: text({ mode: "json" }).$type<ImportJobSchema.BatchResult>().notNull(),
    committed_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.job_id, table.batch_id] }),
    index("import_batch_job_idx").on(table.job_id, table.committed_at),
    check(
      "import_batch_digest_check",
      sql`length(${table.source_digest}) = 64 AND ${table.source_digest} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
)
