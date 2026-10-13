import { sql } from "drizzle-orm"
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { LocalOperatorSchema } from "./local-operator.schema"

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
