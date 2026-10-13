import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { GoalControlSchema } from "./goal-control.schema"

export const GoalControlTable = sqliteTable(
  "goal_control",
  {
    goal_id: text().primaryKey(),
    session_id: text().notNull(),
    is_current: integer({ mode: "boolean" }).notNull(),
    plan_doc_id: text().notNull(),
    project_id: text().notNull(),
    directory: text().notNull(),
    workspace_id: text(),
    driver_mode: text().$type<GoalControlSchema.Mode>().notNull(),
    initialization: text({ mode: "json" }).$type<GoalControlSchema.Initialization>().notNull(),
    initialization_hash: text().notNull(),
    preparation: text().$type<"preparing" | "ready" | "recovery_required">().notNull(),
    revision: integer().notNull(),
    requested_phase: text().$type<GoalControlSchema.Phase>().notNull(),
    observed_phase: text(),
    next_seq: integer().notNull(),
    plan_version: integer().notNull(),
    plan_revision: integer().notNull().default(0),
    plan_rebase_id: text(),
    pending_rebase_id: text(),
    recovery_reason: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("goal_control_current_idx")
      .on(table.session_id)
      .where(sql`${table.is_current} = 1`),
    check(
      "goal_control_phase_check",
      sql`${table.requested_phase} IN ('running','paused','stopped','done','needs_human','rolled_back')`,
    ),
    check("goal_control_preparation_check", sql`${table.preparation} IN ('preparing','ready','recovery_required')`),
    check("goal_control_mode_check", sql`${table.driver_mode} IN ('event','resident')`),
    check(
      "goal_control_counts_check",
      sql`${table.revision} >= 0 AND ${table.next_seq} >= 0 AND ${table.plan_version} >= 0`,
    ),
    check("goal_control_current_check", sql`${table.is_current} IN (0,1)`),
    check("goal_control_plan_revision_check", sql`typeof(${table.plan_revision})='integer' AND ${table.plan_revision} BETWEEN 0 AND 9007199254740991`),
    ...[table.plan_rebase_id, table.pending_rebase_id].map((column) =>
      check(`goal_control_${column.name}_check`, sql`${column} IS NULL OR (typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 128 AND ${column} NOT GLOB '*[^A-Za-z0-9_.:~-]*')`)),
    check(
      "goal_control_initialization_check",
      sql`json_valid(${table.initialization}) AND json_type(${table.initialization}) = 'object'`,
    ),
    check(
      "goal_control_hash_check",
      sql`length(${table.initialization_hash}) = 64 AND ${table.initialization_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
)

export const GoalControlCommandTable = sqliteTable(
  "goal_control_command",
  {
    command_id: text().primaryKey(),
    session_id: text().notNull(),
    goal_id: text()
      .notNull()
      .references(() => GoalControlTable.goal_id),
    request_id: text().notNull(),
    request_hash: text().notNull(),
    action: text().$type<"start" | GoalControlSchema.Action | "rebase_begin" | "rebase_apply" | "rebase_cancel" | "rebase_reconcile">().notNull(),
    revision: integer().notNull(),
    receipt: text({ mode: "json" }).$type<GoalControlSchema.Snapshot>(),
    wake_state: text().$type<GoalControlSchema.WakeState>().notNull(),
    wake_key: text().notNull(),
    tick_seq: integer().notNull(),
    plan_version: integer().notNull(),
    publish_attempts: integer().notNull(),
    last_error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("goal_control_command_request_idx").on(table.session_id, table.request_id),
    index("goal_control_command_wake_idx").on(table.wake_state, table.created_at),
    check("goal_control_command_action_check", sql`${table.action} IN ('start','pause','resume','stop','rebase_begin','rebase_apply','rebase_cancel','rebase_reconcile')`),
    check("goal_control_command_wake_check", sql`${table.wake_state} IN ('none','pending','published','superseded')`),
    check(
      "goal_control_command_receipt_check",
      sql`${table.receipt} IS NULL OR (json_valid(${table.receipt}) AND json_type(${table.receipt}) = 'object')`,
    ),
  ],
)

export const GoalTickPermitTable = sqliteTable(
  "goal_tick_permit",
  {
    permit_id: text().primaryKey(),
    goal_id: text()
      .notNull()
      .references(() => GoalControlTable.goal_id),
    tick_seq: integer().notNull(),
    control_revision: integer().notNull(),
    plan_version: integer().notNull(),
    owner_id: text().notNull(),
    token: text().notNull(),
    state: text().$type<"issued" | "settled" | "unknown">().notNull(),
    next_seq: integer(),
    next_plan_version: integer(),
    outcome: text(),
    child_sessions: text({ mode: "json" }).$type<string[]>().notNull(),
    interrupt_state: text().$type<"none" | "requested" | "unconfirmed">().notNull(),
    created_at: integer().notNull(),
    settled_at: integer(),
  },
  (table) => [
    uniqueIndex("goal_tick_permit_cursor_idx").on(table.goal_id, table.tick_seq),
    index("goal_tick_permit_active_idx").on(table.goal_id, table.state),
    check("goal_tick_permit_state_check", sql`${table.state} IN ('issued','settled','unknown')`),
    check("goal_tick_permit_interrupt_check", sql`${table.interrupt_state} IN ('none','requested','unconfirmed')`),
    check(
      "goal_tick_permit_children_check",
      sql`json_valid(${table.child_sessions}) AND json_type(${table.child_sessions}) = 'array'`,
    ),
    check(
      "goal_tick_permit_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('running','paused','stopped','done','needs_human','rolled_back')`,
    ),
  ],
)
