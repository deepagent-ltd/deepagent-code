import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { IMTaskAuthoritySchema } from "./task-authority.schema"
import type { WorkAuthoritySchema } from "../session/work-authority.schema"

// Business authorization facts; execution state and all escrow remain owned by WorkAuthority.
// No cascading FK: deleting chat history must not erase a grant or its audit snapshot.
export const IMTaskSourceTable = sqliteTable(
  "im_task_source",
  {
    source_id: text().primaryKey(),
    message_id: text().notNull(),
    instance_id: text().notNull(),
    proof: text({ mode: "json" }).$type<IMTaskAuthoritySchema.SourceProof>().notNull(),
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

export const IMTaskRequestTable = sqliteTable(
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
    target: text({ mode: "json" }).$type<IMTaskAuthoritySchema.Target>().notNull(),
    result_key: text().notNull(),
    state: text().$type<typeof IMTaskAuthoritySchema.RequestState.Type>().notNull(),
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

export const IMTaskGrantTable = sqliteTable(
  "im_task_grant",
  {
    grant_id: text().primaryKey(),
    request_id: text().notNull(),
    ordinal: integer().notNull(),
    instance_id: text().notNull(),
    actor_id: text().notNull(),
    principal: text({ mode: "json" }).$type<IMTaskAuthoritySchema.Principal>().notNull(),
    target_proof: text({ mode: "json" }).$type<IMTaskAuthoritySchema.TargetProof>().notNull(),
    source_proof_hash: text().notNull(),
    source_snapshot_hash: text().notNull(),
    request_hash: text().notNull(),
    binding: text({ mode: "json" }).$type<WorkAuthoritySchema.Binding>().notNull(),
    record_hash: text().notNull(),
    work_id: text().notNull(),
    session_id: text().notNull(),
    input_id: text().notNull(),
    result_key: text().notNull(),
    state: text().$type<typeof IMTaskAuthoritySchema.GrantState.Type>().notNull(),
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
