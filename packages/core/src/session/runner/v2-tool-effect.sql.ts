import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Durable pre-side-effect admission. A terminal effect row without this matching receipt is invalid;
// an admission without a terminal row is an unknown outcome and must never be auto-replayed.
export const V2ToolEffectAdmissionTable = sqliteTable(
  "session_v2_tool_effect_admission",
  {
    admission_id: text().primaryKey(),
    session_id: text().notNull(),
    provider_attempt_id: text().notNull(),
    receipt_id: text().notNull(),
    tool_call_id: text().notNull(),
    tool_name: text().notNull(),
    effect_kind: text().$type<"mutating" | "read_only">().notNull(),
    owner_token: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_v2_tool_effect_admission_call_idx").on(table.receipt_id, table.tool_call_id),
    index("session_v2_tool_effect_admission_session_idx").on(table.session_id, table.time_created),
  ],
)

// Durable terminal authority for V2 tool effects: one row per settled tool call, bound to the
// provider attempt and receipt that offered it. Terminal-only admission keeps the table an
// append-only evidence source for watermark proofs and recovery classification.
export const V2ToolEffectTable = sqliteTable(
  "session_v2_tool_effect",
  {
    effect_id: text().primaryKey(),
    session_id: text().notNull(),
    provider_attempt_id: text().notNull(),
    receipt_id: text().notNull(),
    tool_call_id: text().notNull(),
    tool_name: text().notNull(),
    effect_kind: text().$type<"mutating" | "read_only">().notNull(),
    state: text().$type<"settled" | "failed">().notNull(),
    outcome_hash: text().notNull(),
    error_code: text(),
    // Permission grant evidence: all four columns are set together or none (insert guard). An
    // effect bound to a grant proves which permission dispatch authorized the tool call.
    grant_receipt_id: text(),
    grant_owner_id: text(),
    grant_state: text().$type<"started" | "settled" | "unknown">(),
    grant_version: integer(),
    owner_token: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [uniqueIndex("session_v2_tool_effect_call_idx").on(table.receipt_id, table.tool_call_id)],
)
