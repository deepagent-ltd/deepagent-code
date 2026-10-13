import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { GoalChildSchema } from "./goal-child.schema"
import { GoalControlTable, GoalTickPermitTable } from "./goal-control.sql"

// Business identity and admission receipts only. Session execution claims, provider attempts and
// tool-effect authority remain in their existing tables; this table has no execution lease.
export const GoalChildUnitTable = sqliteTable(
  "goal_child_unit",
  {
    unit_id: text().primaryKey(),
    goal_id: text()
      .notNull()
      .references(() => GoalControlTable.goal_id),
    permit_id: text()
      .notNull()
      .references(() => GoalTickPermitTable.permit_id),
    role_key: text().notNull(),
    parent_session_id: text().notNull(),
    child_session_id: text().notNull(),
    binding: text({ mode: "json" }).$type<GoalChildSchema.Binding>().notNull(),
    binding_hash: text().notNull(),
    state: text().$type<GoalChildSchema.State>().notNull(),
    creation_receipt: text({ mode: "json" }).$type<GoalChildSchema.CreationReceipt>(),
    inputs: text({ mode: "json" }).$type<GoalChildSchema.InputReceipt[]>().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("goal_child_unit_role_idx").on(table.permit_id, table.role_key),
    uniqueIndex("goal_child_unit_session_idx").on(table.child_session_id),
    index("goal_child_unit_goal_idx").on(table.goal_id),
    check(
      "goal_child_unit_state_check",
      sql`${table.state} IN ('reserved','admitted','result_recorded','cancelled_before_dispatch','recovery_required')`,
    ),
    check(
      "goal_child_unit_binding_check",
      sql`json_valid(${table.binding}) AND json_type(${table.binding}) = 'object'`,
    ),
    check(
      "goal_child_unit_binding_hash_check",
      sql`length(${table.binding_hash}) = 64 AND ${table.binding_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "goal_child_unit_inputs_check",
      sql`json_valid(${table.inputs}) AND json_type(${table.inputs}) = 'array' AND json_array_length(${table.inputs}) <= 3`,
    ),
    check(
      "goal_child_unit_creation_check",
      sql`${table.creation_receipt} IS NULL OR (json_valid(${table.creation_receipt}) AND json_type(${table.creation_receipt}) = 'object')`,
    ),
  ],
)
