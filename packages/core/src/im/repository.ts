import { Context, Effect, Layer, Schema } from "effect"
import { and, asc, desc, eq, gt, isNull, like, lt, or, sql } from "drizzle-orm"
import { Database } from "../database/database"
import * as IMID from "./id"
import { AttachmentTable, GroupTable, MemberTable, MessageTable, GroupType, MemberType, MemberRole, SenderType, MessageType, MessageMetadata } from "./sql"

// Repository errors
export class IMRepositoryError extends Schema.ErrorClass<IMRepositoryError>("IMRepositoryError")({
  message: Schema.String,
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

export interface CreateMessageInput {
  groupID: string
  senderID: string
  senderType: SenderType
  type: MessageType
  content: string
  mentions?: string[]
  metadata?: MessageMetadata
  replyToID?: string
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
  readonly createMessage: (input: CreateMessageInput) => Effect.Effect<IMMessage, IMRepositoryError, never>
  readonly getMessage: (messageID: string) => Effect.Effect<IMMessage | undefined, IMRepositoryError, never>
  readonly markRead: (input: MarkReadInput) => Effect.Effect<void, IMRepositoryError, never>
  // §B3 文件 — attachment records (decoupled from messages).
  readonly createAttachment: (input: CreateAttachmentInput) => Effect.Effect<IMAttachment, IMRepositoryError, never>
  readonly getAttachment: (attachmentID: string) => Effect.Effect<IMAttachment | undefined, IMRepositoryError, never>
  readonly listAttachments: (input: ListAttachmentsInput) => Effect.Effect<IMAttachment[], IMRepositoryError, never>
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
            createdAt: g.created_at,
            updatedAt: g.updated_at,
            deletedAt: g.deleted_at ?? null,
          }))
        }),

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

          // Validate and parse cursor to prevent SQL injection
          let cursorTimestamp: number | undefined
          if (input.cursor) {
            const parsed = parseInt(input.cursor, 10)
            if (isNaN(parsed) || parsed < 0) {
              // Invalid cursor, ignore it and return from the beginning
              cursorTimestamp = undefined
            } else {
              cursorTimestamp = parsed
            }
          }

          // Build the full WHERE clause in a single .where() call. Drizzle's
          // .where() REPLACES any previous clause rather than merging, so the
          // cursor condition must be combined with the group/soft-delete filters
          // here — otherwise pagination would leak messages across groups and
          // return soft-deleted rows.
          const whereClause = and(
            eq(MessageTable.group_id, input.groupID as IMID.GroupID),
            isNull(MessageTable.deleted_at),
            cursorTimestamp !== undefined ? lt(MessageTable.created_at, cursorTimestamp) : undefined,
          )

          const messages = yield* db
            .select()
            .from(MessageTable)
            .where(whereClause)
            .orderBy(desc(MessageTable.created_at))
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
              createdAt: m.created_at,
              updatedAt: m.updated_at,
              deletedAt: m.deleted_at ?? null,
            })),
            nextCursor: hasMore ? resultMessages[resultMessages.length - 1].created_at.toString() : null,
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
                  sql`im_messages_fts.msg_id = ${MessageTable.id} AND im_messages_fts.content MATCH ${input.query}`,
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
        Effect.gen(function* () {
          const id = IMID.MessageID.create()
          const now = Date.now()

          // Deduplicate mentions
          const mentions = input.mentions ? Array.from(new Set(input.mentions)) : null

          yield* db.insert(MessageTable).values({
            id,
            group_id: input.groupID as IMID.GroupID,
            sender_id: input.senderID,
            sender_type: input.senderType,
            type: input.type,
            content: input.content,
            mentions,
            metadata: input.metadata ?? null,
            reply_to_id: (input.replyToID as IMID.MessageID | undefined) ?? null,
            created_at: now,
            updated_at: now,
            deleted_at: null,
          }).pipe(Effect.mapError(dbError("Database operation failed")))

          return {
            id,
            groupID: input.groupID,
            senderID: input.senderID,
            senderType: input.senderType,
            type: input.type,
            content: input.content,
            mentions,
            metadata: input.metadata ?? null,
            replyToID: input.replyToID ?? null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          }
        }),

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
          const id = IMID.AttachmentID.create()
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
