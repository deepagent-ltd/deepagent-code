import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { GoalControlTable, GoalTickPermitTable } from "./goal-control.sql"
import type { GoalTickCheckpointSchema } from "./goal-tick-checkpoint.schema"
import type { GoalTickProgram } from "./goal-tick-program"

// One bounded business journal per accepted tick. No execution lease, queue or token budget.
export const GoalTickCheckpointTable = sqliteTable(
  "goal_tick_checkpoint",
  {
    permit_id: text()
      .notNull()
      .primaryKey()
      .references(() => GoalTickPermitTable.permit_id),
    goal_id: text()
      .notNull()
      .references(() => GoalControlTable.goal_id),
    tick_seq: integer().notNull(),
    version: integer().notNull(),
    revision: integer().notNull(),
    binding_hash: text().notNull(),
    role_manifest_hash: text().notNull(),
    parent_checked_through_seq: integer().notNull(),
    state: text().$type<GoalTickCheckpointSchema.State>().notNull(),
    journal: text({ mode: "json" }).$type<GoalTickCheckpointSchema.Journal | GoalTickProgram.Journal>().notNull(),
    journal_hash: text().notNull(),
    logical_bytes: integer().notNull(),
    reserved_bytes: integer().notNull(),
    error_code: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("goal_tick_checkpoint_goal_tick_idx").on(table.goal_id, table.tick_seq),
    index("goal_tick_checkpoint_state_idx").on(table.state),
    check(
      "goal_tick_checkpoint_identity_check",
      sql`${table.permit_id} IS NOT NULL AND typeof(${table.permit_id})='text' AND typeof(${table.goal_id})='text' AND length(${table.permit_id}) BETWEEN 1 AND 512 AND length(${table.goal_id}) BETWEEN 1 AND 512`,
    ),
    check(
      "goal_tick_checkpoint_version_check",
      sql`typeof(${table.version})='integer' AND ${table.version} IN (1,2,3) AND typeof(${table.revision})='integer' AND ${table.revision} BETWEEN 0 AND 9007199254740991 AND typeof(${table.tick_seq})='integer' AND ${table.tick_seq} BETWEEN 0 AND 9007199254740991 AND typeof(${table.parent_checked_through_seq})='integer' AND ${table.parent_checked_through_seq} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      "goal_tick_checkpoint_state_check",
      sql`${table.state} IN ('prepared','running','mirror_pending','committed','halted','recovery_required')`,
    ),
    check(
      "goal_tick_checkpoint_hash_check",
      sql`length(${table.binding_hash})=64 AND ${table.binding_hash} NOT GLOB '*[^0-9a-f]*' AND length(${table.role_manifest_hash})=64 AND ${table.role_manifest_hash} NOT GLOB '*[^0-9a-f]*' AND length(${table.journal_hash})=64 AND ${table.journal_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "goal_tick_checkpoint_json_check",
      sql`json_valid(${table.journal}) AND json_type(${table.journal})='object' AND length(CAST(${table.journal} AS BLOB))<=1048576`,
    ),
    check(
      "goal_tick_checkpoint_program_check",
      sql`${table.version}=1 OR coalesce(json_type(${table.journal},'$.version')='integer' AND json_extract(${table.journal},'$.version')=${table.version} AND json_type(${table.journal},'$.program')='object' AND json_type(${table.journal},'$.program.version')='integer' AND json_extract(${table.journal},'$.program.version')=${table.version} AND json_extract(${table.journal},'$.program.contract')='owned-goal-v2' AND json_type(${table.journal},'$.program.roles')='array' AND json_type(${table.journal},'$.program.documents')='array' AND json_type(${table.journal},'$.program.localEffectSlots')='integer' AND json_type(${table.journal},'$.program.nextStateBytes')='integer' AND json_type(${table.journal},'$.programHash')='text' AND json_type(${table.journal},'$.parent')='object' AND json_type(${table.journal},'$.cursor')='object' AND json_type(${table.journal},'$.activations')='array' AND json_type(${table.journal},'$.dispositions')='array' AND json_type(${table.journal},'$.results')='array' AND json_type(${table.journal},'$.localEffects')='array' AND json_type(${table.journal},'$.documents')='array' AND json_type(${table.journal},'$.nextState') IN ('text','null') AND json_type(${table.journal},'$.nextStateHash') IN ('text','null'),0)`,
    ),
    check(
      "goal_tick_checkpoint_plan_lineage_check",
      sql`${table.version}<>3 OR coalesce(json_type(${table.journal},'$.program.planLineage')='object' AND json_type(${table.journal},'$.program.planLineage.version')='integer' AND json_extract(${table.journal},'$.program.planLineage.version')=1 AND json_type(${table.journal},'$.program.planLineage.planRevision')='integer' AND json_extract(${table.journal},'$.program.planLineage.planRevision') BETWEEN 0 AND 9007199254740991 AND (json_type(${table.journal},'$.program.planLineage.rebaseID')='null' OR (json_type(${table.journal},'$.program.planLineage.rebaseID')='text' AND length(CAST(json_extract(${table.journal},'$.program.planLineage.rebaseID') AS BLOB)) BETWEEN 1 AND 128 AND json_extract(${table.journal},'$.program.planLineage.rebaseID') NOT GLOB '*[^A-Za-z0-9_.:~-]*')) AND json_type(${table.journal},'$.program.planLineage.planDocID')='text' AND length(CAST(json_extract(${table.journal},'$.program.planLineage.planDocID') AS BLOB)) BETWEEN 1 AND 128 AND json_type(${table.journal},'$.program.planLineage.planDocVersion')='integer' AND json_extract(${table.journal},'$.program.planLineage.planDocVersion') BETWEEN 1 AND 9007199254740991 AND ${sql.join(["sourceReceiptHash", "planDocHash", "baselineDocsHash"].map((field) => sql`json_type(${table.journal},${sql.raw(`'$.program.planLineage.${field}'`)})='text' AND length(CAST(json_extract(${table.journal},${sql.raw(`'$.program.planLineage.${field}'`)}) AS BLOB))=64 AND json_extract(${table.journal},${sql.raw(`'$.program.planLineage.${field}'`)}) NOT GLOB '*[^0-9a-f]*'`), sql` AND `)},0)`,
    ),
    check(
      "goal_tick_checkpoint_capacity_check",
      sql`typeof(${table.logical_bytes})='integer' AND typeof(${table.reserved_bytes})='integer' AND ${table.logical_bytes}=length(CAST(${table.journal} AS BLOB)) AND ${table.logical_bytes} BETWEEN 2 AND 1048576 AND ${table.reserved_bytes}>=${table.logical_bytes} AND ${table.reserved_bytes}<=1048576`,
    ),
    check("goal_tick_checkpoint_error_check", sql`${table.error_code} IS NULL OR length(${table.error_code})<=128`),
    check(
      "goal_tick_checkpoint_time_check",
      sql`typeof(${table.created_at})='integer' AND typeof(${table.updated_at})='integer' AND ${table.created_at} BETWEEN 0 AND 9007199254740991 AND ${table.updated_at} BETWEEN ${table.created_at} AND 9007199254740991`,
    ),
  ],
)
