import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { ProjectTable } from "../project/sql"
import type { SessionMessage } from "./message"
import type { Prompt } from "./prompt"
import type { SessionInput } from "./input"
import type { Snapshot } from "../snapshot"
import { PermissionV1 } from "../v1/permission"
import { ProjectV2 } from "../project"
import type { SessionSchema } from "./schema"
import type { MessageID, PartID, SessionV1 } from "../v1/session"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { SystemContext } from "../system-context/index"
import { AgentV2 } from "../agent"
import { sql } from "drizzle-orm"

type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
type V1MessageData = Omit<SessionV1.Info, "id" | "sessionID">
type V1PartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    slug: text().notNull(),
    directory: DatabasePath.directoryColumn().notNull(),
    path: DatabasePath.pathColumn(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.FileDiff[]>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<{ messageID: MessageID; partID?: PartID; snapshot?: string; diff?: string }>(),
    permission: text({ mode: "json" }).$type<PermissionV1.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
    // Snapshot of the session's first user message (truncated, single-lined). Lets an archived-sessions
    // list render a content preview per row without loading the full conversation. Set once, never
    // overwritten. Mirrors Codex's `threads.preview`.
    preview: text(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1MessageData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

// DEPRECATED (task-tracking unification): the `todowrite` tool that wrote this table was removed in
// favor of the `plan` system. No LLM-facing tool writes here anymore. The table is retained (not
// dropped) for migration safety and so the existing read/REST path keeps working for historical
// sessions. Do not add new writers; use the plan system instead.
export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text({ mode: "json" }).notNull().$type<Prompt>(),
    delivery: text().$type<SessionInput.Delivery>().notNull(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_delivery_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.delivery,
      table.admitted_seq,
    ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
  ],
)

// V4.1 §S1.1: durable mid-turn STEER queue. A user message that arrives while a session is busy is
// admitted here (delivery="steer") and drained at the next model-request boundary of the LIVE turn
// loop (SessionPrompt.runLoop), where it is persisted as an ordinary tail user message. This is a
// PLAIN durable buffer (direct row writes, NOT event-sourced) — deliberately distinct from
// SessionInputTable, which is projected only by the dormant experimentalEventSystem V2 runner and
// feeds a different (V2) history store. Consume-once is enforced by `consumed_seq`: `drainSteer`
// atomically stamps every pending row it returns in one transaction, so a second drain (or a
// concurrent one) sees no pending rows. `seq` is a per-session monotonic admission order (autoincrement
// PK) so a drain returns steers in the exact order the user sent them.
export const SessionSteerTable = sqliteTable(
  "session_steer",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    // Canonical durable/V1 identity — always server-minted. Never reuse a client optimistic id.
    id: text().$type<SessionMessage.ID>().notNull().unique(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    // Optional client retry key isolated from the canonical durable message id. Identical retries
    // return the stored row; different payload for the same key is a CorrelationConflict.
    correlation_id: text(),
    prompt: text({ mode: "json" }).notNull().$type<Prompt>(),
    delivery: text().$type<SessionInput.Delivery>().notNull(),
    consumed_seq: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_steer_session_pending_seq_idx").on(table.session_id, table.consumed_seq, table.seq),
    uniqueIndex("session_steer_session_correlation_idx").on(table.session_id, table.correlation_id),
  ],
)

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  agent: text().$type<AgentV2.ID>().notNull().default(AgentV2.defaultID),
  snapshot: text({ mode: "json" }).notNull().$type<SystemContext.Snapshot>(),
  baseline_seq: integer().notNull(),
  replacement_seq: integer(),
  revision: integer().notNull().default(0),
})

export const TaskRunTable = sqliteTable(
  "task_run",
  {
    run_id: text().primaryKey(),
    root_run_id: text(),
    request_hash: text().notNull(),
    parent_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_message_id: text().$type<MessageID>().notNull(),
    tool_call_id: text().notNull(),
    child_session_id: text().$type<SessionSchema.ID>().notNull(),
    generation: integer().notNull(),
    delivery_mode: text().$type<"foreground" | "background">().notNull(),
    phase: text().$type<"admission" | "research" | "finalize" | "settled">().notNull(),
    state: text()
      .$type<
        "admitted" | "provisioning" | "researching" | "finalizing" | "completed" | "error" | "cancelled" | "interrupted"
      >()
      .notNull(),
    reason: text(),
    attempts: integer().notNull().default(0),
    execution_owner: text(),
    lease_expires_at: integer(),
    raw_result_message_id: text().$type<MessageID>(),
    structured_result_message_id: text().$type<MessageID>(),
    output: text(),
    error: text({ mode: "json" }).$type<{ code: string; message: string; data?: Record<string, unknown> }>(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_settled: integer(),
  },
  (table) => [
    uniqueIndex("task_run_child_generation_idx").on(table.child_session_id, table.generation),
    uniqueIndex("task_run_child_active_idx")
      .on(table.child_session_id)
      .where(sql`${table.state} IN ('admitted', 'provisioning', 'researching', 'finalizing')`),
    index("task_run_parent_state_idx").on(table.parent_session_id, table.state, table.time_updated),
    index("task_run_root_idx").on(table.root_run_id),
  ],
)

export const TaskAdmissionTable = sqliteTable(
  "task_admission",
  {
    admission_key: text().primaryKey(),
    request_hash: text().notNull(),
    run_id: text()
      .notNull()
      .references(() => TaskRunTable.run_id, { onDelete: "cascade" }),
    parent_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_message_id: text().$type<MessageID>().notNull(),
    tool_call_id: text().notNull(),
    delivery_mode: text().$type<"foreground" | "background">().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("task_admission_run_idx").on(table.run_id)],
)

export const TaskNotificationOutboxTable = sqliteTable(
  "task_notification_outbox",
  {
    id: text().primaryKey(),
    run_id: text()
      .notNull()
      .unique()
      .references(() => TaskRunTable.run_id, { onDelete: "cascade" }),
    message_id: text().$type<MessageID>().notNull().unique(),
    parent_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    directory: DatabasePath.directoryColumn().notNull(),
    payload: text({ mode: "json" })
      .$type<{
        agent: string
        variant?: string
        text: string
      }>()
      .notNull(),
    status: text().$type<"pending" | "delivering" | "delivered" | "dead">().notNull(),
    attempts: integer().notNull().default(0),
    available_at: integer().notNull(),
    lease_owner: text(),
    lease_expires_at: integer(),
    last_error: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_delivered: integer(),
  },
  (table) => [index("task_notification_outbox_due_idx").on(table.status, table.available_at, table.lease_expires_at)],
)
