import { Schema } from "effect"
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { ProjectTable } from "../project/sql"
import * as IMID from "./id"

// V3.8: project / system  ·  V4.0 §B3: direct (private 1:1 — user+user or user+agent, exactly 2 members)
export const GroupType = Schema.Literals(["project", "system", "direct"])
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

// W0.4 — durable @mention-routing receipt. Written by the event-dispatcher mention router when a
// mentioned agent did not declare the mention trigger (or no agent declared it), so the user gets an
// explicit receipt instead of a silent no_match drop. Additive: older rows decode unchanged.
export const NoTriggerMentionMetadata = Schema.Struct({
  type: Schema.Literal("agent_no_trigger_mention"),
  agentID: Schema.optional(Schema.String),
  agentNames: Schema.optional(Schema.Array(Schema.String)),
  eventID: Schema.optional(Schema.String),
  messageID: Schema.optional(Schema.String),
})
export type NoTriggerMentionMetadata = Schema.Schema.Type<typeof NoTriggerMentionMetadata>

// A history poll on an established connection can precede the websocket notification.
// Only that later verified live notification may reconcile Agent admission for this row.
export const KernelSyncMetadata = Schema.Struct({
  type: Schema.Literal("kernel_sync"),
  liveEligible: Schema.Boolean,
})

export const MessageMetadata = Schema.Union([
  KernelSyncMetadata,
  FileRefMetadata,
  CodeRefMetadata,
  AgentRunMetadata,
  DebugMetadata,
  ProfileMetadata,
  ErrorMetadata,
  NoTriggerMentionMetadata,
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
    // IM-kernel conversation binding (JuggleIM B1): `k:<channel_type>:<id>` — channel_type 1 (private)
    // holds the counterparty's kernel user id, 2 (group) the kernel group id. NULL for local-only
    // groups (e.g. "我的 Agent"). SQLite treats NULLs as distinct in a unique index, so any number of
    // unbound groups coexist.
    kernel_conv_id: text(),
    created_at: integer().notNull().$default(() => Date.now()),
    updated_at: integer().notNull().$onUpdate(() => Date.now()),
    deleted_at: integer(),
  },
  (table) => [
    index("im_groups_workspace_idx").on(table.workspace_id),
    index("im_groups_project_idx").on(table.project_id),
    uniqueIndex("idx_im_groups_kernel_conv").on(table.kernel_conv_id),
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
    // IM-kernel dedup/identity key (JuggleIM B1): the kernel-assigned message id from the send ack
    // (or from an inbound kernel push). NULL ⇒ the message never reached the kernel (locally
    // persisted pending send, or a local-only group). At-least-once delivery + this unique index =
    // exactly-once local persistence: an inbound redelivery whose kernel id already has a row is a
    // no-op. SQLite admits any number of NULLs in a unique index.
    kernel_msg_id: text(),
    client_request_id: text(),
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
    uniqueIndex("idx_im_messages_kernel_msg").on(table.kernel_msg_id),
    uniqueIndex("idx_im_messages_client_request").on(table.sender_id, table.client_request_id),
  ],
)

// IM-kernel sync cursors (JuggleIM B1): per-kernel-conversation high-water marks for the offline
// catch-up pass. `conversation_id` is the kernel conversation key (`k:<channel_type>:<id>`, the same
// convention as im_groups.kernel_conv_id). `last_sync_time` is the newest kernel msgTime (ms)
// persisted locally; the hismsgs backstop pages BACKWARD from the TTL window and stops once it hits
// rows at or below this watermark (kernel WS sync queue only covers the recent window, so hismsgs is
// the 72h catch-up channel). `last_sync_seq` reserves the kernel monotonic per-conversation sequence
// for gap detection; NULL when the kernel did not supply one.
export const SyncCursorTable = sqliteTable("im_sync_cursors", {
  conversation_id: text().primaryKey(),
  last_sync_time: integer().notNull().$default(() => 0),
  last_sync_seq: integer(),
  updated_at: integer().notNull().$onUpdate(() => Date.now()),
})

// V4.0 §B3/§B4 schema: im_attachments
//
// A file record is DECOUPLED from a message ("文件记录与消息解耦"): `message_id` is nullable so a file
// can be uploaded first (returning its id/checksum) and only later referenced by a message — or never
// referenced at all. `storage_path` is a SERVER-DERIVED absolute path on local disk (workspace data
// dir), never the client filename, which eliminates path-traversal. `checksum` is the sha256 of the
// bytes (integrity + dedup signal). Soft delete via `deleted_at` mirrors the rest of the IM schema.
export const AttachmentTable = sqliteTable(
  "im_attachments",
  {
    id: text().$type<IMID.AttachmentID>().primaryKey(),
    // Grouping key (routed workspace id or working directory) — same semantics as im_groups.workspace_id.
    workspace_id: text().notNull(),
    project_id: text().references(() => ProjectTable.id, { onDelete: "cascade" }),
    // Nullable: an attachment MAY be scoped to a group / bound to a message, or exist standalone.
    group_id: text().$type<IMID.GroupID>(),
    message_id: text().$type<IMID.MessageID>(),
    uploaded_by: text().notNull(),
    // Absolute on-disk path, server-derived from ids (never the client filename).
    storage_path: text().notNull(),
    // Original client filename — retained for display/download only, never used to build a path.
    filename: text().notNull(),
    mime: text().notNull(),
    size_bytes: integer().notNull(),
    // sha256 hex digest of the stored bytes.
    checksum: text().notNull(),
    created_at: integer().notNull().$default(() => Date.now()),
    deleted_at: integer(),
  },
  (table) => [
    index("idx_im_attachments_workspace").on(table.workspace_id, table.created_at),
    index("idx_im_attachments_message").on(table.message_id),
    index("idx_im_attachments_group").on(table.group_id),
  ],
)
