import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/sql"
import { SessionTable } from "../session/sql"

export const LearningJobTable = sqliteTable(
  "learning_job",
  {
    job_id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id),
    session_id: text().references(() => SessionTable.id),
    run_id: text(),
    trigger: text().$type<"idle" | "pause" | "project_switch" | "session_finalization">().notNull(),
    dedupe_key: text().notNull(),
    candidate_input_ref: text().notNull(),
    policy: text().$type<"auto_merge_safe_project" | "manual_review">().notNull(),
    max_attempts: integer().notNull(),
    admission_fingerprint: text().notNull(),
    state: text()
      .$type<
        "queued" | "running" | "reviewing" | "governance" | "completed" | "failed" | "cancelled" | "recovery_required"
      >()
      .notNull(),
    attempts: integer().notNull(),
    owner: text(),
    lease_expires_at: integer(),
    version: integer().notNull(),
    side_effect_state: text().$type<"not_started" | "started" | "settled" | "unknown">().notNull(),
    side_effect_kind: text().$type<"extraction" | "reviewer" | "governance">(),
    expected_result_ref: text(),
    review_job_id: text(),
    result_ref: text(),
    error_code: text(),
    error_detail: text(),
    settlement_fingerprint: text(),
    next_attempt_at: integer().notNull(),
    created_at: integer().notNull(),
    started_at: integer(),
    settled_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("learning_job_dedupe_idx").on(table.dedupe_key),
    index("learning_job_due_idx").on(table.state, table.next_attempt_at, table.created_at),
    index("learning_job_project_created_idx").on(table.project_id, table.created_at),
    index("learning_job_owner_lease_idx")
      .on(table.owner, table.lease_expires_at)
      .where(sql`${table.owner} IS NOT NULL`),
    check(
      "learning_job_trigger_check",
      sql`${table.trigger} IN ('idle', 'pause', 'project_switch', 'session_finalization')`,
    ),
    check("learning_job_policy_check", sql`${table.policy} IN ('auto_merge_safe_project', 'manual_review')`),
    check(
      "learning_job_state_check",
      sql`${table.state} IN ('queued', 'running', 'reviewing', 'governance', 'completed', 'failed', 'cancelled', 'recovery_required')`,
    ),
    check("learning_job_attempts_check", sql`${table.attempts} >= 0`),
    check("learning_job_max_attempts_check", sql`${table.max_attempts} > 0`),
    check("learning_job_version_check", sql`${table.version} >= 0`),
    check(
      "learning_job_admission_fingerprint_check",
      sql`length(${table.admission_fingerprint}) = 64 AND ${table.admission_fingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "learning_job_side_effect_check",
      sql`(${table.side_effect_state} = 'not_started' AND ${table.side_effect_kind} IS NULL) OR (${table.side_effect_state} IN ('started', 'settled', 'unknown') AND ${table.side_effect_kind} IS NOT NULL)`,
    ),
    check(
      "learning_job_expected_result_check",
      sql`(${table.side_effect_state} = 'not_started' AND ${table.expected_result_ref} IS NULL) OR (${table.side_effect_kind} IN ('extraction', 'reviewer') AND ${table.side_effect_state} IN ('started', 'settled') AND length(trim(${table.expected_result_ref})) > 0) OR (${table.side_effect_kind} = 'governance' AND ${table.expected_result_ref} IS NULL) OR (${table.side_effect_state} = 'unknown' AND ${table.expected_result_ref} IS NULL)`,
    ),
    check(
      "learning_job_settled_result_check",
      sql`${table.side_effect_state} <> 'settled' OR (length(trim(${table.result_ref})) > 0 AND (${table.expected_result_ref} IS NULL OR ${table.side_effect_kind} = 'reviewer' OR ${table.result_ref} = ${table.expected_result_ref}))`,
    ),
    check(
      "learning_job_active_phase_kind_check",
      sql`${table.state} NOT IN ('running', 'reviewing', 'governance') OR ${table.side_effect_state} = 'not_started' OR (${table.state} = 'running' AND ${table.side_effect_kind} = 'extraction') OR (${table.state} = 'reviewing' AND ${table.side_effect_kind} = 'reviewer') OR (${table.state} = 'governance' AND ${table.side_effect_kind} = 'governance')`,
    ),
    check(
      "learning_job_ownership_check",
      sql`(${table.state} = 'queued' AND ${table.owner} IS NULL AND ${table.lease_expires_at} IS NULL AND ${table.side_effect_state} = 'not_started') OR (${table.state} IN ('running', 'reviewing', 'governance') AND ${table.started_at} IS NOT NULL AND ${table.settled_at} IS NULL AND ((length(trim(${table.owner})) > 0 AND ${table.lease_expires_at} IS NOT NULL) OR (${table.state} IN ('reviewing', 'governance') AND ${table.owner} IS NULL AND ${table.lease_expires_at} IS NULL AND ${table.side_effect_state} = 'not_started'))) OR (${table.state} IN ('completed', 'failed', 'cancelled', 'recovery_required') AND ${table.owner} IS NULL AND ${table.lease_expires_at} IS NULL AND ${table.settled_at} IS NOT NULL)`,
    ),
    check(
      "learning_job_recovery_check",
      sql`${table.state} <> 'recovery_required' OR (${table.side_effect_state} <> 'not_started' AND ${table.error_code} IS NOT NULL)`,
    ),
    check(
      "learning_job_completed_check",
      sql`${table.state} <> 'completed' OR (${table.side_effect_state} = 'settled' AND length(trim(${table.result_ref})) > 0)`,
    ),
    check("learning_job_failed_check", sql`${table.state} <> 'failed' OR length(trim(${table.error_code})) > 0`),
    check(
      "learning_job_terminal_side_effect_check",
      sql`${table.state} NOT IN ('completed', 'failed', 'cancelled') OR ${table.side_effect_state} IN ('not_started', 'settled')`,
    ),
    check(
      "learning_job_settlement_fingerprint_check",
      sql`${table.settlement_fingerprint} IS NULL OR (length(${table.settlement_fingerprint}) = 64 AND ${table.settlement_fingerprint} NOT GLOB '*[^0-9a-f]*')`,
    ),
  ],
)
