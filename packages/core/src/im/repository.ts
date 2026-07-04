import { Context, Effect, Layer, Schema } from "effect"
import { and, desc, eq, isNull, lt } from "drizzle-orm"
import { Database } from "../database/database"
import * as IMID from "./id"
import { GroupTable, MemberTable, MessageTable, GroupType, MemberType, MemberRole, SenderType, MessageType, MessageMetadata } from "./sql"

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

export const AgentDescriptor = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  description: Schema.optional(Schema.String),
  visible: Schema.Boolean,
})
export type AgentDescriptor = typeof AgentDescriptor.Type

// Input types
export interface CreateGroupInput {
  workspaceID: string
  projectID?: string
  type: GroupType
  name: string
  createdBy: string
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
  readonly getGroup: (input: GetGroupInput) => Effect.Effect<IMGroup | undefined, IMRepositoryError, never>
  readonly addMember: (input: AddMemberInput) => Effect.Effect<void, IMRepositoryError, never>
  readonly listMessages: (input: ListMessagesInput) => Effect.Effect<MessagePage, IMRepositoryError, never>
  readonly createMessage: (input: CreateMessageInput) => Effect.Effect<IMMessage, IMRepositoryError, never>
  readonly getMessage: (messageID: string) => Effect.Effect<IMMessage | undefined, IMRepositoryError, never>
  readonly markRead: (input: MarkReadInput) => Effect.Effect<void, IMRepositoryError, never>
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
    })
  }),
)
