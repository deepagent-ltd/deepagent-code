import { sql, type SQLWrapper } from "drizzle-orm"
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { GroupTable, MessageTable } from "./sql"

// Server ordinals remain exact decimal TEXT. JSON remains its original encoded
// bytes; the reader store applies the full strict schema before using a row.
export const IMKernelReaderMeterTable = sqliteTable(
  "im_kernel_reader_meter",
  {
    id: integer().primaryKey().notNull(),
    version: integer().notNull(),
    instance_id: text().notNull(),
    revision: integer().notNull(),
    used_records: integer().notNull(),
    used_bytes: integer().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    check("im_kernel_reader_meter_singleton_check", sql`${safeInteger(table.id, 1, 1)} AND ${safeInteger(table.version, 1, 1)} AND ${uuid(table.instance_id)}`),
    check("im_kernel_reader_meter_quota_check", sql`${safeInteger(table.revision, 1)} AND ${safeInteger(table.used_records, 1, 100000)} AND ${safeInteger(table.used_bytes, 1024, 268435456)}`),
    check("im_kernel_reader_meter_time_check", sql`${safeInteger(table.created_at)} AND ${safeInteger(table.updated_at)} AND ${table.updated_at} >= ${table.created_at}`),
    uniqueIndex("im_kernel_reader_meter_instance_idx").on(table.instance_id),
  ],
)

export const IMKernelReaderScopeTable = sqliteTable(
  "im_kernel_reader_scope",
  {
    reader_key: text().primaryKey().notNull(),
    meter_id: integer().notNull().default(1).references(() => IMKernelReaderMeterTable.id, { onDelete: "restrict", onUpdate: "restrict" }),
    ...common(),
    workspace_id: text().notNull(),
    scope_key: text().notNull(),
    binding: text().notNull(),
    binding_hash: text().notNull(),
    phase: text().notNull(),
    completed_after: text().notNull(),
    continuation: text().notNull(),
    fixed_limit: integer().notNull(),
    window_after: text(),
    window_upper: text(),
    scan_cursor: text(),
    scan_projection_key: text(),
    page_token: text(),
    blocked_code: text(),
  },
  (table) => [
    check("im_kernel_reader_scope_version_check", safeInteger(table.version, 1, 1)),
    check("im_kernel_reader_scope_time_check", sql`${safeInteger(table.local_revision, 1)} AND ${safeInteger(table.created_at)} AND ${safeInteger(table.updated_at)} AND ${table.updated_at} >= ${table.created_at}`),
    check("im_kernel_reader_scope_accounting_check", sql`${safeInteger(table.accounted_records, 1, 3)} AND ${safeInteger(table.accounted_bytes, 1024, 268435456)}`),
    check("im_kernel_reader_scope_identity_check", sql`(${hash(table.reader_key)}) AND (${hash(table.scope_key)}) AND (${hash(table.binding_hash)}) AND (${textBytes(table.workspace_id, 4096)}) AND (${safeInteger(table.meter_id, 1, 1)})`),
    check("im_kernel_reader_scope_binding_check", sql`${versionedJson(table.binding, 8192)} AND coalesce(json_extract(${table.binding}, '$.workspaceID') = ${table.workspace_id} AND json_extract(${table.binding}, '$.scopeKey') = ${table.scope_key}, 0)`),
    check("im_kernel_reader_scope_continuation_check", sql`${versionedJson(table.continuation, 8192)} AND coalesce(json_type(${table.continuation}, '$.projections') = 'array' AND json_array_length(${table.continuation}, '$.projections') BETWEEN 0 AND 32, 0)`),
    check("im_kernel_reader_scope_cursor_check", sql`(${decimal(table.completed_after)}) AND (${sql`${table.window_after} IS NULL OR ${decimal(table.window_after)}`}) AND (${sql`${table.window_upper} IS NULL OR ${decimal(table.window_upper)}`}) AND (${sql`${table.scan_cursor} IS NULL OR ${decimal(table.scan_cursor)}`}) AND (${sql`${table.scan_projection_key} IS NULL OR ${hash(table.scan_projection_key)}`})`),
    check("im_kernel_reader_scope_window_check", sql`(${table.window_after} IS NULL AND ${table.window_upper} IS NULL AND ${table.scan_cursor} IS NULL AND ${table.scan_projection_key} IS NULL AND ${table.page_token} IS NULL) OR (${table.window_after} IS NOT NULL AND ${table.window_upper} IS NOT NULL AND ${table.scan_cursor} IS NOT NULL AND (${ordered(table.window_after, table.scan_cursor)}) AND (${ordered(table.scan_cursor, table.window_upper)}))`),
    check("im_kernel_reader_scope_phase_check", sql`${table.phase} IN ('idle','partial','blocked','purging') AND (${table.phase} <> 'idle' OR (${table.window_after} IS NULL AND ${table.page_token} IS NULL AND json_array_length(${table.continuation}, '$.projections') = 0)) AND (${table.phase} <> 'partial' OR ${table.window_after} IS NOT NULL)`),
    check("im_kernel_reader_scope_page_check", sql`${safeInteger(table.fixed_limit, 1, 32)} AND (${table.page_token} IS NULL OR ${textBytes(table.page_token, 1024)}) AND (${table.blocked_code} IS NULL OR ${table.blocked_code} IN ('stale','unavailable','capacity','invalid','collision')) AND ${table.accounted_records} = 1`),
    uniqueIndex("im_kernel_reader_scope_binding_idx").on(table.binding_hash),
    index("im_kernel_reader_scope_workspace_idx").on(table.workspace_id, table.reader_key),
  ],
)

export const IMKernelReaderProjectionTable = sqliteTable(
  "im_kernel_reader_projection",
  {
    reader_key: text().notNull(),
    binding_key: text().notNull(),
    projection_key: text(),
    ...common(),
    visibility: text().notNull(),
    metadata: text().notNull(),
    metadata_hash: text().notNull(),
    newer_after: text().notNull(),
    last_server_now: integer().notNull(),
    observed_at: integer().notNull(),
    history_complete: integer().notNull(),
    owned_group_bytes: integer().notNull(),
    target_id: text(),
    server_revision: text(),
    cursor: text(),
    read_ordinal: text(),
    admitted_ordinal: text(),
    live_unread: text(),
    stored_unread: text(),
    older_before: text(),
    scan_revision: text(),
    conversation_type: integer(),
    local_group_id: text().references(() => GroupTable.id, { onDelete: "restrict", onUpdate: "restrict" }),
    next_expiry_at: integer(),
  },
  (table) => [
    check("im_kernel_reader_projection_version_check", safeInteger(table.version, 1, 1)),
    check("im_kernel_reader_projection_time_check", sql`${safeInteger(table.local_revision, 1)} AND ${safeInteger(table.created_at)} AND ${safeInteger(table.updated_at)} AND ${table.updated_at} >= ${table.created_at}`),
    check("im_kernel_reader_projection_accounting_check", sql`${safeInteger(table.accounted_records, 1, 3)} AND ${safeInteger(table.accounted_bytes, 1024, 268435456)}`),
    check("im_kernel_reader_projection_identity_check", sql`(${hash(table.reader_key)}) AND (${hash(table.binding_key)}) AND (${hash(table.metadata_hash)}) AND (${sql`${table.projection_key} IS NULL OR ${hash(table.projection_key)}`}) AND (${sql`${table.target_id} IS NULL OR ${textBytes(table.target_id, 512)}`}) AND (${sql`${table.local_group_id} IS NULL OR ${textBytes(table.local_group_id, 128)}`})`),
    check("im_kernel_reader_projection_metadata_check", versionedJson(table.metadata, 4096)),
    check("im_kernel_reader_projection_decimals_check", sql`(${decimal(table.newer_after)}) AND (${sql`${table.server_revision} IS NULL OR ${decimal(table.server_revision, true)}`}) AND (${sql`${table.cursor} IS NULL OR ${decimal(table.cursor)}`}) AND (${sql`${table.read_ordinal} IS NULL OR ${decimal(table.read_ordinal)}`}) AND (${sql`${table.admitted_ordinal} IS NULL OR ${decimal(table.admitted_ordinal)}`}) AND (${sql`${table.live_unread} IS NULL OR ${decimal(table.live_unread)}`}) AND (${sql`${table.stored_unread} IS NULL OR ${decimal(table.stored_unread)}`}) AND (${sql`${table.older_before} IS NULL OR ${decimal(table.older_before)}`}) AND (${sql`${table.scan_revision} IS NULL OR ${decimal(table.scan_revision, true)}`})`),
    check("im_kernel_reader_projection_observation_check", sql`${safeInteger(table.last_server_now)} AND ${safeInteger(table.observed_at)} AND ${safeInteger(table.history_complete, 0, 1)} AND ${safeInteger(table.owned_group_bytes, 0, 268435456)} AND (${table.next_expiry_at} IS NULL OR ${safeInteger(table.next_expiry_at)}) AND (${table.conversation_type} IS NULL OR ${safeInteger(table.conversation_type, 1, 2)})`),
    check("im_kernel_reader_projection_owned_group_check", sql`(${table.local_group_id} IS NULL AND ${table.owned_group_bytes} = 0 AND ${table.accounted_records} = 1) OR (${table.local_group_id} IS NOT NULL AND ${table.owned_group_bytes} >= 1024 AND ${table.accounted_records} = 3)`),
    check("im_kernel_reader_projection_visibility_check", sql`${table.visibility} IN ('pending','visible','revoked') AND (${table.visibility} = 'pending' OR (${table.projection_key} IS NOT NULL AND ${table.server_revision} IS NOT NULL AND ${table.cursor} IS NOT NULL)) AND (${table.visibility} <> 'pending' OR (${table.projection_key} IS NULL AND ${table.server_revision} IS NULL AND ${table.cursor} IS NULL AND ${table.conversation_type} IS NOT NULL AND ${table.target_id} IS NOT NULL AND ${table.read_ordinal} IS NULL AND ${table.admitted_ordinal} IS NULL AND ${table.live_unread} IS NULL AND ${table.stored_unread} IS NULL AND ${table.scan_revision} IS NULL AND ${table.next_expiry_at} IS NULL AND ${table.newer_after} = '0' AND ${table.older_before} IS NULL AND ${table.history_complete} = 0)) AND (${table.visibility} <> 'revoked' OR (${table.read_ordinal} IS NULL AND ${table.admitted_ordinal} IS NULL AND ${table.live_unread} IS NULL AND ${table.stored_unread} IS NULL)) AND (${table.visibility} <> 'visible' OR (${table.conversation_type} IS NOT NULL AND ${table.target_id} IS NOT NULL AND ${table.read_ordinal} IS NOT NULL AND ${table.admitted_ordinal} IS NOT NULL AND ${table.live_unread} IS NOT NULL AND ${table.stored_unread} IS NOT NULL AND (${ordered(table.read_ordinal, table.admitted_ordinal)}) AND (${ordered(table.live_unread, table.stored_unread)}) AND (${ordered(table.stored_unread, table.admitted_ordinal)})))`),
    primaryKey({ columns: [table.reader_key, table.binding_key] }),
    foreignKey({ columns: [table.reader_key], foreignColumns: [IMKernelReaderScopeTable.reader_key] }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("im_kernel_reader_projection_exact_idx").on(table.reader_key, table.binding_key, table.projection_key),
    uniqueIndex("im_kernel_reader_projection_server_idx").on(table.reader_key, table.projection_key),
    uniqueIndex("im_kernel_reader_projection_group_idx").on(table.local_group_id),
    uniqueIndex("im_kernel_reader_projection_target_idx").on(table.reader_key, table.conversation_type, table.target_id).where(sql`${table.target_id} IS NOT NULL`),
    index("im_kernel_reader_projection_cursor_idx").on(table.reader_key, sql`length(${table.cursor})`, table.cursor, table.projection_key),
    index("im_kernel_reader_projection_expiry_idx").on(table.reader_key, table.next_expiry_at, table.projection_key),
  ],
)

export const IMKernelReaderMessageTable = sqliteTable(
  "im_kernel_reader_message",
  {
    reader_key: text().notNull(),
    effect_key: text().notNull(),
    binding_key: text().notNull(),
    projection_key: text().notNull(),
    message_id: text().notNull(),
    sequence: text().notNull(),
    delivery_cursor: text().notNull(),
    sender_id: text().notNull(),
    target_id: text().notNull(),
    body_hash: text().notNull(),
    immutable_hash: text().notNull(),
    storage_state: text().notNull(),
    metadata: text().notNull(),
    message_time: integer().notNull(),
    expires_at: integer().notNull(),
    conversation_type: integer().notNull(),
    owns_message: integer().notNull(),
    body_bytes: integer().notNull(),
    obligation_records: integer().notNull().default(0),
    obligation_bytes: integer().notNull().default(0),
    ...common(),
    local_message_id: text().references(() => MessageTable.id, { onDelete: "restrict", onUpdate: "restrict" }),
  },
  (table) => [
    check("im_kernel_reader_message_version_check", safeInteger(table.version, 1, 1)),
    check("im_kernel_reader_message_time_check", sql`${safeInteger(table.local_revision, 1)} AND ${safeInteger(table.created_at)} AND ${safeInteger(table.updated_at)} AND ${table.updated_at} >= ${table.created_at}`),
    check("im_kernel_reader_message_accounting_check", sql`${safeInteger(table.accounted_records, 1, 100000)} AND ${safeInteger(table.accounted_bytes, 1024, 268435456)}`),
    check("im_kernel_reader_message_identity_check", sql`(${hash(table.reader_key)}) AND (${hash(table.effect_key)}) AND (${hash(table.binding_key)}) AND (${hash(table.projection_key)}) AND (${hash(table.body_hash)}) AND (${hash(table.immutable_hash)}) AND (${textBytes(table.message_id, 512)}) AND (${textBytes(table.sender_id, 512)}) AND (${textBytes(table.target_id, 512)}) AND (${sql`${table.local_message_id} IS NULL OR ${textBytes(table.local_message_id, 128)}`})`),
    check("im_kernel_reader_message_sequence_check", sql`${decimal(table.sequence, true)} AND ${decimal(table.delivery_cursor, true)}`),
    check("im_kernel_reader_message_message_time_check", sql`${safeInteger(table.message_time)} AND ${safeInteger(table.expires_at)} AND ${table.expires_at} > ${table.message_time}`),
    check("im_kernel_reader_message_body_check", sql`${safeInteger(table.conversation_type, 1, 2)} AND ${safeInteger(table.owns_message, 0, 1)} AND ${safeInteger(table.body_bytes, 0, 65536)} AND ${safeInteger(table.obligation_records, 0, 100000)} AND ${safeInteger(table.obligation_bytes, 0, 268435456)} AND ((${table.obligation_records} = 0 AND ${table.obligation_bytes} = 0) OR (${table.obligation_records} > 0 AND ${table.obligation_bytes} >= 1024 * ${table.obligation_records} AND ${table.owns_message} = 1)) AND ${table.accounted_records} = 1 + ${table.owns_message} + ${table.obligation_records}`),
    check("im_kernel_reader_message_metadata_check", versionedJson(table.metadata, 2048)),
    check("im_kernel_reader_message_storage_check", sql`(${table.storage_state} = 'present' AND ${table.local_message_id} IS NOT NULL) OR (${table.storage_state} IN ('expired','redacted') AND ${table.local_message_id} IS NULL AND ${table.body_bytes} = 0 AND ${table.owns_message} = 0 AND ${table.obligation_records} = 0) OR (${table.storage_state} IN ('expired_obligation','redacted_obligation') AND ${table.local_message_id} IS NOT NULL AND ${table.body_bytes} = 0 AND ${table.owns_message} = 1 AND ${table.obligation_records} > 0)`),
    primaryKey({ columns: [table.reader_key, table.effect_key] }),
    foreignKey({ columns: [table.reader_key, table.binding_key, table.projection_key], foreignColumns: [IMKernelReaderProjectionTable.reader_key, IMKernelReaderProjectionTable.binding_key, IMKernelReaderProjectionTable.projection_key] }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("im_kernel_reader_message_original_idx").on(table.reader_key, table.projection_key, table.message_id),
    uniqueIndex("im_kernel_reader_message_cursor_idx").on(table.reader_key, table.projection_key, table.delivery_cursor),
    uniqueIndex("im_kernel_reader_message_local_idx").on(table.local_message_id),
    index("im_kernel_reader_message_page_idx").on(table.reader_key, table.projection_key, sql`length(${table.delivery_cursor})`, table.delivery_cursor, table.effect_key),
    index("im_kernel_reader_message_expiry_idx").on(table.expires_at, table.reader_key, table.effect_key),
  ],
)

export const IMKernelReaderReadIntentTable = sqliteTable(
  "im_kernel_reader_read_intent",
  {
    action_id: text().primaryKey().notNull(),
    original_action_id: text().notNull(),
    cut_index: integer().notNull(),
    parent_action_id: text(),
    reader_key: text().notNull(),
    binding_key: text().notNull(),
    projection_key: text().notNull(),
    phase: text().notNull(),
    original_projection_revision: text().notNull(),
    original_target_admitted: text().notNull(),
    cut_revision: text().notNull(),
    through_ordinal: text().notNull(),
    request_hash: text().notNull(),
    request: text().notNull(),
    ...common(),
    result: text(),
    dispatched_at: integer(),
    settled_at: integer(),
    runtime_incarnation: text(),
  },
  (table) => [
    check(
      "im_kernel_reader_read_intent_lineage_check",
      sql`${textBytes(table.original_action_id, 128)} AND ${table.original_action_id} NOT GLOB '*[^A-Za-z0-9_-]*' AND ${safeInteger(table.cut_index, 0, 31)} AND ((${table.cut_index} = 0 AND ${table.action_id} = ${table.original_action_id} AND ${table.parent_action_id} IS NULL) OR (${table.cut_index} > 0 AND ${table.action_id} <> ${table.original_action_id} AND ${table.parent_action_id} IS NOT NULL AND ${table.parent_action_id} = ${table.original_action_id}))`,
    ),
    check("im_kernel_reader_read_intent_version_check", safeInteger(table.version, 1, 1)),
    check("im_kernel_reader_read_intent_time_check", sql`${safeInteger(table.local_revision, 1)} AND ${safeInteger(table.created_at)} AND ${safeInteger(table.updated_at)} AND ${table.updated_at} >= ${table.created_at}`),
    check("im_kernel_reader_read_intent_accounting_check", sql`${safeInteger(table.accounted_records, 1, 3)} AND ${safeInteger(table.accounted_bytes, 1024, 268435456)}`),
    check("im_kernel_reader_read_intent_identity_check", sql`(${textBytes(table.action_id, 128)}) AND (${sql`${table.action_id} NOT GLOB '*[^A-Za-z0-9_-]*'`}) AND (${hash(table.reader_key)}) AND (${hash(table.binding_key)}) AND (${hash(table.projection_key)}) AND (${hash(table.request_hash)}) AND (${sql`${table.runtime_incarnation} IS NULL OR ${uuid(table.runtime_incarnation)}`})`),
    check("im_kernel_reader_read_intent_cut_check", sql`${decimal(table.original_projection_revision, true)} AND ${decimal(table.original_target_admitted)} AND ${decimal(table.cut_revision, true)} AND ${decimal(table.through_ordinal)} AND (${ordered(table.through_ordinal, table.original_target_admitted)})`),
    check("im_kernel_reader_read_intent_request_check", sql`${versionedJson(table.request, 4096, 2)} AND (${table.result} IS NULL OR ${versionedJson(table.result, 4096, 2)}) AND ${table.accounted_records} = 1`),
    check("im_kernel_reader_read_intent_dispatch_time_check", sql`(${table.dispatched_at} IS NULL OR (${safeInteger(table.dispatched_at)} AND ${table.dispatched_at} >= ${table.created_at} AND ${table.dispatched_at} <= ${table.updated_at})) AND (${table.settled_at} IS NULL OR (${safeInteger(table.settled_at)} AND ${table.settled_at} >= ${table.created_at} AND ${table.settled_at} <= ${table.updated_at} AND (${table.dispatched_at} IS NULL OR ${table.settled_at} >= ${table.dispatched_at})))`),
    check("im_kernel_reader_read_intent_phase_check", sql`(${table.phase} = 'prepared' AND ${table.dispatched_at} IS NULL AND ${table.settled_at} IS NULL AND ${table.runtime_incarnation} IS NULL AND ${table.result} IS NULL) OR (${table.phase} IN ('dispatched','unknown') AND ${table.dispatched_at} IS NOT NULL AND ${table.settled_at} IS NULL AND ${table.runtime_incarnation} IS NOT NULL AND ${table.result} IS NULL) OR (${table.phase} = 'confirmed' AND ${table.dispatched_at} IS NOT NULL AND ${table.settled_at} IS NOT NULL AND ${table.runtime_incarnation} IS NOT NULL AND ${table.result} IS NOT NULL) OR (${table.phase} = 'cancelled' AND ${table.settled_at} IS NOT NULL)`),
    foreignKey({ columns: [table.reader_key, table.binding_key, table.projection_key], foreignColumns: [IMKernelReaderProjectionTable.reader_key, IMKernelReaderProjectionTable.binding_key, IMKernelReaderProjectionTable.projection_key] }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({ columns: [table.parent_action_id, table.reader_key, table.binding_key, table.projection_key], foreignColumns: [table.action_id, table.reader_key, table.binding_key, table.projection_key] }).onDelete("restrict").onUpdate("restrict"),
    uniqueIndex("im_kernel_reader_read_intent_identity_idx").on(table.action_id, table.reader_key, table.binding_key, table.projection_key),
    uniqueIndex("im_kernel_reader_read_intent_cut_idx").on(table.reader_key, table.projection_key, table.original_action_id, table.cut_index),
    uniqueIndex("im_kernel_reader_read_intent_inflight_idx").on(table.reader_key, table.projection_key).where(sql`${table.phase} IN ('prepared','dispatched')`),
    index("im_kernel_reader_read_intent_phase_idx").on(table.reader_key, table.phase, table.action_id),
    index("im_kernel_reader_read_intent_lookup_idx").on(table.reader_key, table.binding_key, table.projection_key, table.created_at, table.cut_index, table.action_id),
    index("im_kernel_reader_read_intent_unknown_idx").on(table.reader_key, table.projection_key, table.binding_key, table.created_at, table.cut_index, table.action_id).where(sql`${table.phase} = 'unknown'`),
    index("im_kernel_reader_read_intent_root_idx").on(table.reader_key, table.binding_key, table.projection_key, table.created_at, table.action_id).where(sql`${table.cut_index} = 0`),
  ],
)


function textBytes(column: SQLWrapper, maximum: number) {
  return sql`typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${sql.raw(String(maximum))} AND instr(${column}, char(0)) = 0`
}

function hash(column: SQLWrapper) {
  return sql`${textBytes(column, 64)} AND length(${column}) = 64 AND length(CAST(${column} AS BLOB)) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`
}

function decimal(column: SQLWrapper, positive = false) {
  return sql`${textBytes(column, 19)} AND length(${column}) = length(CAST(${column} AS BLOB)) AND ${column} NOT GLOB '*[^0-9]*' AND (${column} = '0' OR substr(${column}, 1, 1) BETWEEN '1' AND '9') AND (length(${column}) < 19 OR ${column} COLLATE BINARY <= '9223372036854775807') AND (${positive ? sql`${column} <> '0'` : sql`1`})`
}

function ordered(left: SQLWrapper, right: SQLWrapper) {
  return sql`length(${left}) < length(${right}) OR (length(${left}) = length(${right}) AND ${left} COLLATE BINARY <= ${right} COLLATE BINARY)`
}

function safeInteger(column: SQLWrapper, minimum = 0, maximum = 9007199254740991) {
  return sql`typeof(${column}) = 'integer' AND ${column} BETWEEN ${sql.raw(String(minimum))} AND ${sql.raw(String(maximum))}`
}

function versionedJson(column: SQLWrapper, maximum: number, maximumVersion: 1 | 2 = 1) {
  return sql`CASE WHEN typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${sql.raw(String(maximum))} AND instr(${column}, char(0)) = 0 AND json_valid(${column}) THEN coalesce(json_type(${column}) = 'object' AND json_type(${column}, '$.version') = 'integer' AND ${maximumVersion === 1 ? sql`json_extract(${column}, '$.version') = 1` : sql`json_extract(${column}, '$.version') IN (1,2)`}, 0) ELSE 0 END`
}

function uuid(column: SQLWrapper) {
  return sql`${textBytes(column, 36)} AND length(${column}) = 36 AND substr(${column}, 9, 1) = '-' AND substr(${column}, 14, 1) = '-' AND substr(${column}, 19, 1) = '-' AND substr(${column}, 24, 1) = '-' AND length(replace(${column}, '-', '')) = 32 AND replace(${column}, '-', '') NOT GLOB '*[^0-9a-f]*'`
}

function common() {
  return {
    version: integer().notNull(),
    local_revision: integer().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    accounted_records: integer().notNull(),
    accounted_bytes: integer().notNull(),
  }
}
