import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Durable structured-output evidence authority for V2 TaskRun settlements: one row per
// schema-bound run, recording the final structured-contract verdict and binding it to the V2
// session_message that carries the final answer. Append-only, insert-guarded, immutable — the
// receipt-style authority twin of session_v2_task_run_receipt for the structured contract.
export const V2StructuredOutputEvidenceTable = sqliteTable(
  "session_v2_structured_output_evidence",
  {
    evidence_id: text().primaryKey(),
    run_id: text().notNull(),
    session_id: text().notNull(),
    child_session_id: text().notNull(),
    output_message_id: text().$type<string>(),
    schema_name: text().notNull(),
    validation_outcome: text()
      .$type<"validated" | "validation_failed" | "unvalidated">()
      .notNull(),
    output_sha256: text().notNull(),
    schema_sha256: text().notNull(),
    raw_output: text().notNull(),
    owner_token: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_v2_structured_output_evidence_run_idx").on(table.run_id),
    index("session_v2_structured_output_evidence_session_idx").on(table.session_id, table.time_created),
  ],
)
