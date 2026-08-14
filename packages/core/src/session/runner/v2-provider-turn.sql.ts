import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionProviderOwnerLeaseTable } from "../../context-federation/session-sql"
import { SessionTable } from "../sql"
import type { SessionSchema } from "../schema"
import type { PreparedProviderTurn } from "./prepared-provider-turn"

export const V2ProviderTurnReceiptTable = sqliteTable(
  "session_v2_provider_turn_receipt",
  {
    receipt_id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    request_ordinal: integer().notNull(),
    user_message_id: text().notNull(),
    history_prompt_epoch: integer().notNull(),
    history_source_end_message_id: text(),
    request_input_hash: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    protocol: text().notNull(),
    owner_mode: text().$type<"shadow_v2" | "v2">().notNull(),
    owner_token: text()
      .notNull()
      .references(() => SessionProviderOwnerLeaseTable.owner_token),
    state: text()
      .$type<"preparing" | "dispatching" | "streaming" | "settled" | "failed" | "indeterminate_after_crash">()
      .notNull(),
    prepared_turn_hash: text(),
    wire_request_hash: text(),
    prepared_turn: text({ mode: "json" }).$type<PreparedProviderTurn.PreparedProviderTurn>(),
    outcome_hash: text(),
    outcome_artifact: text({ mode: "json" }).$type<readonly unknown[]>(),
    error_code: text(),
    created_at: integer().notNull(),
    dispatching_at: integer(),
    first_event_at: integer(),
    terminal_at: integer(),
  },
  (table) => [
    uniqueIndex("session_v2_provider_turn_receipt_ordinal_idx").on(table.session_id, table.request_ordinal),
    index("session_v2_provider_turn_receipt_input_idx").on(
      table.session_id,
      table.user_message_id,
      table.history_prompt_epoch,
      table.request_input_hash,
    ),
    index("session_v2_provider_turn_receipt_owner_state_idx").on(table.owner_token, table.state, table.created_at),
  ],
)

export const V2ProviderParityBaselineTable = sqliteTable(
  "session_v2_provider_parity_baseline",
  {
    campaign_id: text().notNull(),
    case_name: text().notNull(),
    legacy_receipt_id: text().notNull().unique(),
    state: text().$type<"prepared" | "settled">().notNull(),
    prepared_turn: text({ mode: "json" }).$type<PreparedProviderTurn.PreparedProviderTurn>().notNull(),
    outcome_hash: text(),
    outcome_artifact: text({ mode: "json" }).$type<readonly unknown[]>(),
    legacy_response_fingerprint: text(),
    evidence: text({ mode: "json" }).$type<readonly ("shadow_snapshot" | "recorded_provider")[]>().notNull(),
    receipt_hash: text().notNull(),
    created_at: integer().notNull(),
    settled_at: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.campaign_id, table.case_name] }),
    uniqueIndex("session_v2_provider_parity_baseline_hash_idx").on(table.receipt_hash),
    index("session_v2_provider_parity_baseline_campaign_idx").on(table.campaign_id, table.state),
  ],
)

export const V2ProviderParityReceiptTable = sqliteTable(
  "session_v2_provider_parity_receipt",
  {
    campaign_id: text().notNull(),
    case_name: text().notNull(),
    legacy_receipt_id: text().notNull(),
    core_v2_receipt_id: text()
      .notNull()
      .references(() => V2ProviderTurnReceiptTable.receipt_id),
    legacy_request_hash: text().notNull(),
    core_v2_request_hash: text().notNull(),
    legacy_outcome_hash: text().notNull(),
    core_v2_outcome_hash: text().notNull(),
    legacy_prepared_turn: text({ mode: "json" }).$type<PreparedProviderTurn.PreparedProviderTurn>().notNull(),
    core_v2_prepared_turn: text({ mode: "json" }).$type<PreparedProviderTurn.PreparedProviderTurn>().notNull(),
    diff_artifact: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    allowlist_version: text().notNull(),
    allowlisted_differences: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    disallowed_differences: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    evidence: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    verified: integer({ mode: "boolean" }).notNull(),
    receipt_hash: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.campaign_id, table.case_name] }),
    uniqueIndex("session_v2_provider_parity_receipt_hash_idx").on(table.receipt_hash),
    index("session_v2_provider_parity_receipt_campaign_idx").on(table.campaign_id, table.verified),
  ],
)
