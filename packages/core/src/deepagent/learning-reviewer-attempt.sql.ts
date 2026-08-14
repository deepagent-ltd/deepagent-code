import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { LearningJobTable } from "./learning-job.sql"

export const LearningReviewerAttemptTable = sqliteTable(
  "learning_reviewer_attempt",
  {
    attempt_id: text().primaryKey(),
    job_id: text()
      .notNull()
      .references(() => LearningJobTable.job_id),
    state: text().$type<"prepared" | "dispatching" | "settled" | "failed" | "recovery_required">().notNull(),
    version: integer().notNull(),
    owner: text(),
    review_session_id: text().notNull(),
    request_ref: text().notNull(),
    request_hash: text().notNull(),
    source_candidate_ids_json: text().notNull(),
    source_candidate_set_hash: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    policy_hash: text().notNull(),
    response_ref: text(),
    response_hash: text(),
    verdict: text().$type<"approve" | "reject" | "manual_review">(),
    selected_candidate_ids_json: text(),
    selected_subset_hash: text(),
    error_code: text(),
    error_detail: text(),
    created_at: integer().notNull(),
    dispatched_at: integer(),
    settled_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("learning_reviewer_attempt_job_idx").on(table.job_id),
    uniqueIndex("learning_reviewer_attempt_session_idx").on(table.review_session_id),
    index("learning_reviewer_attempt_state_idx").on(table.state, table.updated_at),
    check(
      "learning_reviewer_attempt_state_check",
      sql`${table.state} IN ('prepared', 'dispatching', 'settled', 'failed', 'recovery_required')`,
    ),
    check("learning_reviewer_attempt_version_check", sql`${table.version} >= 0`),
    check(
      "learning_reviewer_attempt_hash_check",
      sql`length(${table.request_hash}) = 64 AND ${table.request_hash} NOT GLOB '*[^0-9a-f]*' AND length(${table.source_candidate_set_hash}) = 64 AND ${table.source_candidate_set_hash} NOT GLOB '*[^0-9a-f]*' AND length(${table.policy_hash}) = 64 AND ${table.policy_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "learning_reviewer_attempt_terminal_check",
      sql`(${table.state} IN ('prepared', 'dispatching') AND ${table.settled_at} IS NULL) OR (${table.state} IN ('settled', 'failed', 'recovery_required') AND ${table.settled_at} IS NOT NULL)`,
    ),
    check(
      "learning_reviewer_attempt_response_check",
      sql`(${table.state} <> 'settled' AND ${table.response_ref} IS NULL AND ${table.response_hash} IS NULL AND ${table.verdict} IS NULL AND ${table.selected_candidate_ids_json} IS NULL AND ${table.selected_subset_hash} IS NULL) OR (${table.state} = 'settled' AND length(trim(${table.response_ref})) > 0 AND length(${table.response_hash}) = 64 AND ${table.response_hash} NOT GLOB '*[^0-9a-f]*' AND ${table.verdict} IN ('approve', 'reject', 'manual_review') AND length(trim(${table.selected_candidate_ids_json})) > 0 AND length(${table.selected_subset_hash}) = 64 AND ${table.selected_subset_hash} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      "learning_reviewer_attempt_error_check",
      sql`${table.state} NOT IN ('failed', 'recovery_required') OR length(trim(${table.error_code})) > 0`,
    ),
  ],
)
