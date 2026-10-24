import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { GoalPauseBoundary } from "./goal-pause-boundary"

// A reducing, bounded receipt. It is never a Session execution or provider replay authority.
export const GoalPauseBoundaryTable = sqliteTable(
  "goal_pause_boundary",
  {
    permit_id: text().primaryKey(),
    goal_id: text().notNull(),
    command_id: text().notNull(),
    state: text().$type<"prepared" | "committed">().notNull(),
    record: text({ mode: "json" }).$type<GoalPauseBoundary.Record>().notNull(),
    record_hash: text().notNull(),
    logical_bytes: integer().notNull(),
    reserved_bytes: integer().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("goal_pause_boundary_goal_idx").on(table.goal_id),
    check("goal_pause_boundary_state_check", sql`${table.state} IN ('prepared','committed')`),
    check(
      "goal_pause_boundary_record_check",
      sql`json_valid(${table.record}) AND json_type(${table.record})='object' AND length(CAST(${table.record} AS BLOB)) BETWEEN 2 AND 1048576`,
    ),
    check(
      "goal_pause_boundary_size_check",
      sql`${table.logical_bytes}=length(CAST(${table.record} AS BLOB)) AND ${table.reserved_bytes}=1048576`,
    ),
    check(
      "goal_pause_boundary_hash_check",
      sql`length(${table.record_hash})=64 AND ${table.record_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
)
