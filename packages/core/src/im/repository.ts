import { Context, Effect, Layer, Schema } from "effect"
import { and, asc, desc, eq, gt, isNotNull, isNull, like, lt, or, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { contentDigest } from "../contract/digest"
import { stringify } from "../util/canonical-json"
import { IMMentionIntentTable } from "./mention-intent.sql"
import { AttachmentStorage } from "./attachment-storage"
import * as IMID from "./id"
import { AttachmentTable, GroupTable, MemberTable, MessageTable, SyncCursorTable, GroupType, MemberType, MemberRole, SenderType, MessageType, MessageMetadata } from "./sql"

// Repository errors
export class IMRepositoryError extends Schema.ErrorClass<IMRepositoryError>("IMRepositoryError")({
  message: Schema.String,
  code: Schema.optional(Schema.Literals(["message_identity_conflict", "attachment_unavailable"])),
  cause: Schema.optional(Schema.Unknown),
}) {}

const dbError = (message: string) => (cause: unknown) => new IMRepositoryError({ message, cause })

// Domain models
export const IMGroup = Schema.Struct({
  id: Schema.String,
  workspaceID: Schema.String,
  projectID: Schema.NullOr(Schema.String),
  type: Schema.String,
  name: Schema.String,
  createdBy: Schema.String,
  kernelConvID: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  deletedAt: Schema.NullOr(Schema.Number),
})
export type IMGroup = typeof IMGroup.Type

export const IMMessage = Schema.Struct({
  id: Schema.String,
  groupID: Schema.String,
  senderID: Schema.String,
  senderType: Schema.String,
  type: Schema.String,
  content: Schema.String,
  mentions: Schema.NullOr(Schema.Array(Schema.String)),
  metadata: Schema.NullOr(Schema.Unknown),
  replyToID: Schema.NullOr(Schema.String),
  kernelMsgID: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  deletedAt: Schema.NullOr(Schema.Number),
})
export type IMMessage = typeof IMMessage.Type

export const IMember = Schema.Struct({
  groupID: Schema.String,
  memberID: Schema.String,
  memberType: Schema.String,
  role: Schema.String,
  lastReadAt: Schema.NullOr(Schema.Number),
  joinedAt: Schema.Number,
})
export type IMember = typeof IMember.Type

export const MessagePage = Schema.Struct({
  messages: Schema.Array(IMMessage),
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
})
export type MessagePage = typeof MessagePage.Type

export const IMAttachment = Schema.Struct({
  id: Schema.String,
  workspaceID: Schema.String,
  projectID: Schema.NullOr(Schema.String),
  groupID: Schema.NullOr(Schema.String),
  messageID: Schema.NullOr(Schema.String),
  uploadedBy: Schema.String,
  storagePath: Schema.String,
  filename: Schema.String,
  mime: Schema.String,
  sizeBytes: Schema.Number,
  checksum: Schema.String,
  createdAt: Schema.Number,
  deletedAt: Schema.NullOr(Schema.Number),
})
export type IMAttachment = typeof IMAttachment.Type

// IM-kernel sync cursor (JuggleIM B1): per-conversation high-water mark, see SyncCursorTable.
export const IMSyncCursor = Schema.Struct({
  conversationID: Schema.String,
  lastSyncTime: Schema.Number,
  lastSyncSeq: Schema.NullOr(Schema.Number),
  updatedAt: Schema.Number,
})
export type IMSyncCursor = typeof IMSyncCursor.Type

// §B3 composite (created_at, id) keyset cursor for ASC-ordered scans (thread + search). Encoded as
// `<createdAt>_<id>` so the tie-break is stable when many rows share a millisecond. Parsing is total:
// a malformed cursor yields `undefined` (start from the beginning) rather than throwing — matching the
// defensive posture of listMessages' cursor parsing.
export interface CompositeCursor {
  readonly createdAt: number
  readonly id: string
}
export const encodeCompositeCursor = (createdAt: number, id: string): string => `${createdAt}_${id}`
export const parseCompositeCursor = (cursor: string | undefined): CompositeCursor | undefined => {
  if (!cursor) return undefined
  const sep = cursor.indexOf("_")
  if (sep <= 0) return undefined
  const createdAt = parseInt(cursor.slice(0, sep), 10)
  const id = cursor.slice(sep + 1)
  if (isNaN(createdAt) || createdAt < 0 || id.length === 0) return undefined
  return { createdAt, id }
}

// Escape LIKE wildcards in the fallback search so a user query containing % or _ is matched literally.
// Paired with an ESCAPE clause at the query site is ideal, but SQLite treats a backslash as an ordinary
// char by default; drizzle's `like` has no ESCAPE hook, so we neutralize the metacharacters by
// stripping them — acceptable for the degraded LIKE fallback (FTS5 is the primary path).
const escapeLike = (q: string): string => q.replace(/[%_\\]/g, "")

// Escape an arbitrary user query into a syntactically-safe FTS5 MATCH expression. The primary FTS path
// previously fed the RAW query straight into `content MATCH ${query}` — but FTS5 has its own query
// grammar (column filters like `foo:`, prefix `*`, boolean `AND`/`OR`/`NOT`/`NEAR`, parentheses, quoted
// phrases). Arbitrary input such as `foo:`, an unbalanced `"`, `(`, or `*` raises a SQLite syntax error
// that surfaces as a 500 rather than empty results. We neutralize the grammar by treating the query as
// plain text: tokenize on whitespace and wrap EACH term in a double-quoted FTS5 string literal (internal
// `"` doubled, per FTS5 phrase-escaping), then join with a space. Space-separated quoted phrases are an
// implicit AND in FTS5, so this yields term-AND matching (every term must appear) — a reasonable search
// semantics that treats every character literally and can never throw. A query that tokenizes to nothing
// (empty or whitespace-only) would make MATCH throw on an empty expression, so we emit `""` (a quoted
// empty phrase) which is syntactically valid and matches nothing.
const toFtsMatchQuery = (q: string): string => {
  const terms = q.trim().split(/\s+/).filter((t) => t.length > 0)
  if (terms.length === 0) return `""`
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ")
}

// Map an im_messages row (snake_case) to the camelCase IMMessage domain model.
const mapMessageRow = (m: {
  id: string
  group_id: string
  sender_id: string
  sender_type: string
  type: string
  content: string
  mentions: readonly string[] | null
  metadata: unknown
  reply_to_id: string | null
  kernel_msg_id: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}): IMMessage => ({
  id: m.id,
  groupID: m.group_id,
  senderID: m.sender_id,
  senderType: m.sender_type,
  type: m.type,
  content: m.content,
  mentions: m.mentions ?? null,
  metadata: m.metadata ?? null,
  replyToID: m.reply_to_id ?? null,
  kernelMsgID: m.kernel_msg_id ?? null,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
  deletedAt: m.deleted_at ?? null,
})

// Converged to the single canonical definition in `mention-parser.ts`
// (V3.8.1 §C.3 / conflict C6) so the new optional metadata fields
// (triggers/capabilities/autonomy/context_sources/approval_required/limits)
// live in one place. Re-exported here to preserve this module's public surface.
export { AgentDescriptor } from "./mention-parser"

// Input types
export interface CreateGroupInput {
  workspaceID: string
  projectID?: string
  type: GroupType
  name: string
  createdBy: string
  // §B3 — optional initial members added alongside the creator (creator is always added as owner). Used
  // by the direct-group path to seat the counterparty; when omitted the group starts with just the
  // creator (V3.8 behavior, unchanged).
  members?: ReadonlyArray<{ memberID: string; memberType: MemberType; role?: MemberRole }>
}

// §B3 私聊 — create (or return the existing) direct 1:1 group between exactly two participants. The pair
// is canonicalized so the same two participants always map to one group regardless of argument order,
// preventing duplicate direct groups.
export interface CreateDirectGroupInput {
  workspaceID: string
  projectID?: string
  createdBy: string
  // The two participants of the direct group. Exactly one must be the creator; the other is the
  // counterparty (a user or an agent). Enforced in the repository.
  members: ReadonlyArray<{ memberID: string; memberType: MemberType }>
  // Optional display name; when omitted a deterministic name is derived from the pair.
  name?: string
}

export interface ListThreadInput {
  groupID: string
  // The parent message id whose replies (reply_to_id === replyToID) are listed.
  replyToID: string
  cursor?: string
  limit: number
}

export interface SearchMessagesInput {
  workspaceID: string
  userID: string
  query: string
  groupID?: string
  senderType?: SenderType
  type?: MessageType
  // §B3 metadata filter — a `metadata.type` discriminant to match via json_extract (e.g. "code_ref").
  metadataType?: string
  cursor?: string
  limit: number
}

export interface CreateAttachmentInput {
  id?: string
  workspaceID: string
  projectID?: string
  groupID?: string
  messageID?: string
  uploadedBy: string
  storagePath: string
  filename: string
  mime: string
  sizeBytes: number
  checksum: string
}

export interface ListAttachmentsInput {
  workspaceID: string
  groupID?: string
  messageID?: string
  limit: number
}

export interface LiveMentionContext {
  readonly names: readonly string[]
  readonly directory: string
  readonly workspaceID: string
  readonly userID: string
  readonly origin: "local" | "kernel_live"
  readonly receiverID?: string
  readonly conversationType?: number
  readonly conversationID?: string
}
export type IMMentionIntent = typeof IMMentionIntentTable.$inferSelect & { readonly message: IMMessage }
export const clientMessageID = (senderID: string, requestID: string) =>
  IMID.MessageID.make(`imsg_req_${contentDigest(stringify([senderID, requestID])).slice(0, 40)}`)

export interface CreateMessageInput {
  /** Trusted internal stable identity, e.g. one reply-outbox delivery. */
  id?: string
  clientRequestID?: string
  attachment?: { id: string; workspaceID: string }
  /** Server-only verified live provenance; never populated by history or HTTP payload metadata. */
  mentionIntent?: LiveMentionContext
  groupID: string
  senderID: string
  senderType: SenderType
  type: MessageType
  content: string
  mentions?: string[]
  metadata?: MessageMetadata
  replyToID?: string
  // IM-kernel (JuggleIM B1): set for inbound kernel messages at insert time (dedup identity) and
  // left unset for locally authored sends (written back on kernel ack via setMessageKernelMsgID).
  kernelMsgID?: string
  // Authoritative timestamp override — inbound kernel messages carry the kernel msgTime so local
  // pagination reflects sender-side ordering; omitted ⇒ insertion time (Date.now()).
  createdAt?: number
}

export interface BindKernelConversationInput {
  groupID: string
  // Kernel conversation key `k:<channel_type>:<id>`; pass null to unbind (B2 rebind flows).
  kernelConvID: string | null
}

export interface SetMessageKernelMsgIDInput {
  messageID: string
  kernelMsgID: string
}

export interface ListPendingKernelMessagesInput {
  limit: number
}

// A pending kernel send joined with its group's kernel conversation binding (the drain's work unit).
export interface IMPendingKernelMessage {
  readonly message: IMMessage
  readonly kernelConvID: string
}

export interface UpsertSyncCursorInput {
  conversationID: string
  lastSyncTime: number
  lastSyncSeq?: number
}

export interface ListGroupsInput {
  workspaceID: string
  userID: string
}

export interface GetGroupInput {
  groupID: string
  userID: string
}

export interface ListMessagesInput {
  groupID: string
  cursor?: string
  limit: number
}

export interface MarkReadInput {
  groupID: string
  memberID: string
  readAt: number
}

export interface ListAgentsInput {
  workspaceID: string
  userID: string
}

export interface AddMemberInput {
  groupID: string
  memberID: string
  memberType: MemberType
  role: MemberRole
}

export interface IMRepositoryInterface {
  readonly listGroups: (input: ListGroupsInput) => Effect.Effect<IMGroup[], IMRepositoryError, never>
  readonly ensureKernelGroup: (input: CreateGroupInput & { kernelConvID: string }) => Effect.Effect<IMGroup, IMRepositoryError>
  readonly createGroup: (input: CreateGroupInput) => Effect.Effect<IMGroup, IMRepositoryError, never>
  // §B3 私聊 — create-or-return the canonical direct group for a participant pair.
  readonly createDirectGroup: (input: CreateDirectGroupInput) => Effect.Effect<IMGroup, IMRepositoryError, never>
  readonly getGroup: (input: GetGroupInput) => Effect.Effect<IMGroup | undefined, IMRepositoryError, never>
  readonly addMember: (input: AddMemberInput) => Effect.Effect<void, IMRepositoryError, never>
  readonly listMessages: (input: ListMessagesInput) => Effect.Effect<MessagePage, IMRepositoryError, never>
  // §B3 Thread — replies to a parent message, ASC (created_at, id) keyset pagination.
  readonly listThread: (input: ListThreadInput) => Effect.Effect<MessagePage, IMRepositoryError, never>
  // §B3 搜索 — full-text + metadata search scoped to the caller's group memberships.
  readonly searchMessages: (input: SearchMessagesInput) => Effect.Effect<MessagePage, IMRepositoryError, never>
  readonly createMessage: (input: CreateMessageInput) => Effect.Effect<IMMessage & { readonly replayed?: boolean }, IMRepositoryError, never>
  readonly listPendingMentions: (input: { origin: LiveMentionContext["origin"]; receiverID?: string; limit?: number }) => Effect.Effect<readonly IMMentionIntent[], IMRepositoryError>
  readonly bindMention: (input: { id: string; agent: string; sessionID: string; inputID: string }) => Effect.Effect<IMMentionIntent | undefined, IMRepositoryError>
  readonly settleMention: (input: { id: string; status: "pending" | "admitted" | "rejected"; error?: string }) => Effect.Effect<void, IMRepositoryError>
  readonly getMessage: (messageID: string) => Effect.Effect<IMMessage | undefined, IMRepositoryError, never>
  readonly markRead: (input: MarkReadInput) => Effect.Effect<void, IMRepositoryError, never>
  // §B3 文件 — attachment records (decoupled from messages).
  readonly createAttachment: (input: CreateAttachmentInput) => Effect.Effect<IMAttachment, IMRepositoryError, never>
  readonly getAttachment: (attachmentID: string) => Effect.Effect<IMAttachment | undefined, IMRepositoryError, never>
  readonly listAttachments: (input: ListAttachmentsInput) => Effect.Effect<IMAttachment[], IMRepositoryError, never>
  readonly listExpiredAttachments: (workspaceID: string) => Effect.Effect<IMAttachment[], IMRepositoryError, never>
  /** Tombstone expired or unbound records only after the caller has removed their bytes. */
  readonly expireAttachment: (attachmentID: string) => Effect.Effect<void, IMRepositoryError, never>
  // IM-kernel (JuggleIM B1) — conversation binding + message dedup/ack + sync high-water marks.
  // getGroupByKernelConvID is an INTERNAL lookup (no membership check; the kernel sync engine owns
  // admission), unlike getGroup which enforces caller membership.
  readonly getGroupByKernelConvID: (kernelConvID: string) => Effect.Effect<IMGroup | undefined, IMRepositoryError, never>
  // INTERNAL plain group fetch (no membership check) — the kernel send path resolves a group's
  // kernel binding from a message's groupID without an acting user.
  readonly getGroupByID: (groupID: string) => Effect.Effect<IMGroup | undefined, IMRepositoryError, never>
  readonly bindKernelConversation: (input: BindKernelConversationInput) => Effect.Effect<void, IMRepositoryError, never>
  readonly getMessageByKernelMsgID: (kernelMsgID: string) => Effect.Effect<IMMessage | undefined, IMRepositoryError, never>
  // Write the kernel ack's message id onto a locally authored row. Returns false when the row is
  // gone (or already carries a different kernel id — the unique index refuses the update).
  readonly setMessageKernelMsgID: (input: SetMessageKernelMsgIDInput) => Effect.Effect<boolean, IMRepositoryError, never>
  // Locally authored text rows in kernel-bound groups still awaiting their kernel ack
  // (kernel_msg_id IS NULL), oldest first — the pending-send drain's worklist.
  readonly listPendingKernelMessages: (input: ListPendingKernelMessagesInput) => Effect.Effect<IMPendingKernelMessage[], IMRepositoryError, never>
  // All groups bound to a kernel conversation (internal: the kernel catch-up pass iterates these;
  // no membership check — the sync engine is process-global, not per-user).
  readonly listKernelBoundGroups: Effect.Effect<IMGroup[], IMRepositoryError, never>
  readonly getSyncCursor: (conversationID: string) => Effect.Effect<IMSyncCursor | undefined, IMRepositoryError, never>
  // Monotonic: lastSyncTime only ever advances (an out-of-order/late redelivery never regresses the
  // watermark the hismsgs catch-up pass stops at).
  readonly upsertSyncCursor: (input: UpsertSyncCursorInput) => Effect.Effect<void, IMRepositoryError, never>
  // Note: listAgents removed - use AgentListProviderService instead
}

// Repository service
export class IMRepository extends Context.Service<IMRepository, IMRepositoryInterface>()(
  "@deepagent-code/v2/IMRepository",
) {}

// Implementation
export const IMRepositoryLive = Layer.effect(
  IMRepository,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    // Feature-detect the FTS5 mirror table. Present ⇒ the FTS5 module was available at migration time and
    // triggers keep it synced; absent ⇒ this SQLite build lacks FTS5 and search uses the LIKE fallback.
    // Checked per search call (cheap sqlite_master lookup) so a build without FTS5 degrades gracefully.
    const ftsTableExists = db
      .get<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'im_messages_fts'`,
      )
      .pipe(
        Effect.map((row) => row !== undefined && row !== null),
        Effect.mapError(dbError("Database operation failed")),
      )

    return IMRepository.of({
      listGroups: (input) =>
        Effect.gen(function* () {
          const groups = yield* db
            .select({ group: GroupTable })
            .from(GroupTable)
            .innerJoin(
              MemberTable,
              and(
                eq(MemberTable.group_id, GroupTable.id),
                eq(MemberTable.member_id, input.userID),
                eq(MemberTable.member_type, "user"),
              ),
            )
            .where(
              and(
                eq(GroupTable.workspace_id, input.workspaceID),
                isNull(GroupTable.deleted_at),
              ),
            )
            .all()
            .pipe(Effect.mapError(dbError("Database operation failed")))

          return groups.map(({ group: g }) => ({
            id: g.id,
            workspaceID: g.workspace_id,
            projectID: g.project_id ?? null,
            type: g.type,
            name: g.name,
            createdBy: g.created_by,
            kernelConvID: g.kernel_conv_id ?? null,
            createdAt: g.created_at,
            updatedAt: g.updated_at,
            deletedAt: g.deleted_at ?? null,
          }))
        }),

      ensureKernelGroup: (input) =>
        db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const existing = yield* tx
                  .select()
                  .from(GroupTable)
                  .where(eq(GroupTable.kernel_conv_id, input.kernelConvID))
                  .get()
                if (existing?.deleted_at)
                  return yield* new IMRepositoryError({ message: "Kernel conversation was locally deleted" })
                const now = Date.now()
                const group =
                  existing ??
                  (yield* tx
                    .insert(GroupTable)
                    .values({
                      id: IMID.GroupID.create(),
                      workspace_id: input.workspaceID,
                      project_id: input.projectID ?? null,
                      type: input.type,
                      name: input.name,
                      created_by: input.createdBy,
                      kernel_conv_id: input.kernelConvID,
                      created_at: now,
                      updated_at: now,
                    })
                    .returning()
                    .get())
                if (!group) return yield* new IMRepositoryError({ message: "Kernel group insert returned no row" })
                for (const member of [
                  { memberID: input.createdBy, memberType: "user" as const, role: "owner" as const },
                  ...(input.members ?? []),
                ]) {
                  yield* tx
                    .insert(MemberTable)
                    .values({
                      group_id: group.id,
                      member_id: member.memberID,
                      member_type: member.memberType,
                      role: member.role ?? "member",
                      joined_at: now,
                    })
                    .onConflictDoNothing()
                }
                return {
                  id: group.id,
                  workspaceID: group.workspace_id,
                  projectID: group.project_id ?? null,
                  type: group.type,
                  name: group.name,
                  createdBy: group.created_by,
                  kernelConvID: group.kernel_conv_id ?? null,
                  createdAt: group.created_at,
                  updatedAt: group.updated_at,
                  deletedAt: group.deleted_at ?? null,
                }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.mapError(dbError("Kernel conversation mirror failed"))),

      createGroup: (input) =>
        Effect.gen(function* () {
          const id = IMID.GroupID.create()
          const now = Date.now()

          yield* db.insert(GroupTable).values({
            id,
            workspace_id: input.workspaceID,
            project_id: input.projectID ?? null,
            type: input.type,
            name: input.name,
            created_by: input.createdBy,
            created_at: now,
            updated_at: now,
            deleted_at: null,
          }).pipe(Effect.mapError(dbError("Database operation failed")))

          // Add creator as owner
          yield* db.insert(MemberTable).values({
            group_id: id,
            member_id: input.createdBy,
            member_type: "user",
            role: "owner",
            // Don't set last_read_at, let it be undefined (SQLite will store NULL)
            joined_at: now,
          }).pipe(Effect.mapError(dbError("Database operation failed")))

          // Seat any additional initial members (skip a duplicate of the creator). Each insert is
          // guarded by the members table's unique index; a caller-supplied duplicate would surface as a
          // db error, so we de-dupe the creator here defensively.
          for (const m of input.members ?? []) {
            if (m.memberID === input.createdBy && m.memberType === "user") continue
            yield* db.insert(MemberTable).values({
              group_id: id,
              member_id: m.memberID,
              member_type: m.memberType,
              role: m.role ?? "member",
              joined_at: now,
            }).pipe(Effect.mapError(dbError("Database operation failed")))
          }

          return {
            id,
            workspaceID: input.workspaceID,
            projectID: input.projectID ?? null,
            type: input.type,
            name: input.name,
            createdBy: input.createdBy,
            kernelConvID: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          }
        }),

      createDirectGroup: (input) =>
        Effect.gen(function* () {
          // §B3 constraint: a direct group has EXACTLY 2 members, either user+user or user+agent. Validate
          // the pair before touching the database.
          const members = input.members
          if (members.length !== 2) {
            return yield* new IMRepositoryError({
              message: "A direct group must have exactly 2 members",
            })
          }
          const [a, b] = members
          if (a.memberID === b.memberID && a.memberType === b.memberType) {
            return yield* new IMRepositoryError({
              message: "A direct group requires two distinct members",
            })
          }
          // At least one member must be a user (user+user or user+agent — never agent+agent).
          if (a.memberType !== "user" && b.memberType !== "user") {
            return yield* new IMRepositoryError({
              message: "A direct group must include at least one user member",
            })
          }
          // The creator must be one of the two participants (a user cannot open a private chat between
          // two other parties on their behalf).
          const creatorIsParticipant = members.some(
            (m) => m.memberID === input.createdBy && m.memberType === "user",
          )
          if (!creatorIsParticipant) {
            return yield* new IMRepositoryError({
              message: "The creator must be one of the direct group participants",
            })
          }

          // Uniqueness guard: canonicalize the pair to a deterministic key and look for an existing,
          // non-deleted direct group between the same two participants in this workspace. Reuse it if
          // present (idempotent open-chat semantics) rather than creating a duplicate.
          const canonical = members
            .map((m) => `${m.memberType}:${m.memberID}`)
            .sort()
            .join("|")

          const existing = yield* db
            .select({ group: GroupTable })
            .from(GroupTable)
            .where(
              and(
                eq(GroupTable.workspace_id, input.workspaceID),
                eq(GroupTable.type, "direct"),
                isNull(GroupTable.deleted_at),
              ),
            )
            .all()
            .pipe(Effect.mapError(dbError("Database operation failed")))

          for (const { group: g } of existing) {
            const rows = yield* db
              .select({ member_id: MemberTable.member_id, member_type: MemberTable.member_type })
              .from(MemberTable)
              .where(eq(MemberTable.group_id, g.id))
              .all()
              .pipe(Effect.mapError(dbError("Database operation failed")))
            const key = rows
              .map((r) => `${r.member_type}:${r.member_id}`)
              .sort()
              .join("|")
            if (key === canonical) {
              return {
                id: g.id,
                workspaceID: g.workspace_id,
                projectID: g.project_id ?? null,
                type: g.type,
                name: g.name,
                createdBy: g.created_by,
                kernelConvID: g.kernel_conv_id ?? null,
                createdAt: g.created_at,
                updatedAt: g.updated_at,
                deletedAt: g.deleted_at ?? null,
              }
            }
          }

          // No existing pair — create it. The creator is seated as owner; the counterparty as member.
          const id = IMID.GroupID.create()
          const now = Date.now()
          const name = input.name ?? `direct:${canonical}`

          yield* db.insert(GroupTable).values({
            id,
            workspace_id: input.workspaceID,
            project_id: input.projectID ?? null,
            type: "direct",
            name,
            created_by: input.createdBy,
            created_at: now,
            updated_at: now,
            deleted_at: null,
          }).pipe(Effect.mapError(dbError("Database operation failed")))

          for (const m of members) {
            const isCreator = m.memberID === input.createdBy && m.memberType === "user"
            yield* db.insert(MemberTable).values({
              group_id: id,
              member_id: m.memberID,
              member_type: m.memberType,
              role: isCreator ? "owner" : m.memberType === "agent" ? "agent" : "member",
              joined_at: now,
            }).pipe(Effect.mapError(dbError("Database operation failed")))
          }

          return {
            id,
            workspaceID: input.workspaceID,
            projectID: input.projectID ?? null,
            type: "direct",
            name,
            createdBy: input.createdBy,
            kernelConvID: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          }
        }),

      getGroup: (input) =>
        Effect.gen(function* () {
          const group = yield* db
            .select()
            .from(GroupTable)
            .where(and(eq(GroupTable.id, input.groupID as IMID.GroupID), isNull(GroupTable.deleted_at)))
            .get()
            .pipe(Effect.mapError(dbError("Database operation failed")))

          if (!group) return undefined

          // Verify user is a member of the group
          const member = yield* db
            .select()
            .from(MemberTable)
            .where(
              and(
                eq(MemberTable.group_id, input.groupID as IMID.GroupID),
                eq(MemberTable.member_id, input.userID),
              ),
            )
            .get()
            .pipe(Effect.mapError(dbError("Database operation failed")))

          if (!member) return undefined // User is not a member, deny access

          return {
            id: group.id,
            workspaceID: group.workspace_id,
            projectID: group.project_id ?? null,
            type: group.type,
            name: group.name,
            createdBy: group.created_by,
            kernelConvID: group.kernel_conv_id ?? null,
            createdAt: group.created_at,
            updatedAt: group.updated_at,
            deletedAt: group.deleted_at ?? null,
          }
        }),

      addMember: (input) =>
        Effect.gen(function* () {
          const now = Date.now()
          yield* db.insert(MemberTable).values({
            group_id: input.groupID as IMID.GroupID,
            member_id: input.memberID,
            member_type: input.memberType,
            role: input.role,
            // Don't set last_read_at, let it be undefined
            joined_at: now,
          }).pipe(Effect.mapError(dbError("Database operation failed")))
        }),

      listMessages: (input) =>
        Effect.gen(function* () {
          const limit = input.limit + 1

          const cursor = parseCompositeCursor(input.cursor)
          const cursorTimestamp = input.cursor && !cursor ? Number(input.cursor) : undefined

          // Build the full WHERE clause in a single .where() call. Drizzle's
          // .where() REPLACES any previous clause rather than merging, so the
          // cursor condition must be combined with the group/soft-delete filters
          // here — otherwise pagination would leak messages across groups and
          // return soft-deleted rows.
          const whereClause = and(
            eq(MessageTable.group_id, input.groupID as IMID.GroupID),
            isNull(MessageTable.deleted_at),
            cursor ? or(lt(MessageTable.created_at, cursor.createdAt), and(eq(MessageTable.created_at, cursor.createdAt), lt(MessageTable.id, cursor.id as IMID.MessageID)))
              : cursorTimestamp !== undefined && Number.isFinite(cursorTimestamp) ? lt(MessageTable.created_at, cursorTimestamp) : undefined,
          )

          const messages = yield* db
            .select()
            .from(MessageTable)
            .where(whereClause)
            .orderBy(desc(MessageTable.created_at), desc(MessageTable.id))
            .limit(limit)
            .all()
            .pipe(Effect.mapError(dbError("Database operation failed")))

          const hasMore = messages.length > input.limit
          const resultMessages = hasMore ? messages.slice(0, input.limit) : messages

          return {
            messages: resultMessages.map((m) => ({
              id: m.id,
              groupID: m.group_id,
              senderID: m.sender_id,
              senderType: m.sender_type,
              type: m.type,
              content: m.content,
              mentions: m.mentions ?? null,
              metadata: m.metadata ?? null,
              replyToID: m.reply_to_id ?? null,
              kernelMsgID: m.kernel_msg_id ?? null,
              createdAt: m.created_at,
              updatedAt: m.updated_at,
              deletedAt: m.deleted_at ?? null,
            })),
            nextCursor: hasMore ? encodeCompositeCursor(resultMessages[resultMessages.length - 1].created_at, resultMessages[resultMessages.length - 1].id) : null,
            hasMore,
          }
        }),

      listThread: (input) =>
        Effect.gen(function* () {
          const limit = input.limit + 1
          const cursor = parseCompositeCursor(input.cursor)

          // Thread = messages whose reply_to_id points at the parent, scoped to the group and excluding
          // soft-deleted rows. ORDER BY (created_at ASC, id ASC) gives a stable chronological thread; the
          // composite keyset advances past the last (created_at, id) seen. Uses idx_im_messages_thread
          // (group_id, reply_to_id, created_at).
          const whereClause = and(
            eq(MessageTable.group_id, input.groupID as IMID.GroupID),
            eq(MessageTable.reply_to_id, input.replyToID as IMID.MessageID),
            isNull(MessageTable.deleted_at),
            cursor !== undefined
              ? or(
                  gt(MessageTable.created_at, cursor.createdAt),
                  and(eq(MessageTable.created_at, cursor.createdAt), gt(MessageTable.id, cursor.id as IMID.MessageID)),
                )
              : undefined,
          )

          const messages = yield* db
            .select()
            .from(MessageTable)
            .where(whereClause)
            .orderBy(asc(MessageTable.created_at), asc(MessageTable.id))
            .limit(limit)
            .all()
            .pipe(Effect.mapError(dbError("Database operation failed")))

          const hasMore = messages.length > input.limit
          const resultMessages = hasMore ? messages.slice(0, input.limit) : messages
          const last = resultMessages[resultMessages.length - 1]

          return {
            messages: resultMessages.map(mapMessageRow),
            nextCursor: hasMore && last ? encodeCompositeCursor(last.created_at, last.id) : null,
            hasMore,
          }
        }),

      searchMessages: (input) =>
        Effect.gen(function* () {
          const limit = input.limit + 1
          const cursor = parseCompositeCursor(input.cursor)

          // Permission scoping (the main risk): a user may only search groups they belong to. The
          // membership join (member_id = userID, member_type = "user") is what enforces this — a message
          // in a group the caller isn't a member of is never joined, so it can never surface. This holds
          // for BOTH the FTS and the LIKE-fallback path.
          const membershipJoin = and(
            eq(MemberTable.group_id, MessageTable.group_id),
            eq(MemberTable.member_id, input.userID),
            eq(MemberTable.member_type, "user"),
          )

          // Column / metadata filters. Workspace scoping is via the GroupTable join (im_messages has no
          // workspace_id column — it lives on the group).
          const filters = [
            eq(GroupTable.workspace_id, input.workspaceID),
            isNull(MessageTable.deleted_at),
            isNull(GroupTable.deleted_at),
            input.groupID ? eq(MessageTable.group_id, input.groupID as IMID.GroupID) : undefined,
            input.senderType ? eq(MessageTable.sender_type, input.senderType) : undefined,
            input.type ? eq(MessageTable.type, input.type) : undefined,
            input.metadataType
              ? sql`json_extract(${MessageTable.metadata}, '$.type') = ${input.metadataType}`
              : undefined,
            cursor !== undefined
              ? or(
                  gt(MessageTable.created_at, cursor.createdAt),
                  and(eq(MessageTable.created_at, cursor.createdAt), gt(MessageTable.id, cursor.id as IMID.MessageID)),
                )
              : undefined,
          ]

          // Feature-detect FTS5: the fts table only exists when the module was available at migration
          // time. When absent (or empty for other reasons) fall back to a LIKE scan on content.
          const ftsAvailable = yield* ftsTableExists

          const rows = ftsAvailable
            ? yield* db
                .select({ message: MessageTable })
                .from(MessageTable)
                .innerJoin(MemberTable, membershipJoin)
                .innerJoin(GroupTable, eq(GroupTable.id, MessageTable.group_id))
                .innerJoin(
                  sql`im_messages_fts`,
                  sql`im_messages_fts.msg_id = ${MessageTable.id} AND im_messages_fts.content MATCH ${toFtsMatchQuery(input.query)}`,
                )
                .where(and(...filters))
                .orderBy(asc(MessageTable.created_at), asc(MessageTable.id))
                .limit(limit)
                .all()
                .pipe(Effect.mapError(dbError("Database operation failed")))
            : yield* db
                .select({ message: MessageTable })
                .from(MessageTable)
                .innerJoin(MemberTable, membershipJoin)
                .innerJoin(GroupTable, eq(GroupTable.id, MessageTable.group_id))
                .where(and(like(MessageTable.content, `%${escapeLike(input.query)}%`), ...filters))
                .orderBy(asc(MessageTable.created_at), asc(MessageTable.id))
                .limit(limit)
                .all()
                .pipe(Effect.mapError(dbError("Database operation failed")))

          const hasMore = rows.length > input.limit
          const resultRows = hasMore ? rows.slice(0, input.limit) : rows
          const last = resultRows[resultRows.length - 1]?.message

          return {
            messages: resultRows.map((r) => mapMessageRow(r.message)),
            nextCursor: hasMore && last ? encodeCompositeCursor(last.created_at, last.id) : null,
            hasMore,
          }
        }),

      createMessage: (input) =>
        db.transaction((tx) => Effect.gen(function* () {
          const id = input.clientRequestID ? clientMessageID(input.senderID, input.clientRequestID)
            : input.id ? IMID.MessageID.make(input.id)
            : input.kernelMsgID ? IMID.MessageID.make(`imsg_kernel_${contentDigest(input.kernelMsgID).slice(0, 40)}`)
            : IMID.MessageID.create()
          const now = Date.now()
          if (input.attachment) {
            const attachment = yield* tx
              .select()
              .from(AttachmentTable)
              .where(
                and(
                  eq(AttachmentTable.id, IMID.AttachmentID.make(input.attachment.id)),
                  eq(AttachmentTable.workspace_id, input.attachment.workspaceID),
                  eq(AttachmentTable.group_id, IMID.GroupID.make(input.groupID)),
                  eq(AttachmentTable.uploaded_by, input.senderID),
                  isNull(AttachmentTable.deleted_at),
                ),
              )
              .get()
            const group = yield* tx
              .select({ id: GroupTable.id })
              .from(GroupTable)
              .innerJoin(
                MemberTable,
                and(
                  eq(MemberTable.group_id, GroupTable.id),
                  eq(MemberTable.member_id, input.senderID),
                  eq(MemberTable.member_type, "user"),
                ),
              )
              .where(
                and(
                  eq(GroupTable.id, IMID.GroupID.make(input.groupID)),
                  eq(GroupTable.workspace_id, input.attachment.workspaceID),
                  isNull(GroupTable.kernel_conv_id),
                  isNull(GroupTable.deleted_at),
                ),
              )
              .get()
            if (
              !attachment ||
              !group ||
              AttachmentStorage.expiresAt(attachment.created_at) <= now ||
              (attachment.message_id !== null && attachment.message_id !== id) ||
              input.type !== "file" ||
              input.metadata?.type !== "attachment_ref" ||
              input.metadata.attachmentID !== attachment.id
            )
              return yield* new IMRepositoryError({
                code: "attachment_unavailable",
                message: "Attachment is unavailable for this message",
              })
            yield* tx.update(AttachmentTable).set({ message_id: id }).where(eq(AttachmentTable.id, attachment.id)).run()
          }
          const mentions = input.mentions ? Array.from(new Set(input.mentions)).sort() : null
          const inserted = yield* tx.insert(MessageTable).values({
            id,
            group_id: input.groupID as IMID.GroupID,
            sender_id: input.senderID,
            sender_type: input.senderType,
            type: input.type,
            content: input.content,
            mentions,
            metadata: input.metadata ?? null,
            reply_to_id: (input.replyToID as IMID.MessageID | undefined) ?? null,
            kernel_msg_id: input.kernelMsgID ?? null,
            client_request_id: input.clientRequestID ?? null,
            created_at: input.createdAt ?? now,
            updated_at: now,
            deleted_at: null,
          }).onConflictDoNothing().returning().get()
          const row = inserted ?? (yield* tx.select().from(MessageTable).where(eq(MessageTable.id, id)).get())
          if (!row || row.deleted_at !== null || stringify([
            row.group_id, row.sender_id, row.sender_type, row.type, row.content, row.mentions, row.metadata, row.reply_to_id,
          ]) !== stringify([
            input.groupID, input.senderID, input.senderType, input.type, input.content, mentions, input.metadata ?? null, input.replyToID ?? null,
          ])) return yield* new IMRepositoryError({ code: "message_identity_conflict", message: "Message request identity was already used with a different payload" })
          // A local retry cannot retroactively authorize chat sent with the responder off.
          // Kernel live proof may still reconcile an earlier history-only observation.
          if (input.mentionIntent && (inserted || input.mentionIntent.origin === "kernel_live")) {
            const intent = input.mentionIntent
            for (const name of Array.from(new Set(intent.names.map((name) => name.toLowerCase())))) {
              yield* tx.insert(IMMentionIntentTable).values({
                id: `imi_${contentDigest(stringify([id, name])).slice(0, 40)}`,
                message_id: id,
                agent_name: name,
                directory: intent.directory,
                workspace_id: intent.workspaceID,
                user_id: intent.userID,
                origin: intent.origin,
                receiver_id: intent.receiverID ?? null,
                conversation_type: intent.conversationType ?? null,
                conversation_id: intent.conversationID ?? null,
                status: "pending",
                created_at: now,
                updated_at: now,
              }).onConflictDoNothing().run()
            }
          }
          return { ...mapMessageRow(row), replayed: inserted === undefined }
        })).pipe(Effect.mapError((cause) => cause instanceof IMRepositoryError ? cause : dbError("Database operation failed")(cause))),

      listPendingMentions: (input) => db.select({ intent: IMMentionIntentTable, message: MessageTable })
        .from(IMMentionIntentTable)
        .innerJoin(MessageTable, eq(MessageTable.id, IMMentionIntentTable.message_id))
        .where(and(
          eq(IMMentionIntentTable.status, "pending"), eq(IMMentionIntentTable.origin, input.origin),
          ...(input.receiverID ? [eq(IMMentionIntentTable.receiver_id, input.receiverID)] : []),
          isNull(MessageTable.deleted_at),
        ))
        .orderBy(asc(IMMentionIntentTable.updated_at), asc(IMMentionIntentTable.id))
        .limit(input.limit ?? 64).all()
        .pipe(Effect.map((rows) => rows.map((row) => ({ ...row.intent, message: mapMessageRow(row.message) }))), Effect.mapError(dbError("Mention intent lookup failed"))),

      bindMention: (input) => db.transaction((tx) => Effect.gen(function* () {
        yield* tx.update(IMMentionIntentTable).set({ resolved_agent: input.agent, session_id: input.sessionID, input_id: input.inputID, updated_at: Date.now() })
          .where(and(eq(IMMentionIntentTable.id, input.id), eq(IMMentionIntentTable.status, "pending"), isNull(IMMentionIntentTable.resolved_agent))).run()
        const row = yield* tx.select({ intent: IMMentionIntentTable, message: MessageTable }).from(IMMentionIntentTable)
          .innerJoin(MessageTable, eq(MessageTable.id, IMMentionIntentTable.message_id))
          .where(eq(IMMentionIntentTable.id, input.id)).get()
        if (!row || row.intent.status !== "pending") return
        if (row.intent.resolved_agent !== input.agent || row.intent.session_id !== input.sessionID || row.intent.input_id !== input.inputID)
          return yield* new IMRepositoryError({ message: "Mention target changed after durable binding" })
        return { ...row.intent, message: mapMessageRow(row.message) }
      })).pipe(Effect.mapError((cause) => cause instanceof IMRepositoryError ? cause : dbError("Mention binding failed")(cause))),

      settleMention: (input) => db.update(IMMentionIntentTable)
        .set({ status: input.status, last_error: input.error ?? null, updated_at: Date.now() })
        .where(and(eq(IMMentionIntentTable.id, input.id), eq(IMMentionIntentTable.status, "pending"))).run()
        .pipe(Effect.asVoid, Effect.mapError(dbError("Mention settlement failed"))),

      getMessage: (messageID) =>
        Effect.gen(function* () {
          const message = yield* db
            .select()
            .from(MessageTable)
            .where(and(eq(MessageTable.id, messageID as IMID.MessageID), isNull(MessageTable.deleted_at)))
            .get()
            .pipe(Effect.mapError(dbError("Database operation failed")))

          if (!message) return undefined

          return {
            id: message.id,
            groupID: message.group_id,
            senderID: message.sender_id,
            senderType: message.sender_type,
            type: message.type,
            content: message.content,
            mentions: message.mentions ?? null,
            metadata: message.metadata ?? null,
            replyToID: message.reply_to_id ?? null,
            kernelMsgID: message.kernel_msg_id ?? null,
            createdAt: message.created_at,
            updatedAt: message.updated_at,
            deletedAt: message.deleted_at ?? null,
          }
        }),

      markRead: (input) =>
        Effect.gen(function* () {
          yield* db
            .update(MemberTable)
            .set({ last_read_at: input.readAt })
            .where(
              and(
                eq(MemberTable.group_id, input.groupID as IMID.GroupID),
                eq(MemberTable.member_id, input.memberID),
              ),
            )
            .pipe(Effect.mapError(dbError("Database operation failed")))
        }),

      createAttachment: (input) =>
        Effect.gen(function* () {
          const id = input.id ? IMID.AttachmentID.make(input.id) : IMID.AttachmentID.create()
          const now = Date.now()

          yield* db.insert(AttachmentTable).values({
            id,
            workspace_id: input.workspaceID,
            project_id: input.projectID ?? null,
            group_id: (input.groupID as IMID.GroupID | undefined) ?? null,
            message_id: (input.messageID as IMID.MessageID | undefined) ?? null,
            uploaded_by: input.uploadedBy,
            storage_path: input.storagePath,
            filename: input.filename,
            mime: input.mime,
            size_bytes: input.sizeBytes,
            checksum: input.checksum,
            created_at: now,
            deleted_at: null,
          }).pipe(Effect.mapError(dbError("Database operation failed")))

          return {
            id,
            workspaceID: input.workspaceID,
            projectID: input.projectID ?? null,
            groupID: input.groupID ?? null,
            messageID: input.messageID ?? null,
            uploadedBy: input.uploadedBy,
            storagePath: input.storagePath,
            filename: input.filename,
            mime: input.mime,
            sizeBytes: input.sizeBytes,
            checksum: input.checksum,
            createdAt: now,
            deletedAt: null,
          }
        }),

      getAttachment: (attachmentID) =>
        Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(AttachmentTable)
            .where(
              and(
                eq(AttachmentTable.id, attachmentID as IMID.AttachmentID),
                isNull(AttachmentTable.deleted_at),
              ),
            )
            .get()
            .pipe(Effect.mapError(dbError("Database operation failed")))

          if (!row) return undefined
          return mapAttachmentRow(row)
        }),

      listAttachments: (input) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(AttachmentTable)
            .where(
              and(
                eq(AttachmentTable.workspace_id, input.workspaceID),
                isNull(AttachmentTable.deleted_at),
                input.groupID ? eq(AttachmentTable.group_id, input.groupID as IMID.GroupID) : undefined,
                input.messageID ? eq(AttachmentTable.message_id, input.messageID as IMID.MessageID) : undefined,
              ),
            )
            .orderBy(desc(AttachmentTable.created_at))
            .limit(input.limit)
            .all()
            .pipe(Effect.mapError(dbError("Database operation failed")))

          return rows.map(mapAttachmentRow)
        }),

      listExpiredAttachments: (workspaceID) =>
        db
          .select()
          .from(AttachmentTable)
          .where(
            and(
              eq(AttachmentTable.workspace_id, workspaceID),
              isNull(AttachmentTable.deleted_at),
              lt(AttachmentTable.created_at, Date.now() - AttachmentStorage.ttlMs()),
            ),
          )
          .limit(32)
          .all()
          .pipe(
            Effect.map((rows) => rows.map(mapAttachmentRow)),
            Effect.mapError(dbError("Attachment cleanup lookup failed")),
          ),

      expireAttachment: (attachmentID) =>
        db
          .update(AttachmentTable)
          .set({ deleted_at: Date.now() })
          .where(
            and(
              eq(AttachmentTable.id, IMID.AttachmentID.make(attachmentID)),
              // Failed, unbound uploads may be tombstoned after the caller removes partial bytes.
              or(
                isNull(AttachmentTable.message_id),
                lt(AttachmentTable.created_at, Date.now() - AttachmentStorage.ttlMs()),
              ),
            ),
          )
          .run()
          .pipe(Effect.asVoid, Effect.mapError(dbError("Attachment expiration failed"))),

      getGroupByKernelConvID: (kernelConvID) =>
        Effect.gen(function* () {
          const group = yield* db
            .select()
            .from(GroupTable)
            .where(and(eq(GroupTable.kernel_conv_id, kernelConvID), isNull(GroupTable.deleted_at)))
            .get()
            .pipe(Effect.mapError(dbError("Database operation failed")))

          if (!group) return undefined
          return {
            id: group.id,
            workspaceID: group.workspace_id,
            projectID: group.project_id ?? null,
            type: group.type,
            name: group.name,
            createdBy: group.created_by,
            kernelConvID: group.kernel_conv_id ?? null,
            createdAt: group.created_at,
            updatedAt: group.updated_at,
            deletedAt: group.deleted_at ?? null,
          }
        }),

      bindKernelConversation: (input) =>
        Effect.gen(function* () {
          yield* db
            .update(GroupTable)
            .set({ kernel_conv_id: input.kernelConvID })
            .where(and(eq(GroupTable.id, input.groupID as IMID.GroupID), isNull(GroupTable.deleted_at)))
            .pipe(Effect.mapError(dbError("Database operation failed")))
        }),

      getGroupByID: (groupID) =>
        Effect.gen(function* () {
          const group = yield* db
            .select()
            .from(GroupTable)
            .where(and(eq(GroupTable.id, groupID as IMID.GroupID), isNull(GroupTable.deleted_at)))
            .get()
            .pipe(Effect.mapError(dbError("Database operation failed")))

          if (!group) return undefined
          return {
            id: group.id,
            workspaceID: group.workspace_id,
            projectID: group.project_id ?? null,
            type: group.type,
            name: group.name,
            createdBy: group.created_by,
            kernelConvID: group.kernel_conv_id ?? null,
            createdAt: group.created_at,
            updatedAt: group.updated_at,
            deletedAt: group.deleted_at ?? null,
          }
        }),

      getMessageByKernelMsgID: (kernelMsgID) =>
        Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(MessageTable)
            .where(and(eq(MessageTable.kernel_msg_id, kernelMsgID), isNull(MessageTable.deleted_at)))
            .get()
            .pipe(Effect.mapError(dbError("Database operation failed")))
          return row ? mapMessageRow(row) : undefined
        }),

      setMessageKernelMsgID: (input) =>
        Effect.gen(function* () {
          // Only fill a still-NULL kernel id: overwriting an acked row (or a row the inbound
          // dedup already wrote) would break the at-least-once identity, and the unique index is
          // the backstop if two writers race the same kernel id.
          const updated = yield* db
            .update(MessageTable)
            .set({ kernel_msg_id: input.kernelMsgID })
            .where(and(eq(MessageTable.id, input.messageID as IMID.MessageID), isNull(MessageTable.kernel_msg_id)))
            .returning({ id: MessageTable.id })
            .get()
            .pipe(Effect.mapError(dbError("Database operation failed")))
          return updated !== undefined
        }),

      listPendingKernelMessages: (input) =>
        Effect.gen(function* () {
          // Pending = locally authored, never-acked text/agent rows in a kernel-bound group. System
          // rows and non-text types stay local in B1 (the kernel path is text-only).
          const rows = yield* db
            .select({ message: MessageTable, kernel_conv_id: GroupTable.kernel_conv_id })
            .from(MessageTable)
            .innerJoin(
              GroupTable,
              and(eq(GroupTable.id, MessageTable.group_id), isNotNull(GroupTable.kernel_conv_id)),
            )
            .where(
              and(
                isNull(MessageTable.kernel_msg_id),
                isNull(MessageTable.deleted_at),
                isNull(GroupTable.deleted_at),
                eq(MessageTable.type, "text"),
                or(eq(MessageTable.sender_type, "user"), eq(MessageTable.sender_type, "agent")),
              ),
            )
            .orderBy(asc(MessageTable.created_at), asc(MessageTable.id))
            .limit(input.limit)
            .all()
            .pipe(Effect.mapError(dbError("Database operation failed")))
          return rows.flatMap((row) =>
            row.kernel_conv_id === null ? [] : [{ message: mapMessageRow(row.message), kernelConvID: row.kernel_conv_id }],
          )
        }),

      listKernelBoundGroups:
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(GroupTable)
            .where(and(isNotNull(GroupTable.kernel_conv_id), isNull(GroupTable.deleted_at)))
            .all()
            .pipe(Effect.mapError(dbError("Database operation failed")))
          return rows.map((group) => ({
            id: group.id,
            workspaceID: group.workspace_id,
            projectID: group.project_id ?? null,
            type: group.type,
            name: group.name,
            createdBy: group.created_by,
            kernelConvID: group.kernel_conv_id ?? null,
            createdAt: group.created_at,
            updatedAt: group.updated_at,
            deletedAt: group.deleted_at ?? null,
          }))
        }),

      getSyncCursor: (conversationID) =>
        Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SyncCursorTable)
            .where(eq(SyncCursorTable.conversation_id, conversationID))
            .get()
            .pipe(Effect.mapError(dbError("Database operation failed")))
          if (!row) return undefined
          return {
            conversationID: row.conversation_id,
            lastSyncTime: row.last_sync_time,
            lastSyncSeq: row.last_sync_seq ?? null,
            updatedAt: row.updated_at,
          }
        }),

      upsertSyncCursor: (input) =>
        Effect.gen(function* () {
          const now = Date.now()
          yield* db
            .insert(SyncCursorTable)
            .values({
              conversation_id: input.conversationID,
              last_sync_time: input.lastSyncTime,
              last_sync_seq: input.lastSyncSeq ?? null,
              updated_at: now,
            })
            .onConflictDoUpdate({
              target: SyncCursorTable.conversation_id,
              set: {
                last_sync_time: sql`max(${SyncCursorTable.last_sync_time}, ${input.lastSyncTime})`,
                last_sync_seq: sql`coalesce(${input.lastSyncSeq ?? null}, ${SyncCursorTable.last_sync_seq})`,
                updated_at: now,
              },
            })
            .pipe(Effect.mapError(dbError("Database operation failed")))
        }),
    })
  }),
)

// Map an im_attachments row (snake_case) to the camelCase IMAttachment domain model.
const mapAttachmentRow = (a: {
  id: string
  workspace_id: string
  project_id: string | null
  group_id: string | null
  message_id: string | null
  uploaded_by: string
  storage_path: string
  filename: string
  mime: string
  size_bytes: number
  checksum: string
  created_at: number
  deleted_at: number | null
}): IMAttachment => ({
  id: a.id,
  workspaceID: a.workspace_id,
  projectID: a.project_id ?? null,
  groupID: a.group_id ?? null,
  messageID: a.message_id ?? null,
  uploadedBy: a.uploaded_by,
  storagePath: a.storage_path,
  filename: a.filename,
  mime: a.mime,
  sizeBytes: a.size_bytes,
  checksum: a.checksum,
  createdAt: a.created_at,
  deletedAt: a.deleted_at ?? null,
})
