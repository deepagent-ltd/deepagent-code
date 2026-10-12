import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { WorkAuthoritySchema } from "./work-authority.schema"

// Deliberately no Session FK: reserve precedes Session creation and deletion must not erase an
// unknown dispatch or turn a formerly restricted Session identity into an ordinary one.
export const WorkExecutionTable = sqliteTable(
  "work_execution",
  {
    work_id: text().primaryKey(),
    root_work_id: text().notNull(),
    parent_work_id: text(),
    execution_role: text().$type<"agent" | "dag_controller">().notNull().default("agent"),
    session_id: text().notNull(),
    input_id: text().notNull(),
    source_kind: text().notNull(),
    authority_id: text().notNull(),
    source_request_id: text().notNull(),
    source_revision: integer().notNull(),
    source_record_hash: text().notNull(),
    route_evidence_hash: text().notNull(),
    binding_hash: text().notNull(),
    binding_version: integer().notNull().default(1),
    binding: text({ mode: "json" }).$type<WorkAuthoritySchema.Binding>().notNull(),
    security_namespace_id: text().notNull(),
    agent_id: text().notNull(),
    admission_state: text().$type<WorkAuthoritySchema.AdmissionState>().notNull(),
    control_state: text().$type<WorkAuthoritySchema.ControlState>().notNull(),
    outcome: text().$type<WorkAuthoritySchema.Outcome>().notNull(),
    control_revision: integer().notNull(),
    control_receipts: text({ mode: "json" })
      .$type<
        readonly {
          requestID: string
          action: string
          expectedRevision: number
          revision: number
          state: WorkAuthoritySchema.ControlState
        }[]
      >()
      .notNull(),
    admitted_seq: integer(),
    loopback_http: integer({ mode: "boolean" }).notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("work_execution_session_idx").on(table.session_id),
    uniqueIndex("work_execution_input_idx").on(table.input_id),
    uniqueIndex("work_execution_request_idx").on(table.source_kind, table.authority_id, table.source_request_id),
    index("work_execution_root_idx").on(table.root_work_id),
    index("work_execution_hour_idx").on(table.security_namespace_id, table.agent_id, table.created_at),
    check("work_execution_revision_check", sql`${table.source_revision} > 0 AND ${table.control_revision} > 0`),
    check("work_execution_admission_check", sql`${table.admission_state} IN ('reserved','ready','rejected')`),
    check(
      "work_execution_control_check",
      sql`${table.control_state} IN ('active','paused','revoked','cancelled','expired')`,
    ),
    check("work_execution_outcome_check", sql`${table.outcome} IN ('pending','succeeded','failed','unknown')`),
    check("work_execution_source_check", sql`${table.source_kind} IN ('server_operator','server_rule')`),
    check("work_execution_role_check", sql`${table.execution_role}='agent' OR (${table.execution_role}='dag_controller'
      AND ${table.parent_work_id} IS NULL AND ${table.root_work_id}=${table.work_id} AND ${table.source_kind}='server_rule'
      AND json_extract(${table.binding},'$.profile.id')='event_deepseek_dag_v1')`),
    check(
      "work_execution_binding_check",
      sql`json_valid(${table.binding}) AND length(${table.binding_hash}) = 64 AND ${table.binding_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("work_execution_binding_version_check", sql`typeof(${table.binding_version}) = 'integer' AND ${table.binding_version} IN (1,2)
      AND json_type(${table.binding}, '$.schemaVersion') IS 'text'
      AND ((${table.binding_version}=1 AND json_extract(${table.binding}, '$.schemaVersion') IS 'work-execution.v1')
        OR (${table.binding_version}=2 AND json_extract(${table.binding}, '$.schemaVersion') IS 'work-execution.v2'
          AND length(CAST(${table.binding} AS BLOB)) BETWEEN 1 AND 65536))`),
    check("work_execution_ready_check", sql`${table.admission_state} != 'ready' OR ${table.admitted_seq} IS NOT NULL`),
  ],
)

export const WorkDispatchReservationTable = sqliteTable(
  "work_dispatch_reservation",
  {
    reservation_id: text().primaryKey(),
    work_id: text().notNull(),
    root_work_id: text().notNull(),
    // Only provider dispatches are implemented in this slice. Tool/child limits are zero.
    kind: text().$type<"provider">().notNull(),
    dispatch_key: text().notNull(),
    request_hash: text().notNull(),
    receipt_id: text().notNull(),
    attempt_id: text().notNull(),
    session_claim_token: integer().notNull(),
    owner_token: text().notNull(),
    control_revision: integer().notNull(),
    context_selection_id: text().notNull(),
    context_projection_hash: text().notNull(),
    state: text().$type<WorkAuthoritySchema.DispatchState>().notNull(),
    input_bound: text({ mode: "json" }).$type<WorkAuthoritySchema.InputBound>().notNull(),
    reserved_input_tokens: integer().notNull(),
    reserved_completion_tokens: integer().notNull(),
    reserved_total_tokens: integer().notNull(),
    actual_usage: text({ mode: "json" }).$type<WorkAuthoritySchema.Usage>(),
    charged_tokens: integer().notNull(),
    wire_hash: text(),
    endpoint: text(),
    error_code: text(),
    created_at: integer().notNull(),
    dispatching_at: integer(),
    settled_at: integer(),
  },
  (table) => [
    uniqueIndex("work_dispatch_key_idx").on(table.work_id, table.kind, table.dispatch_key),
    uniqueIndex("work_dispatch_receipt_idx").on(table.receipt_id),
    uniqueIndex("work_dispatch_attempt_idx").on(table.attempt_id),
    index("work_dispatch_root_idx").on(table.root_work_id, table.state),
    index("work_dispatch_work_time_idx").on(table.work_id, table.created_at),
    check("work_dispatch_kind_check", sql`${table.kind} = 'provider'`),
    check(
      "work_dispatch_state_check",
      sql`${table.state} IN ('reserved','dispatching','settled','released','unknown')`,
    ),
    check(
      "work_dispatch_tokens_check",
      sql`${table.reserved_input_tokens} >= 0 AND ${table.reserved_completion_tokens} >= 0 AND ${table.reserved_total_tokens} = ${table.reserved_input_tokens} + ${table.reserved_completion_tokens} AND ${table.charged_tokens} >= 0`,
    ),
    check("work_dispatch_revision_check", sql`${table.control_revision} > 0 AND ${table.session_claim_token} > 0`),
    check(
      "work_dispatch_seal_check",
      sql`${table.state} NOT IN ('dispatching','settled','unknown') OR (${table.wire_hash} IS NOT NULL AND ${table.endpoint} IS NOT NULL AND ${table.dispatching_at} IS NOT NULL)`,
    ),
  ],
)
