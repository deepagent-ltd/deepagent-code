import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { BrowserFileSchema } from "./file-exchange.schema"
import { BrowserControlTable, BrowserActionTable } from "./browser.sql"

/** Admission meter, never a dispatch ledger. Tombstone count and metadata remain charged;
 * only native-confirmed removal may release the original body reservation. */
export const BrowserFileCapacityTable = sqliteTable("browser_file_capacity", {
  instance_id: text().primaryKey().notNull(),
  grant_count: integer().notNull(),
  artifact_count: integer().notNull(),
  reserved_bytes: integer().notNull(),
  metadata_bytes: integer().notNull(),
  revision: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  check("browser_file_capacity_instance_check", sql`typeof(${table.instance_id})='text' AND length(CAST(${table.instance_id} AS BLOB)) BETWEEN 1 AND 512 AND instr(${table.instance_id},char(0))=0`),
  ...[table.grant_count, table.artifact_count, table.reserved_bytes, table.metadata_bytes].map((column) =>
    check(`browser_file_capacity_${column.name}_integer_check`, sql`typeof(${column})='integer' AND ${column} BETWEEN 0 AND 9007199254740991`)),
  ...[table.revision, table.updated_at].map((column) =>
    check(`browser_file_capacity_${column.name}_integer_check`, sql`typeof(${column})='integer' AND ${column} BETWEEN 1 AND 9007199254740991`)),
  check("browser_file_capacity_bounds_check", sql`${table.artifact_count}<=100000 AND ${table.reserved_bytes}<=1073741824 AND ${table.metadata_bytes}<=33554432 AND ${table.reserved_bytes}>=${table.metadata_bytes}`),
])

export const BrowserFileGrantTable = sqliteTable("browser_file_grant", {
  grant_id: text().primaryKey().notNull(),
  instance_id: text().notNull(),
  control_id: text().notNull(),
  request_id: text().notNull(),
  command_hash: text().notNull(),
  scope_hash: text().notNull(),
  control_epoch: integer().notNull(),
  policy_revision: integer().notNull(),
  direction: text().$type<BrowserFileSchema.PreviewRequest["direction"]>().notNull(),
  expires_at: integer().notNull(),
  record: text().notNull(),
  record_hash: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  uniqueIndex("browser_file_grant_request_idx").on(table.control_id, table.request_id),
  index("browser_file_grant_control_idx").on(table.control_id, table.created_at, table.grant_id),
  foreignKey({ columns: [table.instance_id], foreignColumns: [BrowserFileCapacityTable.instance_id] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.control_id], foreignColumns: [BrowserControlTable.control_id] }).onDelete("restrict").onUpdate("restrict"),
  ...[table.grant_id, table.instance_id, table.control_id, table.request_id].map((column) =>
    check(`browser_file_grant_${column.name}_text_check`, sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`)),
  ...[table.command_hash, table.scope_hash, table.record_hash].map((column) =>
    check(`browser_file_grant_${column.name}_digest_check`, sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`)),
  ...[table.control_epoch, table.policy_revision, table.expires_at, table.created_at].map((column) =>
    check(`browser_file_grant_${column.name}_integer_check`, sql`typeof(${column})='integer' AND ${column} BETWEEN 1 AND 9007199254740991`)),
  check("browser_file_grant_direction_check", sql`${table.direction} IN ('upload','download')`),
  check("browser_file_grant_time_check", sql`${table.expires_at}>${table.created_at}`),
  check("browser_file_grant_record_check", sql`typeof(${table.record})='text' AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 8192 AND json_valid(${table.record}) AND json_type(${table.record}) IS 'object' AND json_type(${table.record},'$.version') IS 'integer' AND json_extract(${table.record},'$.version') IS 1`),
  ...([[table.grant_id, "grantID"], [table.instance_id, "instanceID"], [table.control_id, "controlID"],
    [table.command_hash, "commandHash"], [table.scope_hash, "scopeHash"]] as const).map(([column, field]) =>
    check(`browser_file_grant_${column.name}_mirror_check`, sql`json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'text' AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`)),
  ...([[table.control_epoch, "controlEpoch"], [table.policy_revision, "policyRevision"],
    [table.expires_at, "expiresAt"], [table.created_at, "createdAt"]] as const).map(([column, field]) =>
    check(`browser_file_grant_${column.name}_mirror_check`, sql`json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'integer' AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`)),
  check("browser_file_grant_request_mirror_check", sql`json_type(${table.record},'$.command.requestID') IS 'text' AND json_extract(${table.record},'$.command.requestID') IS ${table.request_id} AND json_type(${table.record},'$.preview.direction') IS 'text' AND json_extract(${table.record},'$.preview.direction') IS ${table.direction}`),
])

export const BrowserFileArtifactTable = sqliteTable("browser_file_artifact", {
  artifact_id: text().primaryKey().notNull(),
  instance_id: text().notNull(),
  grant_id: text().notNull(),
  grant_hash: text().notNull(),
  action_id: text().notNull(),
  control_id: text().notNull(),
  scope_hash: text().notNull(),
  ordinal: integer().notNull(),
  state: text().$type<BrowserFileSchema.Artifact["state"]>().notNull(),
  revision: integer().notNull(),
  reserved_bytes: integer().notNull(),
  record: text().notNull(),
  record_hash: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  released_at: integer(),
}, (table) => [
  uniqueIndex("browser_file_artifact_action_ordinal_idx").on(table.action_id, table.ordinal),
  uniqueIndex("browser_file_artifact_grant_idx").on(table.grant_id),
  index("browser_file_artifact_control_idx").on(table.control_id, table.created_at, table.artifact_id),
  index("browser_file_artifact_custody_idx").on(table.instance_id, table.released_at, table.artifact_id),
  foreignKey({ columns: [table.instance_id], foreignColumns: [BrowserFileCapacityTable.instance_id] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.grant_id], foreignColumns: [BrowserFileGrantTable.grant_id] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.action_id], foreignColumns: [BrowserActionTable.action_id] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.control_id], foreignColumns: [BrowserControlTable.control_id] }).onDelete("restrict").onUpdate("restrict"),
  ...[table.artifact_id, table.instance_id, table.grant_id, table.action_id, table.control_id].map((column) =>
    check(`browser_file_artifact_${column.name}_text_check`, sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`)),
  ...[table.grant_hash, table.scope_hash, table.record_hash].map((column) =>
    check(`browser_file_artifact_${column.name}_digest_check`, sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`)),
  ...[table.revision, table.created_at, table.updated_at].map((column) =>
    check(`browser_file_artifact_${column.name}_integer_check`, sql`typeof(${column})='integer' AND ${column} BETWEEN 1 AND 9007199254740991`)),
  check("browser_file_artifact_ordinal_check", sql`typeof(${table.ordinal})='integer' AND ${table.ordinal} BETWEEN 0 AND 3`),
  check("browser_file_artifact_reserved_check", sql`typeof(${table.reserved_bytes})='integer' AND ${table.reserved_bytes} BETWEEN 0 AND 1073741824`),
  check("browser_file_artifact_state_check", sql`${table.state} IN ('reserved','staged','selected','published','refused','unknown')`),
  check("browser_file_artifact_time_check", sql`${table.updated_at}>=${table.created_at} AND (${table.released_at} IS NULL OR (typeof(${table.released_at})='integer' AND ${table.released_at} BETWEEN ${table.created_at} AND ${table.updated_at}))`),
  check("browser_file_artifact_release_check", sql`(${table.released_at} IS NULL AND ${table.reserved_bytes}>0) OR (${table.released_at} IS NOT NULL AND ${table.state} IN ('selected','published','refused') AND ${table.reserved_bytes}=0)`),
  check("browser_file_artifact_record_check", sql`typeof(${table.record})='text' AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 8192 AND json_valid(${table.record}) AND json_type(${table.record}) IS 'object' AND json_type(${table.record},'$.version') IS 'integer' AND json_extract(${table.record},'$.version') IS 1`),
  ...([[table.artifact_id, "artifactID"], [table.instance_id, "instanceID"], [table.grant_id, "grantID"],
    [table.grant_hash, "grantHash"], [table.action_id, "actionID"], [table.control_id, "controlID"],
    [table.scope_hash, "scopeHash"], [table.state, "state"]] as const).map(([column, field]) =>
    check(`browser_file_artifact_${column.name}_mirror_check`, sql`json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'text' AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`)),
  ...([[table.ordinal, "ordinal"], [table.revision, "revision"], [table.reserved_bytes, "reservedBytes"],
    [table.created_at, "createdAt"], [table.updated_at, "updatedAt"]] as const).map(([column, field]) =>
    check(`browser_file_artifact_${column.name}_mirror_check`, sql`json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'integer' AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`)),
  check("browser_file_artifact_release_mirror_check", sql`(${table.released_at} IS NULL AND json_type(${table.record},'$.releasedAt') IS 'null') OR (${table.released_at} IS NOT NULL AND json_type(${table.record},'$.releasedAt') IS 'integer' AND json_extract(${table.record},'$.releasedAt') IS ${table.released_at})`),
])
