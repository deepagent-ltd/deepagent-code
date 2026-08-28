// BUG-010: bounded, non-sensitive evidence for the Provider argument pipeline.
// Values are never persisted; only hashes, lengths, and a bounded key list are kept.
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export type ToolArgumentReceiptLayer = "raw_frame" | "ai_sdk_input" | "adapter_assembly" | "processor_decoded"
export type ToolArgumentValidationOutcome =
  | "not_evaluated"
  | "schema_valid"
  | "schema_invalid"
  | "semantic_valid"
  | "semantic_invalid"
  | "conflict"
  | "no_progress"

export const SessionToolArgumentReceiptTable = sqliteTable(
  "session_tool_argument_receipt",
  {
    receipt_id: text().notNull(),
    layer: text().$type<ToolArgumentReceiptLayer>().notNull(),
    ordinal: integer().notNull(),
    call_id: text(),
    tool_name: text(),
    event_type: text().notNull(),
    payload_hash: text(),
    payload_length: integer(),
    payload_keys: text({ mode: "json" }).$type<string[]>().notNull(),
    unavailable_reason: text(),
    validation_outcome: text().$type<ToolArgumentValidationOutcome>().notNull().default("not_evaluated"),
    created_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.receipt_id, table.layer, table.ordinal] })],
)
