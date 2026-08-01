import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { SessionInputTable, SessionTable } from "../session/sql"

export const SessionActivityTable = sqliteTable(
  "session_activity",
  {
    activity_id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    trigger_input_id: text()
      .notNull()
      .references(() => SessionInputTable.id),
    delivery: text().$type<"steer" | "queue" | "goal_steer">().notNull(),
    state: text().$type<"active" | "settled" | "failed" | "interrupted">().notNull(),
    created_at: integer().notNull(),
    settled_at: integer(),
  },
  (table) => [
    uniqueIndex("session_activity_ordinal_idx").on(table.session_id, table.ordinal),
    uniqueIndex("session_activity_active_idx")
      .on(table.session_id)
      .where(sql`${table.state} = 'active'`),
  ],
)

export const SessionActivityInputTable = sqliteTable(
  "session_activity_input",
  {
    activity_id: text()
      .notNull()
      .references(() => SessionActivityTable.activity_id, { onDelete: "cascade" }),
    input_id: text()
      .notNull()
      .references(() => SessionInputTable.id),
    ordinal: integer().notNull(),
    admitted_seq: integer().notNull(),
    role: text().$type<"trigger" | "steer">().notNull(),
    promoted_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.activity_id, table.input_id] }),
    uniqueIndex("session_activity_input_owner_idx").on(table.input_id),
    uniqueIndex("session_activity_input_ordinal_idx").on(table.activity_id, table.ordinal),
  ],
)

export const SessionContextSelectionTable = sqliteTable(
  "session_context_selection",
  {
    selection_id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    activity_id: text()
      .notNull()
      .references(() => SessionActivityTable.activity_id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    trigger_input_id: text().notNull(),
    location_key: text().notNull(),
    query_fingerprint: text().notNull(),
    authorization_fingerprint: text().notNull(),
    authorization_epoch: integer().notNull(),
    execution_fingerprint: text().notNull(),
    selected_source_fingerprint: text().notNull(),
    observed_location_mutation_epoch: integer().notNull(),
    next_revalidation_at: integer().notNull(),
    graph_revisions: text().notNull(),
    graph_statuses: text().notNull(),
    selected_refs: text().notNull(),
    projection: text().notNull(),
    projection_hash: text().notNull(),
    token_count: integer().notNull(),
    artifact_write_status: text().$type<"available" | "degraded_unavailable">().notNull(),
    artifact_ref: text(),
    inline_audit: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_context_selection_revision_idx").on(table.session_id, table.activity_id, table.revision),
    index("session_context_selection_activity_idx").on(table.session_id, table.activity_id, table.created_at),
  ],
)

export const SessionContextSelectionInputTable = sqliteTable(
  "session_context_selection_input",
  {
    selection_id: text()
      .notNull()
      .references(() => SessionContextSelectionTable.selection_id, { onDelete: "cascade" }),
    input_id: text()
      .notNull()
      .references(() => SessionInputTable.id),
    ordinal: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.selection_id, table.input_id] }),
    uniqueIndex("session_context_selection_input_owner_idx").on(table.input_id),
    uniqueIndex("session_context_selection_input_ordinal_idx").on(table.selection_id, table.ordinal),
  ],
)

export const SessionContextValidationTable = sqliteTable(
  "session_context_validation",
  {
    validation_id: text().primaryKey(),
    selection_id: text()
      .notNull()
      .references(() => SessionContextSelectionTable.selection_id, { onDelete: "cascade" }),
    provider_turn_seq: integer().notNull(),
    authorization_epoch: integer().notNull(),
    egress_epoch: integer().notNull(),
    observed_location_mutation_epoch: integer().notNull(),
    selected_source_fingerprint: text().notNull(),
    validated_at: integer().notNull(),
    valid_until: integer().notNull(),
    outcome: text().$type<"valid" | "invalidated" | "denied" | "timeout">().notNull(),
    reason_code: text().notNull(),
  },
  (table) => [
    uniqueIndex("session_context_validation_observation_idx").on(
      table.selection_id,
      table.provider_turn_seq,
      table.validated_at,
    ),
    index("session_context_validation_lookup_idx").on(table.selection_id, table.provider_turn_seq, table.validated_at),
  ],
)

export const SessionProviderAttemptTable = sqliteTable(
  "session_provider_attempt",
  {
    attempt_id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    activity_id: text()
      .notNull()
      .references(() => SessionActivityTable.activity_id, { onDelete: "cascade" }),
    provider_turn_seq: integer().notNull(),
    selection_id: text()
      .notNull()
      .references(() => SessionContextSelectionTable.selection_id),
    projection_hash: text().notNull(),
    request_hash: text().notNull(),
    provider_id: text().notNull(),
    parent_attempt_id: text(),
    idempotency_key: text(),
    state: text()
      .$type<
        | "prepared"
        | "dispatching"
        | "streaming"
        | "settled"
        | "failed"
        | "indeterminate_after_crash"
        | "resolved_abandoned"
        | "resolved_settled"
        | "resolved_replayed"
      >()
      .notNull(),
    created_at: integer().notNull(),
    first_event_at: integer(),
    settled_at: integer(),
    error_code: text(),
  },
  (table) => [
    uniqueIndex("session_provider_attempt_turn_idx").on(table.session_id, table.provider_turn_seq),
    index("session_provider_attempt_activity_idx").on(table.session_id, table.activity_id, table.state),
  ],
)

export const SessionProviderAttemptResolutionTable = sqliteTable(
  "session_provider_attempt_resolution",
  {
    resolution_id: text().primaryKey(),
    attempt_id: text()
      .notNull()
      .references(() => SessionProviderAttemptTable.attempt_id),
    actor_type: text().$type<"user" | "administrator" | "system">().notNull(),
    actor_id: text().notNull(),
    decision: text().$type<"abandoned" | "settled" | "replayed">().notNull(),
    provider_evidence: text(),
    risk_acknowledged: integer({ mode: "boolean" }).notNull(),
    reason: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [uniqueIndex("session_provider_attempt_resolution_attempt_idx").on(table.attempt_id)],
)

export const ContextArtifactTable = sqliteTable(
  "context_artifact",
  {
    artifact_id: text().primaryKey(),
    security_namespace_id: text().notNull(),
    session_id: text().notNull(),
    selection_id: text().notNull(),
    artifact_ref: text().notNull(),
    schema_version: integer().notNull(),
    content_hash: text().notNull(),
    authorization_fingerprint: text().notNull(),
    encryption_key_id: text().notNull(),
    iv: blob().$type<Uint8Array>(),
    ciphertext: blob().$type<Uint8Array>(),
    auth_tag: blob().$type<Uint8Array>(),
    original_size: integer().notNull(),
    created_at: integer().notNull(),
    expires_at: integer().notNull(),
    deleted_at: integer(),
    delete_reason: text(),
  },
  (table) => [
    uniqueIndex("context_artifact_binding_hash_idx").on(
      table.security_namespace_id,
      table.session_id,
      table.selection_id,
      table.content_hash,
    ),
    index("context_artifact_session_retention_idx").on(table.security_namespace_id, table.session_id, table.expires_at),
  ],
)
