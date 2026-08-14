import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { LearningJobTable } from "./learning-job.sql"

export const LearningGovernancePlanTable = sqliteTable(
  "learning_governance_plan",
  {
    plan_id: text().primaryKey(),
    job_id: text()
      .notNull()
      .references(() => LearningJobTable.job_id),
    policy: text().$type<"manual_review">().notNull(),
    payload_json: text().notNull(),
    payload_fingerprint: text().notNull(),
    action_count: integer().notNull(),
    job_owner: text().notNull(),
    source_job_version: integer().notNull(),
    job_started_version: integer().notNull(),
    state: text().$type<"prepared" | "settled" | "recovery_required">().notNull(),
    version: integer().notNull(),
    result_ref: text(),
    result_hash: text(),
    result_fingerprint: text(),
    error_code: text(),
    error_detail: text(),
    created_at: integer().notNull(),
    settled_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("learning_governance_plan_job_idx").on(table.job_id),
    index("learning_governance_plan_state_idx").on(table.state, table.created_at),
    check("learning_governance_plan_policy_check", sql`${table.policy} = 'manual_review'`),
    check("learning_governance_plan_action_count_check", sql`${table.action_count} >= 0`),
    check("learning_governance_plan_version_check", sql`${table.version} >= 0`),
    check("learning_governance_plan_payload_json_check", sql`json_valid(${table.payload_json})`),
    check(
      "learning_governance_plan_payload_fingerprint_check",
      sql`length(${table.payload_fingerprint}) = 64 AND ${table.payload_fingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "learning_governance_plan_result_hash_check",
      sql`${table.result_hash} IS NULL OR (length(${table.result_hash}) = 64 AND ${table.result_hash} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      "learning_governance_plan_result_fingerprint_check",
      sql`${table.result_fingerprint} IS NULL OR (length(${table.result_fingerprint}) = 64 AND ${table.result_fingerprint} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check("learning_governance_plan_state_check", sql`${table.state} IN ('prepared', 'settled', 'recovery_required')`),
    check(
      "learning_governance_plan_settlement_check",
      sql`(${table.state} = 'prepared' AND ${table.result_ref} IS NULL AND ${table.result_hash} IS NULL AND ${table.result_fingerprint} IS NULL AND ${table.error_code} IS NULL AND ${table.settled_at} IS NULL) OR (${table.state} = 'settled' AND length(trim(${table.result_ref})) > 0 AND ${table.result_hash} IS NOT NULL AND ${table.result_fingerprint} IS NOT NULL AND ${table.error_code} IS NULL AND ${table.settled_at} IS NOT NULL) OR (${table.state} = 'recovery_required' AND length(trim(${table.error_code})) > 0 AND ${table.settled_at} IS NOT NULL)`,
    ),
  ],
)

export const LearningGovernanceActionTable = sqliteTable(
  "learning_governance_action",
  {
    action_id: text().primaryKey(),
    plan_id: text()
      .notNull()
      .references(() => LearningGovernancePlanTable.plan_id),
    candidate_id: text().notNull(),
    sequence: integer().notNull(),
    kind: text().$type<"document_stage" | "memory_inbox">().notNull(),
    predecessor_action_id: text(),
    payload_json: text().notNull(),
    payload_fingerprint: text().notNull(),
    state: text().$type<"prepared" | "running" | "settled" | "recovery_required">().notNull(),
    owner: text(),
    lease_expires_at: integer(),
    version: integer().notNull(),
    result_ref: text(),
    result_hash: text(),
    result_fingerprint: text(),
    error_code: text(),
    error_detail: text(),
    created_at: integer().notNull(),
    settled_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("learning_governance_action_plan_sequence_idx").on(table.plan_id, table.sequence),
    uniqueIndex("learning_governance_action_plan_candidate_kind_idx").on(table.plan_id, table.candidate_id, table.kind),
    index("learning_governance_action_claim_idx").on(table.plan_id, table.state, table.sequence),
    check("learning_governance_action_sequence_check", sql`${table.sequence} >= 0`),
    check("learning_governance_action_version_check", sql`${table.version} >= 0`),
    check("learning_governance_action_candidate_check", sql`length(trim(${table.candidate_id})) > 0`),
    check("learning_governance_action_payload_json_check", sql`json_valid(${table.payload_json})`),
    check("learning_governance_action_kind_check", sql`${table.kind} IN ('document_stage', 'memory_inbox')`),
    check(
      "learning_governance_action_payload_fingerprint_check",
      sql`length(${table.payload_fingerprint}) = 64 AND ${table.payload_fingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "learning_governance_action_result_hash_check",
      sql`${table.result_hash} IS NULL OR (length(${table.result_hash}) = 64 AND ${table.result_hash} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      "learning_governance_action_result_fingerprint_check",
      sql`${table.result_fingerprint} IS NULL OR (length(${table.result_fingerprint}) = 64 AND ${table.result_fingerprint} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      "learning_governance_action_state_check",
      sql`${table.state} IN ('prepared', 'running', 'settled', 'recovery_required')`,
    ),
    check(
      "learning_governance_action_lifecycle_check",
      sql`(${table.state} = 'prepared' AND ${table.owner} IS NULL AND ${table.lease_expires_at} IS NULL AND ${table.result_ref} IS NULL AND ${table.result_hash} IS NULL AND ${table.result_fingerprint} IS NULL AND ${table.error_code} IS NULL AND ${table.settled_at} IS NULL) OR (${table.state} = 'running' AND length(trim(${table.owner})) > 0 AND ${table.lease_expires_at} IS NOT NULL AND ${table.result_ref} IS NULL AND ${table.result_hash} IS NULL AND ${table.result_fingerprint} IS NULL AND ${table.error_code} IS NULL AND ${table.settled_at} IS NULL) OR (${table.state} = 'settled' AND ${table.owner} IS NULL AND ${table.lease_expires_at} IS NULL AND length(trim(${table.result_ref})) > 0 AND ${table.result_hash} IS NOT NULL AND ${table.result_fingerprint} IS NOT NULL AND ${table.error_code} IS NULL AND ${table.settled_at} IS NOT NULL) OR (${table.state} = 'recovery_required' AND ${table.owner} IS NULL AND ${table.lease_expires_at} IS NULL AND length(trim(${table.error_code})) > 0 AND ${table.settled_at} IS NOT NULL)`,
    ),
  ],
)

export const LearningGovernanceCompensationTable = sqliteTable(
  "learning_governance_compensation",
  {
    compensation_id: text().primaryKey(),
    plan_id: text()
      .notNull()
      .references(() => LearningGovernancePlanTable.plan_id),
    action_id: text()
      .notNull()
      .references(() => LearningGovernanceActionTable.action_id),
    sequence: integer().notNull(),
    kind: text().$type<"document_quarantine" | "memory_inbox_revoke">().notNull(),
    source_payload_fingerprint: text().notNull(),
    state: text().$type<"prepared" | "running" | "settled" | "recovery_required">().notNull(),
    owner: text(),
    lease_expires_at: integer(),
    version: integer().notNull(),
    result_ref: text(),
    result_hash: text(),
    result_fingerprint: text(),
    error_code: text(),
    error_detail: text(),
    created_at: integer().notNull(),
    settled_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("learning_governance_compensation_action_idx").on(table.action_id),
    uniqueIndex("learning_governance_compensation_plan_sequence_idx").on(table.plan_id, table.sequence),
    index("learning_governance_compensation_claim_idx").on(table.state, table.created_at),
    check("learning_governance_compensation_sequence_check", sql`${table.sequence} >= 0`),
    check("learning_governance_compensation_version_check", sql`${table.version} >= 0`),
    check(
      "learning_governance_compensation_kind_check",
      sql`${table.kind} IN ('document_quarantine', 'memory_inbox_revoke')`,
    ),
    check(
      "learning_governance_compensation_source_fingerprint_check",
      sql`length(${table.source_payload_fingerprint}) = 64 AND ${table.source_payload_fingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "learning_governance_compensation_result_hash_check",
      sql`${table.result_hash} IS NULL OR (length(${table.result_hash}) = 64 AND ${table.result_hash} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      "learning_governance_compensation_result_fingerprint_check",
      sql`${table.result_fingerprint} IS NULL OR (length(${table.result_fingerprint}) = 64 AND ${table.result_fingerprint} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      "learning_governance_compensation_state_check",
      sql`${table.state} IN ('prepared', 'running', 'settled', 'recovery_required')`,
    ),
    check(
      "learning_governance_compensation_lifecycle_check",
      sql`(${table.state} = 'prepared' AND ${table.owner} IS NULL AND ${table.lease_expires_at} IS NULL AND ${table.result_ref} IS NULL AND ${table.result_hash} IS NULL AND ${table.result_fingerprint} IS NULL AND ${table.error_code} IS NULL AND ${table.settled_at} IS NULL) OR (${table.state} = 'running' AND length(trim(${table.owner})) > 0 AND ${table.lease_expires_at} IS NOT NULL AND ${table.result_ref} IS NULL AND ${table.result_hash} IS NULL AND ${table.result_fingerprint} IS NULL AND ${table.error_code} IS NULL AND ${table.settled_at} IS NULL) OR (${table.state} = 'settled' AND ${table.owner} IS NULL AND ${table.lease_expires_at} IS NULL AND length(trim(${table.result_ref})) > 0 AND ${table.result_hash} IS NOT NULL AND ${table.result_fingerprint} IS NOT NULL AND ${table.error_code} IS NULL AND ${table.settled_at} IS NOT NULL) OR (${table.state} = 'recovery_required' AND ${table.owner} IS NULL AND ${table.lease_expires_at} IS NULL AND length(trim(${table.error_code})) > 0 AND ${table.settled_at} IS NOT NULL)`,
    ),
  ],
)
