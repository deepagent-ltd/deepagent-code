import { Cause, Effect, Scope } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import nodeFs from "node:fs/promises"
import { Global } from "@deepagent-code/core/global"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { IMRepository, IMRepositoryError } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { InstanceHttpApi } from "../api"
import {
  IMGroupNotFoundError,
  IMMessageNotFoundError,
  IMMessageTooLargeError,
  IMRateLimitExceededError,
  IMValidationFailedError,
  IMInternalServerError,
  IMFileUploadDisabledError,
  IMFileTooLargeError,
  IMUnsupportedMediaTypeError,
} from "../groups/im"
import { MentionParser } from "@deepagent-code/core/im/mention-parser"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { executeAgentMentions } from "@deepagent-code/core/im/agent-orchestrator"
import type { IMMessage, IMAttachment } from "@deepagent-code/core/im/repository"
import * as IMID from "@deepagent-code/core/im/id"
import { getWorkspaceContext } from "../utils/workspace-context"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"

const IMAttachmentID = IMID.AttachmentID

const IM_MAX_MESSAGE_LENGTH = 100000 // 增加到 100k，更灵活

// Pagination limit clamp: default 50, hard ceiling 100 (matches listMessages' effective default and
// prevents an unbounded page from a hostile `limit`).
const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return 50
  return Math.min(Math.floor(limit), 100)
}

const toMessageResponse = (m: IMMessage) => ({
  id: m.id,
  groupID: m.groupID,
  senderID: m.senderID,
  senderType: m.senderType,
  type: m.type,
  content: m.content,
  mentions: m.mentions,
  metadata: m.metadata,
  replyToID: m.replyToID,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
})

const toAttachmentResponse = (a: IMAttachment) => ({
  id: a.id,
  workspaceID: a.workspaceID,
  projectID: a.projectID,
  groupID: a.groupID,
  messageID: a.messageID,
  uploadedBy: a.uploadedBy,
  filename: a.filename,
  mime: a.mime,
  sizeBytes: a.sizeBytes,
  checksum: a.checksum,
  createdAt: a.createdAt,
})

// Attachment mime allow-list, size cap, checksum, and server-derived storage path all live in the pure
// AttachmentStorage core (@deepagent-code/core/im/attachment-storage) so they are unit-testable without
// the multipart HTTP transport. The handler just calls into it.

// Simple in-memory rate limiter
class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>()

  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now()
    const bucket = this.buckets.get(key)

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }

    if (bucket.count >= limit) {
      return false
    }

    bucket.count++
    return true
  }

  cleanup() {
    const now = Date.now()
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key)
      }
    }
  }
}

const rateLimiter = new RateLimiter()
// Cleanup every 5 minutes
setInterval(() => rateLimiter.cleanup(), 5 * 60 * 1000)

const mapRepositoryError = <A, E, R>(effect: Effect.Effect<A, E | IMRepositoryError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is IMRepositoryError => error instanceof IMRepositoryError,
      (error) =>
        Effect.fail(
          new IMInternalServerError({
            name: "INTERNAL_SERVER_ERROR",
            data: { message: error.message },
          }),
        ),
    ),
  )

// 配置：可以通过环境变量调整
const getRateLimit = () => parseInt(process.env.IM_RATE_LIMIT_PER_MINUTE || "200", 10) // 默认 200/分钟，更宽松
const getMaxMessageLength = () => parseInt(process.env.IM_MAX_MESSAGE_LENGTH || "100000", 10) // 默认 100k

export const imHandlers = HttpApiBuilder.group(InstanceHttpApi, "im", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* IMRepository
    const broadcaster = yield* IMBroadcasterService
    const agentListProvider = yield* AgentListProviderService
    // V4.0 §B1 — the flag + bus for the double-write (user message persist → publish im.message.created).
    const flags = yield* RuntimeFlags.Service
    const eventBus = yield* DeepAgentEventBus.Service
    // Long-lived scope for detached agent runs. Forking into the SERVER scope (not
    // the request scope) means the agent keeps running after the HTTP response is
    // sent, while still inheriting the request fiber's full context — crucially the
    // InstanceRef/WorkspaceRef that SessionPrompt needs for the worktree/directory.
    const serverScope = yield* Scope.Scope

    return handlers
      .handle("listGroups", ({ query }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { workspaceID, userID } = yield* getWorkspaceContext(query)

            const groups = yield* repo.listGroups({ workspaceID, userID })

            return groups.map((g) => ({
              id: g.id,
              workspaceID: g.workspaceID,
              projectID: g.projectID,
              type: g.type,
              name: g.name,
              createdBy: g.createdBy,
              createdAt: g.createdAt,
              updatedAt: g.updatedAt,
            }))
          }),
        ),
      )
      .handle("createGroup", ({ query, payload }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { workspaceID, userID } = yield* getWorkspaceContext(query)

            // §B3 私聊 — a "direct" group is created via createDirectGroup, which enforces the exactly-2
            // member / user+user|user+agent constraint and de-duplicates the pair. The creator (server
            // user) is one participant; payload.member is the counterparty.
            if (payload.type === "direct") {
              if (!payload.member) {
                return yield* Effect.fail(
                  new IMValidationFailedError({
                    name: "VALIDATION_FAILED",
                    data: { message: "A direct group requires a `member` (the counterparty)." },
                  }),
                )
              }
              const group = yield* repo
                .createDirectGroup({
                  workspaceID,
                  projectID: payload.projectID,
                  createdBy: userID,
                  name: payload.name || undefined,
                  members: [
                    { memberID: userID, memberType: "user" },
                    { memberID: payload.member.memberID, memberType: payload.member.memberType },
                  ],
                })
                // A constraint violation surfaces as an IMRepositoryError; map it to a 400 rather than a
                // 500 so the caller sees the validation failure.
                .pipe(
                  Effect.catchIf(
                    (e): e is IMRepositoryError => e instanceof IMRepositoryError,
                    (e) =>
                      Effect.fail(
                        new IMValidationFailedError({
                          name: "VALIDATION_FAILED",
                          data: { message: e.message },
                        }),
                      ),
                  ),
                )
              return {
                id: group.id,
                workspaceID: group.workspaceID,
                projectID: group.projectID,
                type: group.type,
                name: group.name,
                createdBy: group.createdBy,
                createdAt: group.createdAt,
                updatedAt: group.updatedAt,
              }
            }

            const group = yield* repo.createGroup({
              workspaceID,
              projectID: payload.projectID,
              type: payload.type,
              name: payload.name,
              createdBy: userID,
            })

            return {
              id: group.id,
              workspaceID: group.workspaceID,
              projectID: group.projectID,
              type: group.type,
              name: group.name,
              createdBy: group.createdBy,
              createdAt: group.createdAt,
              updatedAt: group.updatedAt,
            }
          }),
        ),
      )
      .handle("listMessages", ({ params, query }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { userID } = yield* getWorkspaceContext(query)
            const groupId = params.groupId

            // Check if group exists and user has access
            const group = yield* repo.getGroup({ groupID: groupId, userID })
            if (!group) {
              return yield* Effect.fail(
                new IMGroupNotFoundError({
                  name: "GROUP_NOT_FOUND",
                  data: { message: `Group ${groupId} not found` },
                }),
              )
            }

            const limit = query.limit ?? 50
            const page = yield* repo.listMessages({
              groupID: groupId,
              cursor: query.cursor,
              limit,
            })

            return {
              messages: page.messages.map((m) => ({
                id: m.id,
                groupID: m.groupID,
                senderID: m.senderID,
                senderType: m.senderType,
                type: m.type,
                content: m.content,
                mentions: m.mentions,
                metadata: m.metadata,
                replyToID: m.replyToID,
                createdAt: m.createdAt,
                updatedAt: m.updatedAt,
              })),
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            }
          }),
        ),
      )
      .handle("createMessage", ({ params, query, payload }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { workspaceID, directory, userID } = yield* getWorkspaceContext(query)
            const groupId = params.groupId

            // Validate message length
            const maxLength = getMaxMessageLength()
            if (payload.content.length > maxLength) {
              return yield* Effect.fail(
                new IMMessageTooLargeError({
                  name: "MESSAGE_TOO_LARGE",
                  data: {
                    message: `Message exceeds maximum length of ${maxLength} characters`,
                    maxLength,
                  },
                }),
              )
            }

            // Check rate limit
            const rateLimit = getRateLimit()
            const rateLimitKey = `${userID}:${groupId}`
            if (!rateLimiter.check(rateLimitKey, rateLimit, 60 * 1000)) {
              return yield* Effect.fail(
                new IMRateLimitExceededError({
                  name: "RATE_LIMIT_EXCEEDED",
                  data: {
                    message: `Rate limit exceeded. Maximum ${rateLimit} messages per minute per group.`,
                    retryAfter: 60,
                  },
                }),
              )
            }

            // Check if group exists
            const group = yield* repo.getGroup({ groupID: groupId, userID })
            if (!group) {
              return yield* Effect.fail(
                new IMGroupNotFoundError({
                  name: "GROUP_NOT_FOUND",
                  data: { message: `Group ${groupId} not found` },
                }),
              )
            }

            // Parse mentions from content
            const mentionedAgentNames = MentionParser.parse(payload.content)

            // Create message.
            // Force senderType to "user" — this endpoint is authenticated as a user,
            // so we must not trust the client-supplied senderType (which would let a
            // user forge "system"/"agent" messages that the UI renders specially).
            const message = yield* repo
              .createMessage({
                groupID: groupId,
                senderID: userID,
                senderType: "user",
                type: payload.type,
                content: payload.content,
                mentions: mentionedAgentNames, // Use parsed mentions
                metadata: payload.metadata,
                replyToID: payload.replyToID,
              })
              .pipe(
                Effect.tap((msg) =>
                  Effect.gen(function* () {
                    // Broadcast message_created event via WebSocket
                    broadcaster.broadcast(groupId, {
                      type: "message_created",
                      data: {
                        id: msg.id,
                        groupID: msg.groupID,
                        senderID: msg.senderID,
                        senderType: msg.senderType,
                        messageType: msg.type,
                        content: msg.content,
                        mentions: msg.mentions,
                        metadata: msg.metadata,
                        replyToID: msg.replyToID,
                        createdAt: msg.createdAt,
                        updatedAt: msg.updatedAt,
                      },
                    })
                    // V4.0 §B1 — double-write: publish im.message.created onto the DeepAgent Event Bus
                    // AFTER the message is durably persisted (so the legacy path stays authoritative and
                    // the event is never emitted for an un-persisted message). Flag-gated on
                    // v4EventDrivenIm (default OFF ⇒ no publish, byte-identical to V3.8). Best-effort:
                    // idempotencyKey = the message id (one event per message), and a bus failure never
                    // fails the user's send (the message already persisted + broadcast).
                    //
                    // §E2 RATE GATE (live): this is the primary workspace-facing, user-driven publisher —
                    // one event per IM message — so it goes through `tryPublish`, applying the 1000/min
                    // per-workspace publish ceiling. `im.message.created` is `normal` priority, so a
                    // workspace flooding messages sheds the excess (`{ dropped: "rate_limited" }` ⇒ NOT
                    // persisted, NOT dispatched). The legacy IM message + broadcast already succeeded, so
                    // shedding the derived bus event only pauses V4 event-driven reactions for the burst —
                    // it never loses the user's message. We record the drop as the §A4 event_dropped signal.
                    if (flags.v4EventDrivenIm) {
                      const outcome = yield* eventBus
                        .tryPublish({
                          type: LMNEvents.IM_MESSAGE_CREATED,
                          source: "im",
                          workspaceID: workspaceID ?? directory,
                          actorID: userID,
                          idempotencyKey: `im:${msg.id}`,
                          priority: "normal",
                          payload: {
                            messageID: msg.id,
                            groupID: msg.groupID,
                            senderID: msg.senderID,
                            senderType: msg.senderType,
                            content: msg.content,
                            mentions: msg.mentions,
                            replyToID: msg.replyToID,
                          },
                        })
                        // Best-effort: a bus EXCEPTION must not fail the user's send (the message already
                        // persisted + broadcast). Catch the cause into a DISTINCT sentinel so a real error
                        // is logged as an error — never mislabeled as a rate-limit drop (the two are
                        // different signals: a drop is expected shedding, an exception is a fault).
                        .pipe(
                          Effect.catchCause((cause) => Effect.succeed({ busError: cause } as const)),
                        )
                      if ("busError" in outcome) {
                        yield* Effect.logError("im.message.created publish failed").pipe(
                          Effect.annotateLogs({
                            reason: "publish_error",
                            workspaceID: workspaceID ?? directory,
                            messageID: msg.id,
                            cause: Cause.pretty(outcome.busError),
                          }),
                        )
                      } else if ("dropped" in outcome) {
                        yield* Effect.logWarning("im.message.created dropped by publish rate gate").pipe(
                          Effect.annotateLogs({
                            reason: "event_dropped",
                            cause: "rate_limited",
                            workspaceID: workspaceID ?? directory,
                            messageID: msg.id,
                          }),
                        )
                      }
                    }
                  }),
                ),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    // Broadcast message_failed event
                    broadcaster.broadcast(groupId, {
                      type: "message_failed",
                      data: {
                        code: "MESSAGE_CREATE_FAILED",
                        message: String(error),
                        retryable: true,
                      },
                    })
                    return yield* Effect.fail(error)
                  }),
                ),
              )

            // Execute mentioned agents asynchronously (don't block the response).
            // Fork into the SERVER scope so the run outlives the HTTP response but
            // still inherits this request fiber's context — including the
            // InstanceRef/WorkspaceRef that the agent executor (SessionPrompt) needs
            // to locate the worktree/directory. A detached Effect.runFork would drop
            // those references and the agent would never actually run.
            if (mentionedAgentNames.length > 0) {
              yield* executeAgentMentions({
                workspaceID,
                directory,
                groupID: groupId,
                messageID: message.id,
                userID,
                content: payload.content,
                mentionedAgentNames,
              }).pipe(Effect.forkIn(serverScope, { startImmediately: true }))
            }

            return {
              id: message.id,
              groupID: message.groupID,
              senderID: message.senderID,
              senderType: message.senderType,
              type: message.type,
              content: message.content,
              mentions: message.mentions,
              metadata: message.metadata,
              replyToID: message.replyToID,
              createdAt: message.createdAt,
              updatedAt: message.updatedAt,
            }
          }),
        ),
      )
      .handle("markRead", ({ params, query, payload }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { userID } = yield* getWorkspaceContext(query)
            const groupId = params.groupId

            // Check if group exists
            const group = yield* repo.getGroup({ groupID: groupId, userID })
            if (!group) {
              return yield* Effect.fail(
                new IMGroupNotFoundError({
                  name: "GROUP_NOT_FOUND",
                  data: { message: `Group ${groupId} not found` },
                }),
              )
            }

            const readAt = payload.readAt ?? Date.now()
            yield* repo.markRead({
              groupID: groupId,
              memberID: userID,
              readAt,
            })

            return { ok: true }
          }),
        ),
      )
      .handle("listAgents", ({ query }) =>
        Effect.gen(function* () {
          const { workspaceID, userID } = yield* getWorkspaceContext(query)

          const agents = yield* agentListProvider.listAgents({ workspaceID, userID })

          // Descriptors already match the canonical `AgentDescriptor` wire shape
          // (V3.8.1 §C.3), including the optional metadata fields — return as-is.
          return agents
        }).pipe(
          Effect.catch((error) =>
            Effect.fail(
              new IMInternalServerError({
                name: "INTERNAL_SERVER_ERROR",
                data: { message: error instanceof Error ? error.message : String(error) },
              }),
            ),
          ),
        ),
      )
      .handle("getMessage", ({ params, query }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { userID } = yield* getWorkspaceContext(query)
            const messageId = params.messageId

            // Use direct getMessage method
            const message = yield* repo.getMessage(messageId)

            if (!message) {
              return yield* Effect.fail(
                new IMMessageNotFoundError({
                  name: "MESSAGE_NOT_FOUND",
                  data: { message: `Message ${messageId} not found` },
                }),
              )
            }

            // Access control: verify the requesting user is a member of the message's
            // group. getGroup enforces membership; without this check any user could
            // read any message by ID (IDOR).
            const group = yield* repo.getGroup({ groupID: message.groupID, userID })
            if (!group) {
              return yield* Effect.fail(
                new IMMessageNotFoundError({
                  name: "MESSAGE_NOT_FOUND",
                  data: { message: `Message ${messageId} not found` },
                }),
              )
            }

            return {
              id: message.id,
              groupID: message.groupID,
              senderID: message.senderID,
              senderType: message.senderType,
              type: message.type,
              content: message.content,
              mentions: message.mentions,
              metadata: message.metadata,
              replyToID: message.replyToID,
              createdAt: message.createdAt,
              updatedAt: message.updatedAt,
            }
          }),
        ),
      )
      .handle("listThread", ({ params, query }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { userID } = yield* getWorkspaceContext(query)
            const groupId = params.groupId

            // Membership check (also the IDOR guard): the caller must be a member of the group before
            // any thread rows are returned.
            const group = yield* repo.getGroup({ groupID: groupId, userID })
            if (!group) {
              return yield* Effect.fail(
                new IMGroupNotFoundError({
                  name: "GROUP_NOT_FOUND",
                  data: { message: `Group ${groupId} not found` },
                }),
              )
            }

            const limit = clampLimit(query.limit)
            const page = yield* repo.listThread({
              groupID: groupId,
              replyToID: params.messageId,
              cursor: query.cursor,
              limit,
            })

            return {
              messages: page.messages.map(toMessageResponse),
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            }
          }),
        ),
      )
      .handle("search", ({ query }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { workspaceID, userID } = yield* getWorkspaceContext(query)

            const q = query.q.trim()
            if (q.length === 0) {
              return yield* Effect.fail(
                new IMValidationFailedError({
                  name: "VALIDATION_FAILED",
                  data: { message: "Search query `q` must not be empty." },
                }),
              )
            }

            const limit = clampLimit(query.limit)
            // Permission scoping is enforced INSIDE the repository via the membership join — a user can
            // only ever match messages in groups they belong to, even when they pass an explicit groupId
            // for a group they're not a member of.
            const page = yield* repo.searchMessages({
              workspaceID,
              userID,
              query: q,
              groupID: query.groupId,
              senderType: query.senderType,
              type: query.type,
              metadataType: query.metadataType,
              cursor: query.cursor,
              limit,
            })

            return {
              messages: page.messages.map(toMessageResponse),
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            }
          }),
        ),
      )
      .handle("uploadAttachment", ({ query, payload }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            // §B3 文件 — fail-closed when the flag is off (404: the endpoint does not exist for the
            // caller). Checked FIRST so no bytes are read / stored when uploads are disabled.
            if (!flags.v4FileUploadEnabled) {
              return yield* Effect.fail(
                new IMFileUploadDisabledError({
                  name: "FILE_UPLOAD_DISABLED",
                  data: { message: "File upload is disabled." },
                }),
              )
            }

            const { workspaceID, userID } = yield* getWorkspaceContext(query)
            const file = payload.file

            // If the upload is scoped to a group, the caller must be a member (membership + IDOR guard).
            if (payload.groupId) {
              const group = yield* repo.getGroup({ groupID: payload.groupId, userID })
              if (!group) {
                return yield* Effect.fail(
                  new IMGroupNotFoundError({
                    name: "GROUP_NOT_FOUND",
                    data: { message: `Group ${payload.groupId} not found` },
                  }),
                )
              }
            }

            // The multipart parser persisted the bytes to a temp file (file.path). Read them so the pure
            // policy core can validate mime + size and compute the sha256 checksum.
            const bytes = yield* Effect.tryPromise({
              try: () => nodeFs.readFile(file.path),
              catch: (e) =>
                new IMInternalServerError({
                  name: "INTERNAL_SERVER_ERROR",
                  data: { message: `Failed to read uploaded file: ${String(e)}` },
                }),
            })

            // Validation policy (mime allow-list, size cap, checksum) lives in the pure
            // AttachmentStorage core so it is unit-testable without the multipart transport.
            const validated = AttachmentStorage.validateUpload({ contentType: file.contentType, bytes })
            if (!validated.ok) {
              if (validated.error === "unsupported_media_type") {
                return yield* Effect.fail(
                  new IMUnsupportedMediaTypeError({
                    name: "UNSUPPORTED_MEDIA_TYPE",
                    data: { message: `Unsupported media type: ${validated.mime}` },
                  }),
                )
              }
              return yield* Effect.fail(
                new IMFileTooLargeError({
                  name: "FILE_TOO_LARGE",
                  data: {
                    message: `File exceeds the maximum size of ${validated.maxBytes} bytes`,
                    maxBytes: validated.maxBytes,
                  },
                }),
              )
            }

            // Server-derived storage path: <data>/im-attachments/<workspaceID>/<attachmentId>. Built ONLY
            // from server-generated ids (never the client filename) and verified to stay within the base
            // directory — see AttachmentStorage.deriveStoragePath.
            const attachmentId = IMAttachmentID.create()
            const derived = AttachmentStorage.deriveStoragePath({
              dataDir: Global.Path.data,
              workspaceID,
              attachmentID: attachmentId,
            })
            if (!derived.ok) {
              return yield* Effect.fail(
                new IMInternalServerError({
                  name: "INTERNAL_SERVER_ERROR",
                  data: { message: "Resolved storage path escaped the attachments directory" },
                }),
              )
            }

            yield* Effect.tryPromise({
              try: async () => {
                await nodeFs.mkdir(derived.baseDir, { recursive: true })
                await nodeFs.writeFile(derived.storagePath, bytes)
              },
              catch: (e) =>
                new IMInternalServerError({
                  name: "INTERNAL_SERVER_ERROR",
                  data: { message: `Failed to store uploaded file: ${String(e)}` },
                }),
            })

            const attachment = yield* repo.createAttachment({
              workspaceID,
              groupID: payload.groupId,
              messageID: payload.messageId,
              uploadedBy: userID,
              storagePath: derived.storagePath,
              // Keep the original filename for display/download; it is never used to build a path.
              filename: file.name || "upload",
              mime: validated.mime,
              sizeBytes: validated.sizeBytes,
              checksum: validated.checksum,
            })

            return toAttachmentResponse(attachment)
          }),
        ),
      )
      .handle("listAttachments", ({ query }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            if (!flags.v4FileUploadEnabled) {
              return yield* Effect.fail(
                new IMFileUploadDisabledError({
                  name: "FILE_UPLOAD_DISABLED",
                  data: { message: "File upload is disabled." },
                }),
              )
            }

            const { workspaceID, userID } = yield* getWorkspaceContext(query)

            // If scoped to a group, membership is required (IDOR guard) so a caller can't enumerate
            // attachments in a group they don't belong to.
            if (query.groupId) {
              const group = yield* repo.getGroup({ groupID: query.groupId, userID })
              if (!group) {
                return yield* Effect.fail(
                  new IMGroupNotFoundError({
                    name: "GROUP_NOT_FOUND",
                    data: { message: `Group ${query.groupId} not found` },
                  }),
                )
              }
            }

            const limit = clampLimit(query.limit)
            const attachments = yield* repo.listAttachments({
              workspaceID,
              groupID: query.groupId,
              messageID: query.messageId,
              limit,
            })

            return attachments.map(toAttachmentResponse)
          }),
        ),
      )
  }),
)
