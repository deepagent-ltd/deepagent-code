import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Separate v2 tables: no rewriting or widening of the six existing v1 profiles.
export const BrowserSharedResourceTable = sqliteTable(
  "browser_shared_resource",
  {
    resource_id: text().primaryKey().notNull(),
    request_id: text().notNull(),
    request_digest: text().notNull(),
    principal: text().notNull(),
    session_id: text().notNull(),
    main_incarnation: text().notNull(),
    state: text().notNull(),
    revision: integer().notNull(),
    manual_epoch: integer().notNull(),
    barrier_order: integer().notNull(),
    core_cutoff: integer().notNull(),
    live_lease_id: text(),
    record: text().notNull(),
    record_hash: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [
    uniqueIndex("browser_shared_resource_request_idx").on(t.principal, t.session_id, t.request_id),
    index("browser_shared_resource_live_idx").on(t.main_incarnation, t.state),
    check(
      "browser_shared_resource_state_check",
      sql`${t.state} IN ('creating','agent_owned','takeover_pending','human_owned','acquire_pending','fenced_blocked','recovery_required','resource_lost','closing','closed')`,
    ),
    check(
      "browser_shared_resource_revision_check",
      sql`${t.revision}>0 AND ${t.manual_epoch}>=0 AND ${t.barrier_order}>=0 AND ${t.core_cutoff}>=-1`,
    ),
    check(
      "browser_shared_resource_record_check",
      sql`json_valid(${t.record}) AND length(CAST(${t.record} AS BLOB)) BETWEEN 1 AND 16384`,
    ),
  ],
)
export const BrowserSharedLeaseTable = sqliteTable(
  "browser_shared_lease",
  {
    lease_id: text().primaryKey().notNull(),
    resource_id: text().notNull(),
    request_id: text().notNull(),
    session_id: text().notNull(),
    main_incarnation: text().notNull(),
    sidecar_incarnation: text().notNull(),
    lease_epoch: integer().notNull(),
    manual_epoch: integer().notNull(),
    state: text().notNull(),
    origin_input_id: text(),
    record: text().notNull(),
    record_hash: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [
    uniqueIndex("browser_shared_lease_live_idx")
      .on(t.resource_id)
      .where(sql`${t.state} IN ('pending','active')`),
    uniqueIndex("browser_shared_lease_epoch_idx").on(t.resource_id, t.lease_epoch),
    uniqueIndex("browser_shared_lease_input_idx")
      .on(t.resource_id, t.origin_input_id)
      .where(sql`${t.origin_input_id} IS NOT NULL`),
    check("browser_shared_lease_state_check", sql`${t.state} IN ('pending','active','revoked','unknown')`),
    check(
      "browser_shared_lease_record_check",
      sql`json_valid(${t.record}) AND length(CAST(${t.record} AS BLOB)) BETWEEN 1 AND 16384`,
    ),
  ],
)
export const BrowserSharedRequestTable = sqliteTable(
  "browser_shared_request",
  {
    resource_id: text().notNull(),
    request_id: text().notNull(),
    kind: text().notNull(),
    request_digest: text().notNull(),
    manual_epoch: integer().notNull(),
    state: text().notNull(),
    lease_id: text(),
    record: text().notNull(),
    record_hash: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.resource_id, t.request_id] }),
    check("browser_shared_request_kind_check", sql`${t.kind} IN ('takeover','acquire','close')`),
    check("browser_shared_request_state_check", sql`${t.state} IN ('pending','completed','unknown')`),
    check(
      "browser_shared_request_record_check",
      sql`json_valid(${t.record}) AND length(CAST(${t.record} AS BLOB)) BETWEEN 1 AND 16384`,
    ),
  ],
)
export const SessionUserInputOriginTable = sqliteTable(
  "session_user_input_origin",
  {
    input_id: text().primaryKey().notNull(),
    session_id: text().notNull(),
    original_submission_id: text().notNull(),
    main_incarnation: text().notNull(),
    submission_order: integer().notNull(),
    admitted_seq: integer().notNull(),
    record: text().notNull(),
    record_hash: text().notNull(),
  },
  (t) => [
    uniqueIndex("session_user_input_origin_submission_idx").on(
      t.main_incarnation,
      t.session_id,
      t.original_submission_id,
    ),
    uniqueIndex("session_user_input_origin_order_idx").on(t.main_incarnation, t.submission_order),
    check("session_user_input_origin_seq_check", sql`${t.submission_order}>0 AND ${t.admitted_seq}>=0`),
    check(
      "session_user_input_origin_record_check",
      sql`json_valid(${t.record}) AND length(CAST(${t.record} AS BLOB)) BETWEEN 1 AND 4096`,
    ),
  ],
)
export const BrowserUserSelectionTable = sqliteTable(
  "browser_user_selection",
  {
    receipt_id: text().primaryKey().notNull(),
    selection_id: text().notNull(),
    session_id: text().notNull(),
    activity_id: text().notNull(),
    request_ordinal: integer().notNull(),
    projection_hash: text().notNull(),
    input_id: text(),
    origin_hash: text(),
    promoted_seq: integer(),
    created_at: integer().notNull(),
  },
  (t) => [
    index("browser_user_selection_activity_idx").on(t.session_id, t.activity_id, t.request_ordinal),
    check(
      "browser_user_selection_null_check",
      sql`(${t.input_id} IS NULL AND ${t.origin_hash} IS NULL AND ${t.promoted_seq} IS NULL) OR (${t.input_id} IS NOT NULL AND ${t.origin_hash} IS NOT NULL AND ${t.promoted_seq} IS NOT NULL)`,
    ),
  ],
)
export const BrowserSharedActionTable = sqliteTable(
  "browser_shared_action",
  {
    action_id: text().primaryKey().notNull(),
    admission_id: text().notNull(),
    resource_id: text().notNull(),
    lease_id: text().notNull(),
    outcome: text().notNull(),
    record: text().notNull(),
    record_hash: text().notNull(),
  },
  (t) => [
    uniqueIndex("browser_shared_action_admission_idx").on(t.admission_id),
    check("browser_shared_action_outcome_check", sql`${t.outcome} IN ('pending','completed','cancelled','unknown')`),
    check(
      "browser_shared_action_record_check",
      sql`json_valid(${t.record}) AND length(CAST(${t.record} AS BLOB)) BETWEEN 1 AND 131072`,
    ),
  ],
)
