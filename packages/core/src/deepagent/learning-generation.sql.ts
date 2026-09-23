import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"
import { ProjectTable } from "../project/sql"

// One settled activity is one potential learning source. The first eligible lifecycle boundary
// claims it; all later boundary signals for the same activity observe the same durable choice.
export const LearningGenerationTable = sqliteTable(
  "learning_generation",
  {
    generation_id: text().primaryKey(),
    session_id: text().notNull().references(() => SessionTable.id),
    project_id: text().notNull().references(() => ProjectTable.id),
    activity_id: text().notNull(),
    workspace_path: text().notNull(),
    admission_json: text().notNull(),
    admission_hash: text().notNull(),
    settled_at: integer().notNull(),
    trigger: text().$type<"idle" | "pause" | "project_switch">(),
    claimed_at: integer(),
    admitted_at: integer(),
  },
  (table) => [
    uniqueIndex("learning_generation_activity_idx").on(table.session_id, table.activity_id),
    index("learning_generation_pending_idx").on(table.trigger, table.settled_at),
    check("learning_generation_payload_json_check", sql`json_valid(${table.admission_json}) AND json_type(${table.admission_json}) = 'object'`),
    check("learning_generation_payload_hash_check", sql`length(${table.admission_hash}) = 64 AND ${table.admission_hash} NOT GLOB '*[^0-9a-f]*'`),
    check("learning_generation_trigger_check", sql`${table.trigger} IS NULL OR ${table.trigger} IN ('idle', 'pause', 'project_switch')`),
    check("learning_generation_claim_check", sql`(${table.trigger} IS NULL AND ${table.claimed_at} IS NULL AND ${table.admitted_at} IS NULL) OR (${table.trigger} IS NOT NULL AND ${table.claimed_at} IS NOT NULL)`),
  ],
)
