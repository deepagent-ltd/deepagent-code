import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { GoalControlTable } from "./goal-control.sql"
import type { GoalPlanRebaseSchema } from "./goal-plan-rebase.schema"

// A bounded plan-edit business journal. It grants no execution ownership.
export const GoalPlanRebaseTable = sqliteTable(
  "goal_plan_rebase",
  {
    edit_id: text().notNull().primaryKey(),
    goal_id: text().notNull().references(() => GoalControlTable.goal_id),
    session_id: text().notNull(),
    version: integer().notNull(),
    revision: integer().notNull(),
    state: text().$type<GoalPlanRebaseSchema.State>().notNull(),
    source_plan_revision: integer().notNull(),
    target_plan_revision: integer().notNull(),
    source_control_revision: integer().notNull(),
    expected_control_revision: integer().notNull(),
    source_receipt_hash: text(),
    journal: text({ mode: "json" }).$type<GoalPlanRebaseSchema.Journal>().notNull(),
    journal_hash: text().notNull(),
    logical_bytes: integer().notNull(),
    reserved_bytes: integer().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("goal_plan_rebase_active_idx").on(table.goal_id).where(sql`${table.state} NOT IN ('committed','cancelled','superseded')`),
    // Cancelled requests do not consume a structural revision. Only committed lineage owns it.
    uniqueIndex("goal_plan_rebase_target_idx").on(table.goal_id, table.target_plan_revision).where(sql`${table.state} = 'committed'`),
    index("goal_plan_rebase_session_idx").on(table.session_id, table.created_at),
    check("goal_plan_rebase_identity_check", sql`${table.edit_id} IS NOT NULL AND typeof(${table.edit_id})='text' AND length(CAST(${table.edit_id} AS BLOB)) BETWEEN 1 AND 128 AND ${table.edit_id} NOT GLOB '*[^A-Za-z0-9_.:~-]*' AND typeof(${table.goal_id})='text' AND length(CAST(${table.goal_id} AS BLOB)) BETWEEN 1 AND 512 AND typeof(${table.session_id})='text' AND length(CAST(${table.session_id} AS BLOB)) BETWEEN 1 AND 512`),
    check("goal_plan_rebase_version_check", sql`typeof(${table.version})='integer' AND ${table.version}=1 AND typeof(${table.revision})='integer' AND ${table.revision} BETWEEN 0 AND 9007199254740991`),
    check("goal_plan_rebase_cursor_check", sql`typeof(${table.source_plan_revision})='integer' AND ${table.source_plan_revision} BETWEEN 0 AND 9007199254740990 AND typeof(${table.target_plan_revision})='integer' AND ${table.target_plan_revision}=${table.source_plan_revision}+1 AND typeof(${table.source_control_revision})='integer' AND ${table.source_control_revision} BETWEEN 0 AND 9007199254740991 AND typeof(${table.expected_control_revision})='integer' AND ${table.expected_control_revision} BETWEEN ${table.source_control_revision} AND 9007199254740991`),
    check("goal_plan_rebase_state_check", sql`${table.state} IN ('waiting_boundary','ready','prepared','mirror_pending','committed','cancelled','superseded','recovery_required')`),
    check("goal_plan_rebase_hash_check", sql`typeof(${table.journal_hash})='text' AND length(CAST(${table.journal_hash} AS BLOB))=64 AND ${table.journal_hash} NOT GLOB '*[^0-9a-f]*' AND (${table.source_receipt_hash} IS NULL OR (typeof(${table.source_receipt_hash})='text' AND length(CAST(${table.source_receipt_hash} AS BLOB))=64 AND ${table.source_receipt_hash} NOT GLOB '*[^0-9a-f]*'))`),
    check("goal_plan_rebase_json_check", sql`CASE WHEN typeof(${table.journal})='text' AND length(CAST(${table.journal} AS BLOB)) BETWEEN 1 AND 1048576 AND json_valid(${table.journal}) THEN coalesce(json_type(${table.journal})='object' AND json_type(${table.journal},'$.version')='integer' AND json_extract(${table.journal},'$.version')=1 AND json_type(${table.journal},'$.documents')='array' AND json_array_length(${table.journal},'$.documents')<=8 AND json_type(${table.journal},'$.commands')='array' AND json_array_length(${table.journal},'$.commands') BETWEEN 1 AND 32,0) ELSE 0 END`),
    check("goal_plan_rebase_time_check", sql`typeof(${table.created_at})='integer' AND ${table.created_at} BETWEEN 0 AND 9007199254740991 AND typeof(${table.updated_at})='integer' AND ${table.updated_at} BETWEEN ${table.created_at} AND 9007199254740991`),
    check("goal_plan_rebase_capacity_check", sql`typeof(${table.logical_bytes})='integer' AND ${table.logical_bytes}=length(CAST(${table.journal} AS BLOB)) AND ${table.logical_bytes} BETWEEN 1 AND 1048576 AND typeof(${table.reserved_bytes})='integer' AND ${table.reserved_bytes} BETWEEN ${table.logical_bytes} AND 1048576`),
  ],
)

// Root-owned goal-control.sql.ts delta:
// goal_control: plan_revision integer NOT NULL DEFAULT 0 CHECK safe nonnegative integer;
// plan_rebase_id text nullable; pending_rebase_id text nullable. Both bounded ASCII edit IDs.
// goal_control_command.action: add 'rebase_begin','rebase_apply','rebase_cancel','rebase_reconcile'.
// Receipt stays GoalControlSchema.Snapshot: the rebase journal owns the full typed edit receipt.
// Root-owned goal-tick-checkpoint.sql.ts delta:
// physical version 1|2|3; journal.version=version, program.version=version (2|3).
// v3 additionally requires program.planLineage object with version=1 and the strict fields
// planRevision,rebaseID,sourceReceiptHash,planDocID,planDocVersion,planDocHash,baselineDocsHash.
// v1/v2 existing journal/IDs/hash bytes are never updated by this migration.
