import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

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
    // Private native read evidence. Public terminal projections omit this
    // envelope; its signature never creates permission to perform a new read.
    known_read_proof: text(),
    // Kept separate from read evidence and every public/historical projection.
    known_write_proof: text(),
    // Private command evidence has a distinct fixed purpose and cannot be
    // interpreted as native read/write proof or exposed by history projections.
    known_command_proof: text(),
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
  (table) => [
    uniqueIndex("session_v2_tool_effect_call_idx").on(table.receipt_id, table.tool_call_id),
    check(
      "session_v2_tool_effect_known_read_proof_check",
      sql`${table.known_read_proof} IS NULL OR CASE WHEN typeof(${table.known_read_proof}) = 'text' AND length(CAST(${table.known_read_proof} AS BLOB)) BETWEEN 1 AND 16384 AND instr(${table.known_read_proof}, char(0)) = 0 AND json_valid(${table.known_read_proof}) THEN coalesce(json_type(${table.known_read_proof}) = 'object' AND json_type(${table.known_read_proof}, '$.version') = 'integer' AND json_extract(${table.known_read_proof}, '$.version') = 1 AND ${table.effect_kind} = 'read_only' AND ${table.state} = 'settled' AND ${table.error_code} IS NULL, 0) ELSE 0 END`,
    ),
    check(
      "session_v2_tool_effect_known_write_proof_check",
      sql`${table.known_write_proof} IS NULL OR CASE WHEN typeof(${table.known_write_proof}) = 'text' AND length(CAST(${table.known_write_proof} AS BLOB)) BETWEEN 1 AND 16384 AND instr(${table.known_write_proof}, char(0)) = 0 AND json_valid(${table.known_write_proof}) THEN coalesce(json_type(${table.known_write_proof}) = 'object' AND json_type(${table.known_write_proof}, '$.version') = 'integer' AND json_extract(${table.known_write_proof}, '$.version') = 1 AND ${table.effect_kind} = 'mutating' AND ${table.state} = 'settled' AND ${table.error_code} IS NULL AND ${table.known_read_proof} IS NULL, 0) ELSE 0 END`,
    ),
    check(
      "session_v2_tool_effect_known_command_proof_check",
      sql`${table.known_command_proof} IS NULL OR CASE WHEN typeof(${table.known_command_proof}) = 'text' AND length(CAST(${table.known_command_proof} AS BLOB)) BETWEEN 1 AND 16384 AND instr(${table.known_command_proof}, char(0)) = 0 AND json_valid(${table.known_command_proof}) THEN coalesce(json_type(${table.known_command_proof}) = 'object' AND json_type(${table.known_command_proof}, '$.version') = 'integer' AND json_extract(${table.known_command_proof}, '$.version') = 1 AND ${table.tool_name} = 'managed_command' AND ${table.effect_kind} = 'mutating' AND ${table.state} = 'settled' AND ${table.error_code} IS NULL AND ${table.known_read_proof} IS NULL AND ${table.known_write_proof} IS NULL, 0) ELSE 0 END`,
    ),
  ],
)
