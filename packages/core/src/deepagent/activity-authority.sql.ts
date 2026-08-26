import { sql } from "drizzle-orm"
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/sql"
import { ProjectV2 } from "../project"
import { SessionTable } from "../session/sql"
import type { SessionSchema } from "../session/schema"
import type { CompletionCriterion } from "./goal-loop"

export type ActivityKind = "legacy" | "v2" | "facade"
export type FacadeActivitySubkind = "task" | "goal" | "panel"
export type FacadeActivityState = "active" | "settled" | "failed" | "interrupted" | "recovery_required"
export type ActivityObjectiveState = "active" | "completed" | "needs_human" | "interrupted" | "recovery_required"
export type PermissionRequestState =
  | "pending"
  | "approved_once"
  | "approved_always"
  | "denied"
  | "expired"
  | "interrupted"
export type PermissionEffectDispatchState = "started" | "settled" | "unknown"

export const SessionActivityObjectiveTable = sqliteTable(
  "session_activity_objective",
  {
    activity_kind: text().$type<ActivityKind>().notNull(),
    activity_id: text().notNull(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    admission_fingerprint: text().notNull(),
    objective_fingerprint: text(),
    objective_text: text(),
    completion_criteria: text({ mode: "json" }).$type<readonly CompletionCriterion[]>().notNull(),
    enforcement_state: text().$type<"disabled" | "monitoring">().notNull(),
    stall_threshold: integer(),
    state: text().$type<ActivityObjectiveState>().notNull(),
    no_progress_count: integer().notNull(),
    latest_observation_revision: integer().notNull(),
    latest_vector_hash: text(),
    next_action: text(),
    terminal_reason: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    settled_at: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.activity_kind, table.activity_id] }),
    index("session_activity_objective_session_idx").on(table.session_id, table.state, table.updated_at),
  ],
)

// FEAT-011 T1 — facade activity base table. Mirrors the session_legacy_activity terminal
// semantics (active carries no settled_at/reason_code; terminal states require both) and the
// v2 single-active invariant, scoped per parent session + subkind: opening a new facade
// activity requires settling the previous active one of the same subkind first (BUG-004).
export const SessionFacadeActivityTable = sqliteTable(
  "session_facade_activity",
  {
    activity_id: text().primaryKey(),
    subkind: text().$type<FacadeActivitySubkind>().notNull(),
    parent_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    owner_token: text(),
    owner_session_id: text()
      .$type<SessionSchema.ID>()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    spawn_tool_call_id: text(),
    objective_text: text(),
    budget_json: text({ mode: "json" }).$type<unknown>(),
    state: text().$type<FacadeActivityState>().notNull(),
    reason_code: text(),
    source: text(),
    created_at: integer().notNull(),
    settled_at: integer(),
    mutation_epoch: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_facade_activity_active_idx")
      .on(table.parent_session_id, table.subkind)
      .where(sql`${table.state} = 'active'`),
    index("session_facade_activity_parent_idx").on(table.parent_session_id, table.state, table.created_at),
  ],
)

export const SessionActivityEvidenceTable = sqliteTable(
  "session_activity_evidence",
  {
    activity_kind: text().$type<ActivityKind>().notNull(),
    activity_id: text().notNull(),
    evidence_fingerprint: text().notNull(),
    evidence_kind: text().notNull(),
    source_receipt_id: text(),
    first_observation_revision: integer().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.activity_kind, table.activity_id, table.evidence_fingerprint] }),
    index("session_activity_evidence_activity_idx").on(
      table.activity_kind,
      table.activity_id,
      table.first_observation_revision,
    ),
  ],
)

export const SessionActivityEffectReceiptTable = sqliteTable(
  "session_activity_effect_receipt",
  {
    activity_kind: text().$type<ActivityKind>().notNull(),
    activity_id: text().notNull(),
    receipt_id: text().notNull(),
    effect_fingerprint: text().notNull(),
    first_observation_revision: integer().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.activity_kind, table.activity_id, table.receipt_id] }),
    index("session_activity_effect_receipt_activity_idx").on(
      table.activity_kind,
      table.activity_id,
      table.first_observation_revision,
    ),
  ],
)

export const SessionActivityProgressObservationTable = sqliteTable(
  "session_activity_progress_observation",
  {
    activity_kind: text().$type<ActivityKind>().notNull(),
    activity_id: text().notNull(),
    revision: integer().notNull(),
    idempotency_key: text().notNull(),
    observation_fingerprint: text().notNull(),
    expected_objective_version: integer().notNull(),
    workspace_revision: text(),
    plan_version: integer(),
    validation_fingerprint: text(),
    evidence_set_hash: text().notNull(),
    effect_receipt_set_hash: text().notNull(),
    vector_hash: text().notNull(),
    next_action: text(),
    changed: integer({ mode: "boolean" }).notNull(),
    no_progress_count: integer().notNull(),
    observed_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.activity_kind, table.activity_id, table.revision] }),
    uniqueIndex("session_activity_progress_observation_idempotency_idx").on(table.idempotency_key),
    index("session_activity_progress_observation_latest_idx").on(
      table.activity_kind,
      table.activity_id,
      table.observed_at,
    ),
  ],
)

export const SessionActivityPermissionRequestTable = sqliteTable(
  "session_activity_permission_request",
  {
    request_id: text().primaryKey(),
    activity_kind: text().$type<ActivityKind>().notNull(),
    activity_id: text().notNull(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text(),
    request_kind: text().$type<"tool" | "no_progress">().notNull(),
    idempotency_key: text().notNull(),
    permission: text().notNull(),
    patterns: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    always_patterns: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    metadata_hash: text().notNull(),
    tool_message_id: text(),
    tool_call_id: text(),
    state: text().$type<PermissionRequestState>().notNull(),
    authority_epoch: integer().notNull(),
    requested_scope: text().$type<"once" | "project">().notNull(),
    owner_type: text().$type<"runtime" | "system">().notNull(),
    owner_id: text().notNull(),
    created_at: integer().notNull(),
    expires_at: integer(),
    decided_at: integer(),
  },
  (table) => [
    uniqueIndex("session_activity_permission_request_idempotency_idx").on(table.idempotency_key),
    uniqueIndex("session_activity_permission_request_pending_no_progress_idx")
      .on(table.activity_kind, table.activity_id)
      .where(sql`${table.state} = 'pending' AND ${table.request_kind} = 'no_progress'`),
    index("session_activity_permission_request_pending_idx").on(table.session_id, table.state, table.created_at),
  ],
)

export const SessionActivityPermissionOwnerLeaseTable = sqliteTable(
  "session_activity_permission_owner_lease",
  {
    owner_id: text().primaryKey().notNull(),
    lease_expires_at: integer().notNull(),
    heartbeat_at: integer().notNull(),
  },
  (table) => [index("session_activity_permission_owner_lease_expiry_idx").on(table.lease_expires_at, table.owner_id)],
)

export const SessionActivityPermissionDecisionTable = sqliteTable(
  "session_activity_permission_decision",
  {
    decision_id: text().primaryKey(),
    request_id: text().notNull(),
    idempotency_key: text().notNull(),
    decision: text().$type<"approved_once" | "approved_always" | "denied" | "expired" | "interrupted">().notNull(),
    actor_type: text().$type<"user" | "administrator" | "system">().notNull(),
    actor_id: text().notNull(),
    scope: text().$type<"once" | "project">().notNull(),
    authority_epoch: integer().notNull(),
    decided_at: integer().notNull(),
    expires_at: integer(),
    feedback: text(),
  },
  (table) => [
    uniqueIndex("session_activity_permission_decision_request_idx").on(table.request_id),
    uniqueIndex("session_activity_permission_decision_idempotency_idx").on(table.idempotency_key),
  ],
)

export const SessionActivityPermissionOnceConsumptionTable = sqliteTable(
  "session_activity_permission_once_consumption",
  {
    request_id: text().primaryKey(),
    consumer_id: text().notNull(),
    idempotency_key: text().notNull(),
    consumed_at: integer().notNull(),
  },
  (table) => [uniqueIndex("session_activity_permission_once_consumption_idempotency_idx").on(table.idempotency_key)],
)

export const SessionActivityPermissionEffectDispatchTable = sqliteTable(
  "session_activity_permission_effect_dispatch",
  {
    receipt_id: text().primaryKey(),
    request_id: text()
      .notNull()
      .references(() => SessionActivityPermissionRequestTable.request_id, { onDelete: "cascade" }),
    activity_kind: text().$type<ActivityKind>().notNull(),
    activity_id: text().notNull(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text(),
    tool_message_id: text().notNull(),
    tool_call_id: text().notNull(),
    tool_name: text().notNull(),
    consumer_id: text().notNull(),
    idempotency_key: text().notNull(),
    owner_id: text().notNull(),
    state: text().$type<PermissionEffectDispatchState>().notNull(),
    version: integer().notNull(),
    outcome: text().$type<"success" | "failure">(),
    result_json: text({ mode: "json" }).$type<unknown>(),
    result_hash: text(),
    started_at: integer().notNull(),
    settled_at: integer(),
  },
  (table) => [
    uniqueIndex("session_activity_permission_effect_dispatch_request_idx").on(table.request_id),
    uniqueIndex("session_activity_permission_effect_dispatch_idempotency_idx").on(table.idempotency_key),
    index("session_activity_permission_effect_dispatch_activity_idx").on(
      table.activity_kind,
      table.activity_id,
      table.state,
      table.started_at,
    ),
    index("session_activity_permission_effect_dispatch_owner_idx").on(table.owner_id, table.state, table.started_at),
  ],
)
