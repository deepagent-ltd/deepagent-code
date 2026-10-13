// Historical schema shapes only. These tables do not authorize or execute IM tasks.
// Keep existing migrations and columns unchanged so old databases remain readable.
import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Business authorization facts; execution state and all escrow remain owned by WorkAuthority.
// No cascading FK: deleting chat history must not erase a grant or its audit snapshot.
export const RetiredIMTaskSourceTable = sqliteTable(
  "im_task_source",
  {
    source_id: text().primaryKey(),
    message_id: text().notNull(),
    instance_id: text().notNull(),
    proof: text({ mode: "json" }).$type<unknown>().notNull(),
    proof_hash: text().notNull(),
    snapshot: text({ mode: "json" }).$type<unknown>().notNull(),
    snapshot_hash: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("im_task_source_message_idx").on(table.instance_id, table.message_id),
    check("im_task_source_json_check", sql`json_valid(${table.proof}) AND json_valid(${table.snapshot})`),
  ],
)

export const RetiredIMTaskRequestTable = sqliteTable(
  "im_task_request",
  {
    request_id: text().primaryKey(),
    client_request_id: text().notNull(),
    source_id: text().notNull(),
    instance_id: text().notNull(),
    actor_id: text().notNull(),
    request_hash: text().notNull(),
    audited_text: text().notNull(),
    audited_text_hash: text().notNull(),
    target: text({ mode: "json" }).$type<unknown>().notNull(),
    result_key: text().notNull(),
    state: text().$type<unknown>().notNull(),
    revision: integer().notNull(),
    created_at: integer().notNull(),
    expires_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("im_task_request_client_idx").on(table.instance_id, table.actor_id, table.client_request_id),
    check("im_task_request_state_check", sql`${table.state} IN ('proposed','accepted') AND ${table.revision} > 0`),
    check("im_task_request_json_check", sql`json_valid(${table.target}) AND ${table.expires_at} > ${table.created_at}`),
  ],
)

export const RetiredIMTaskGrantTable = sqliteTable(
  "im_task_grant",
  {
    grant_id: text().primaryKey(),
    request_id: text().notNull(),
    ordinal: integer().notNull(),
    instance_id: text().notNull(),
    actor_id: text().notNull(),
    principal: text({ mode: "json" }).$type<unknown>().notNull(),
    target_proof: text({ mode: "json" }).$type<unknown>().notNull(),
    source_proof_hash: text().notNull(),
    source_snapshot_hash: text().notNull(),
    request_hash: text().notNull(),
    binding: text({ mode: "json" }).$type<unknown>().notNull(),
    record_hash: text().notNull(),
    work_id: text().notNull(),
    session_id: text().notNull(),
    input_id: text().notNull(),
    result_key: text().notNull(),
    state: text().$type<unknown>().notNull(),
    revision: integer().notNull(),
    accept_request_id: text().notNull(),
    accept_expected_revision: integer().notNull(),
    revoke_request_id: text(),
    revoke_expected_revision: integer(),
    revoked_at: integer(),
    created_at: integer().notNull(),
    expires_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("im_task_grant_request_idx").on(table.request_id, table.ordinal),
    uniqueIndex("im_task_grant_work_idx").on(table.work_id),
    uniqueIndex("im_task_grant_session_idx").on(table.session_id),
    uniqueIndex("im_task_grant_input_idx").on(table.input_id),
    uniqueIndex("im_task_grant_result_idx").on(table.result_key),
    check(
      "im_task_grant_state_check",
      sql`${table.state} IN ('active','revoked') AND ${table.revision} > 0 AND ${table.ordinal} = 1`,
    ),
    check(
      "im_task_grant_json_check",
      sql`json_valid(${table.principal}) AND json_valid(${table.target_proof}) AND json_valid(${table.binding})`,
    ),
    check(
      "im_task_grant_revoke_check",
      sql`${table.state} != 'revoked' OR (${table.revoke_request_id} IS NOT NULL AND ${table.revoked_at} IS NOT NULL)`,
    ),
  ],
)

// Immutable disposition and disclosure identity. Outbox/transport rows follow this insert;
// no FK to those not-yet-created rows or to a possibly absent execution Session is valid.
export const RetiredIMTaskStatusNoticeTable = sqliteTable(
  "im_task_status_notice",
  {
    notice_id: text().primaryKey().notNull(),
    instance_id: text().notNull(),
    actor_id: text().notNull(),
    request_id: text().notNull(),
    request_revision: integer().notNull(),
    request_hash: text().notNull(),
    source_id: text().notNull(),
    source_message_id: text().notNull(),
    source_proof_hash: text().notNull(),
    source_snapshot_hash: text().notNull(),
    kind: text().$type<"cancel_requested" | "recovery_required" | "refused">().notNull(),
    occurrence_key: text().notNull(),
    basis_hash: text().notNull(),
    grant_id: text(),
    grant_revision: integer(),
    work_id: text(),
    session_id: text(),
    control_revision: integer(),
    group_id: text().notNull(),
    agent_id: text().notNull(),
    outbox_id: text().notNull(),
    delivery_message_id: text().notNull(),
    record: text().notNull(),
    record_hash: text().notNull(),
    record_bytes: integer().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    foreignKey({ columns: [table.request_id], foreignColumns: [RetiredIMTaskRequestTable.request_id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("im_task_notice_occurrence_idx").on(table.instance_id, table.request_id, table.occurrence_key),
    uniqueIndex("im_task_notice_refused_idx")
      .on(table.request_id)
      .where(sql`${table.kind}='refused'`),
    uniqueIndex("im_task_notice_outbox_idx").on(table.outbox_id),
    uniqueIndex("im_task_notice_delivery_idx").on(table.delivery_message_id),
    index("im_task_notice_instance_idx").on(table.instance_id, table.created_at, table.notice_id),
    index("im_task_notice_request_idx").on(table.request_id, table.created_at, table.notice_id),
    check("im_task_notice_kind_check", sql`${table.kind} IN ('cancel_requested','recovery_required','refused')`),
    check(
      "im_task_notice_record_check",
      sql`json_valid(${table.record}) AND typeof(${table.record_bytes})='integer' AND ${table.record_bytes} BETWEEN 2 AND 32768 AND ${table.record_bytes}=length(CAST(${table.record} AS BLOB))`,
    ),
    check(
      "im_task_notice_revision_check",
      sql`${table.request_revision}>0 AND ${table.created_at}>=0 AND (${table.grant_revision} IS NULL OR ${table.grant_revision}>0) AND (${table.control_revision} IS NULL OR ${table.control_revision}>0)`,
    ),
    check(
      "im_task_notice_refused_check",
      sql`${table.kind}!='refused' OR (${table.grant_id} IS NULL AND ${table.grant_revision} IS NULL AND ${table.work_id} IS NULL AND ${table.session_id} IS NULL AND ${table.control_revision} IS NULL)`,
    ),
  ],
)

export const RetiredIMTaskConversationTable = sqliteTable(
  "im_local_task_conversation",
  {
    group_id: text().primaryKey(),
    instance_id: text().notNull(),
    operator_id: text().notNull(),
    operator_revision: integer().notNull(),
    target_id: text().notNull(),
    revision: integer().notNull(),
    mode: text().$type<"explicit_task">().notNull(),
    target: text({ mode: "json" }).$type<unknown>().notNull(),
    target_hash: text().notNull(),
    location_key: text().notNull(),
    namespace_binding_hash: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    check(
      "im_local_task_conversation_hash_check",
      sql`length(${table.target_hash}) = 64 AND ${table.target_hash} NOT GLOB '*[^0-9a-f]*' AND length(${table.namespace_binding_hash}) = 64 AND ${table.namespace_binding_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "im_local_task_conversation_mode_check",
      sql`${table.mode} = 'explicit_task' AND ${table.revision} > 0 AND ${table.operator_revision} > 0`,
    ),
    check(
      "im_local_task_conversation_target_check",
      sql`json_valid(${table.target}) AND json_type(${table.target}) = 'object'`,
    ),
  ],
)

// No cascading FK: history deletion must not erase the fact that an origin was accepted or revoked.
export const RetiredIMOriginReceiptTable = sqliteTable(
  "im_local_origin_receipt",
  {
    message_id: text().primaryKey(),
    instance_id: text().notNull(),
    operator_id: text().notNull(),
    operator_revision: integer().notNull(),
    credential_generation: integer().notNull(),
    group_id: text().notNull(),
    conversation_revision: integer().notNull(),
    raw_snapshot: text({ mode: "json" }).$type<unknown>().notNull(),
    raw_snapshot_hash: text().notNull(),
    proof: text({ mode: "json" }).$type<unknown>().notNull(),
    receipt_hash: text().notNull(),
    origin: text().$type<"authenticated_local_text">().notNull(),
    received_at: integer().notNull(),
    expires_at: integer().notNull(),
  },
  (table) => [
    check(
      "im_local_origin_hash_check",
      sql`length(${table.raw_snapshot_hash}) = 64 AND ${table.raw_snapshot_hash} NOT GLOB '*[^0-9a-f]*' AND length(${table.receipt_hash}) = 64 AND ${table.receipt_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "im_local_origin_revision_check",
      sql`${table.operator_revision} > 0 AND ${table.credential_generation} > 0 AND ${table.conversation_revision} > 0`,
    ),
    check(
      "im_local_origin_kind_check",
      sql`${table.origin} = 'authenticated_local_text' AND ${table.expires_at} > ${table.received_at}`,
    ),
    check(
      "im_local_origin_json_check",
      sql`json_valid(${table.raw_snapshot}) AND json_type(${table.raw_snapshot}) = 'object' AND json_valid(${table.proof}) AND json_type(${table.proof}) = 'object'`,
    ),
  ],
)

export type RetiredIMSingleWriteStatus = "single_written" | "refused"

export const RetiredIMSingleWriteTable = sqliteTable(
  "deepagent_im_single_write",
  {
    // The durable dedupe identity of the IM user message (never a second authority for it).
    im_message_id: text().primaryKey(),
    // The EventV2 work envelope identity admitted via the E4a admission bridge.
    event_ref: text().notNull(),
    // The single execution owner that claims this IM input (process/SessionExecution owner token).
    owner_id: text().notNull(),
    generation: integer().notNull(),
    // The durable admission receipt reference returned by the E4a admission bridge.
    receipt_ref: text().notNull(),
    status: text().$type<RetiredIMSingleWriteStatus>().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("deepagent_im_single_write_event_idx").on(table.event_ref),
    index("deepagent_im_single_write_owner_idx").on(table.owner_id),
  ],
)
