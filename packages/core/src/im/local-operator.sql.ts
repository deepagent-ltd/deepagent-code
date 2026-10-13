import { sql } from "drizzle-orm"
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { LocalOperatorSchema } from "./local-operator.schema"
import type { IMTaskAuthoritySchema } from "./task-authority.schema"

// Identity and business policy only. WorkAuthority owns all execution state and token escrow.
export const LocalOperatorAuthorityTable = sqliteTable(
  "local_operator_authority",
  {
    instance_id: text().primaryKey(),
    operator_id: text().notNull(),
    username: text().notNull(),
    credential_verifier: text().notNull(),
    credential_binding: text().notNull(),
    installation_key_hash: text().notNull(),
    state: text().$type<"active" | "revoked">().notNull(),
    revision: integer().notNull(),
    credential_generation: integer().notNull(),
    policy_revision: integer().notNull(),
    policy: text({ mode: "json" }).$type<LocalOperatorSchema.Policy>().notNull(),
    policy_hash: text().notNull(),
    identity_hash: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("local_operator_identity_idx").on(table.operator_id),
    check(
      "local_operator_hash_check",
      sql`length(${table.credential_binding}) = 64 AND ${table.credential_binding} NOT GLOB '*[^0-9a-f]*' AND length(${table.installation_key_hash}) = 64 AND ${table.installation_key_hash} NOT GLOB '*[^0-9a-f]*' AND length(${table.policy_hash}) = 64 AND ${table.policy_hash} NOT GLOB '*[^0-9a-f]*' AND length(${table.identity_hash}) = 64 AND ${table.identity_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("local_operator_verifier_check", sql`substr(${table.credential_verifier}, 1, 10) = '$argon2id$'`),
    check("local_operator_state_check", sql`${table.state} IN ('active','revoked')`),
    check(
      "local_operator_revision_check",
      sql`${table.revision} > 0 AND ${table.credential_generation} > 0 AND ${table.policy_revision} > 0`,
    ),
    check("local_operator_policy_check", sql`json_valid(${table.policy}) AND json_type(${table.policy}) = 'object'`),
  ],
)

export const LocalOperatorCommandTable = sqliteTable(
  "local_operator_command",
  {
    command_id: text().primaryKey(),
    instance_id: text().notNull(),
    operation_id: text().notNull(),
    action: text().$type<"enroll" | "rotate" | "revoke" | "enable_conversation">().notNull(),
    request_hash: text().notNull(),
    expected_revision: integer(),
    receipt: text({ mode: "json" })
      .$type<LocalOperatorSchema.CommandReceipt | { groupID: string; revision: number }>()
      .notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("local_operator_command_request_idx").on(table.instance_id, table.operation_id),
    check(
      "local_operator_command_identity_check",
      sql`length(${table.request_hash}) = 64 AND ${table.request_hash} NOT GLOB '*[^0-9a-f]*' AND (${table.expected_revision} IS NULL OR ${table.expected_revision} >= 0)`,
    ),
    check(
      "local_operator_command_action_check",
      sql`${table.action} IN ('enroll','rotate','revoke','enable_conversation')`,
    ),
    check(
      "local_operator_command_receipt_check",
      sql`json_valid(${table.receipt}) AND json_type(${table.receipt}) = 'object'`,
    ),
  ],
)

export const LocalTaskConversationTable = sqliteTable(
  "im_local_task_conversation",
  {
    group_id: text().primaryKey(),
    instance_id: text().notNull(),
    operator_id: text().notNull(),
    operator_revision: integer().notNull(),
    target_id: text().notNull(),
    revision: integer().notNull(),
    mode: text().$type<"explicit_task">().notNull(),
    target: text({ mode: "json" }).$type<IMTaskAuthoritySchema.Target>().notNull(),
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
export const LocalOriginReceiptTable = sqliteTable(
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
    proof: text({ mode: "json" }).$type<IMTaskAuthoritySchema.SourceProof>().notNull(),
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
