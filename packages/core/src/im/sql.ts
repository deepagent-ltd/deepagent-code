import { Schema } from "effect"
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { ProjectTable } from "../project/sql"
import * as IMID from "./id"

// V3.8: project / system
export const GroupType = Schema.Literals(["project", "system"])
export type GroupType = Schema.Schema.Type<typeof GroupType>

// V3.8: owner / member / agent
export const MemberRole = Schema.Literals(["owner", "member", "agent"])
export type MemberRole = Schema.Schema.Type<typeof MemberRole>

// V3.8: user / agent
export const MemberType = Schema.Literals(["user", "agent"])
export type MemberType = Schema.Schema.Type<typeof MemberType>

export const SenderType = Schema.Literals(["user", "agent", "system"])
export type SenderType = Schema.Schema.Type<typeof SenderType>

// V3.8: text / code / file / agent_status / system
export const MessageType = Schema.Literals(["text", "code", "file", "agent_status", "system"])
export type MessageType = Schema.Schema.Type<typeof MessageType>

// Metadata types based on V3.8 spec
export const FileRefMetadata = Schema.Struct({
  type: Schema.Literal("file_ref"),
  path: Schema.String,
  line: Schema.optional(Schema.Number),
  endLine: Schema.optional(Schema.Number),
})
export type FileRefMetadata = Schema.Schema.Type<typeof FileRefMetadata>

export const CodeRefMetadata = Schema.Struct({
  type: Schema.Literal("code_ref"),
  path: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  startLine: Schema.optional(Schema.Number),
  endLine: Schema.optional(Schema.Number),
})
export type CodeRefMetadata = Schema.Schema.Type<typeof CodeRefMetadata>

export const AgentRunMetadata = Schema.Struct({
  type: Schema.Literal("agent_run"),
  sessionID: Schema.String,
  runID: Schema.optional(Schema.String),
  status: Schema.Literals(["running", "success", "failed", "timeout"]),
})
export type AgentRunMetadata = Schema.Schema.Type<typeof AgentRunMetadata>

export const DebugMetadata = Schema.Struct({
  type: Schema.Literal("debug"),
  sessionID: Schema.String,
  target: Schema.optional(Schema.String),
})
export type DebugMetadata = Schema.Schema.Type<typeof DebugMetadata>

export const ProfileMetadata = Schema.Struct({
  type: Schema.Literal("profile"),
  runID: Schema.String,
  artifactPath: Schema.optional(Schema.String),
})
export type ProfileMetadata = Schema.Schema.Type<typeof ProfileMetadata>

export const ErrorMetadata = Schema.Struct({
  type: Schema.Literal("error"),
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
})
export type ErrorMetadata = Schema.Schema.Type<typeof ErrorMetadata>

export const MessageMetadata = Schema.Union([
  FileRefMetadata,
  CodeRefMetadata,
  AgentRunMetadata,
  DebugMetadata,
  ProfileMetadata,
  ErrorMetadata,
]).pipe(Schema.toTaggedUnion("type"))
export type MessageMetadata = Schema.Schema.Type<typeof MessageMetadata>

// V3.8 schema: im_groups
export const GroupTable = sqliteTable(
  "im_groups",
  {
    id: text().$type<IMID.GroupID>().primaryKey(),
    // Grouping key, not a foreign key: holds the routed workspace id when one
    // exists, otherwise the working directory (single-user / directory-routed
    // model has no `workspace` row). Project scoping is via `project_id` below.
    workspace_id: text().notNull(),
    project_id: text().references(() => ProjectTable.id, { onDelete: "cascade" }),
    type: text().$type<GroupType>().notNull(),
    name: text().notNull(),
    created_by: text().notNull(),
    created_at: integer().notNull().$default(() => Date.now()),
    updated_at: integer().notNull().$onUpdate(() => Date.now()),
    deleted_at: integer(),
  },
  (table) => [
    index("im_groups_workspace_idx").on(table.workspace_id),
    index("im_groups_project_idx").on(table.project_id),
  ],
)

// V3.8 schema: im_members
export const MemberTable = sqliteTable(
  "im_members",
  {
    group_id: text()
      .$type<IMID.GroupID>()
      .notNull()
      .references(() => GroupTable.id, { onDelete: "cascade" }),
    member_id: text().notNull(),
    member_type: text().$type<MemberType>().notNull(),
    role: text().$type<MemberRole>().notNull().$default(() => "member"),
    last_read_at: integer(),
    joined_at: integer().notNull().$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("im_members_unique_idx").on(table.group_id, table.member_id, table.member_type),
    index("idx_im_members_unread").on(table.member_id, table.group_id, table.last_read_at),
  ],
)

// V3.8 schema: im_messages
export const MessageTable = sqliteTable(
  "im_messages",
  {
    id: text().$type<IMID.MessageID>().primaryKey(),
    group_id: text()
      .$type<IMID.GroupID>()
      .notNull()
      .references(() => GroupTable.id, { onDelete: "cascade" }),
    sender_id: text().notNull(),
    sender_type: text().$type<SenderType>().notNull(),
    type: text().$type<MessageType>().notNull().$default(() => "text"),
    content: text().notNull(),
    mentions: text({ mode: "json" }).$type<string[]>(),
    metadata: text({ mode: "json" }).$type<MessageMetadata>(),
    reply_to_id: text().$type<IMID.MessageID>(),
    // V4.0 §B4 — the DeepAgent Event Bus event this message was produced from (agent replies / proactive
    // pushes carry it; user messages that publish im.message.created link back via it). NULL for legacy
    // V3.8 messages — nullable so the V3.8 write path is unchanged (§H compatibility).
    event_id: text(),
    // V4.0 §B4 — delivery lifecycle for event-driven messages: pending | delivered | failed. NULL ⇒
    // the legacy synchronous path (no delivery tracking). Nullable for V3.8 compatibility.
    delivery_status: text().$type<"pending" | "delivered" | "failed">(),
    created_at: integer().notNull().$default(() => Date.now()),
    updated_at: integer().notNull().$onUpdate(() => Date.now()),
    deleted_at: integer(),
  },
  (table) => [
    // Index definition mirrors the columns in the hand-written partial-index
    // migration. Drizzle's sqlite-core types in this repo version do not expose
    // `.where()` on indexes, so the partial predicate lives in the migration.
    index("idx_im_messages_active").on(table.group_id, table.created_at, table.id),
    // V4.0 §B4 — thread pagination (reply_to_id chains) + event linkage lookups.
    index("idx_im_messages_thread").on(table.group_id, table.reply_to_id, table.created_at),
    index("idx_im_messages_event").on(table.event_id),
  ],
)
