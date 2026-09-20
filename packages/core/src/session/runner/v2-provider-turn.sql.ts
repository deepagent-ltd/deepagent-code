import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "../../context-federation/session-sql"
import { SessionTable } from "../sql"
import type { SessionSchema } from "../schema"
import type { PreparedProviderTurn } from "./prepared-provider-turn"
import type { RuntimeIntegrityEvidenceContract } from "../../contract/runtime-integrity-evidence"

export const V2ProviderTurnReceiptTable = sqliteTable(
  "session_v2_provider_turn_receipt",
  {
    receipt_id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    request_ordinal: integer().notNull(),
    activity_id: text().notNull(),
    provider_turn_seq: integer().notNull(),
    provider_attempt_id: text().references(() => SessionProviderAttemptTable.attempt_id),
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
    /** RI-24 digest-only evidence bound to this immutable provider receipt. */
    integrity_evidence: text({ mode: "json" }).$type<RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidence>(),
    integrity_evidence_hash: text(),
    integrity_evidence_signature: text({ mode: "json" }).$type<RuntimeIntegrityEvidenceContract.SignedRuntimeIntegrityEvidence>(),
  },
  (table) => [
    uniqueIndex("session_v2_provider_turn_receipt_ordinal_idx").on(table.session_id, table.request_ordinal),
    uniqueIndex("session_v2_provider_turn_receipt_activity_turn_idx").on(
      table.session_id,
      table.activity_id,
      table.provider_turn_seq,
    ),
    index("session_v2_provider_turn_receipt_input_idx").on(
      table.session_id,
      table.user_message_id,
      table.history_prompt_epoch,
      table.request_input_hash,
    ),
    index("session_v2_provider_turn_receipt_owner_state_idx").on(table.owner_token, table.state, table.created_at),
  ],
)

/**
 * RI-24 independent evidence artifact authority. The provider receipt keeps a digest-only copy
 * for request-local reads, while this table is the durable content-addressed record used by
 * exporters and release gates. It intentionally has no Session foreign key: deleting a Session
 * must not erase the evidence needed to explain a released or investigated provider turn.
 */
export const RuntimeIntegrityEvidenceArtifactTable = sqliteTable(
  "runtime_integrity_evidence_artifact",
  {
    artifact_id: text().primaryKey(),
    receipt_id: text().notNull().unique(),
    session_id: text().notNull(),
    attempt_id: text().notNull(),
    evidence_hash: text().notNull(),
    evidence: text({ mode: "json" }).$type<RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidence>().notNull(),
    signature: text({ mode: "json" }).$type<RuntimeIntegrityEvidenceContract.SignedRuntimeIntegrityEvidence>(),
    created_at: integer().notNull(),
    signed_at: integer(),
  },
  (table) => [
    uniqueIndex("runtime_integrity_evidence_artifact_hash_idx").on(table.evidence_hash),
    index("runtime_integrity_evidence_artifact_session_idx").on(table.session_id, table.created_at),
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

export const V2ProviderRecoveryBridgeTable = sqliteTable("session_v2_provider_recovery_bridge", {
  resolution_id: text().primaryKey(),
  attempt_id: text()
    .notNull()
    .unique()
    .references(() => SessionProviderAttemptTable.attempt_id, { onDelete: "cascade" }),
  receipt_id: text()
    .notNull()
    .unique()
    .references(() => V2ProviderTurnReceiptTable.receipt_id, { onDelete: "cascade" }),
  command_id: text().notNull().unique(),
  created_at: integer().notNull(),
})
