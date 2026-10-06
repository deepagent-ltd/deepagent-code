import { Effect, Option, Ref } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import nodeFs from "node:fs/promises"
import { Global } from "@deepagent-code/core/global"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { clientMessageID, IMRepository, IMRepositoryError } from "@deepagent-code/core/im/repository"
import type { IMGroup } from "@deepagent-code/core/im/repository"
import { facadeErrorStatus } from "@deepagent-code/core/im/facade-contract"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { InstanceHttpApi } from "../api"
import {
  IMGroupNotFoundError,
  IMMessageNotFoundError,
  IMMessageTooLargeError,
  IMMessageIdentityConflictError,
  IMRateLimitExceededError,
  IMValidationFailedError,
  IMInternalServerError,
  IMFileUploadDisabledError,
  IMThreadDisabledError,
  IMFileTooLargeError,
  IMUnsupportedMediaTypeError,
  IMFacadeBadRequestError,
  IMFacadeForbiddenError,
  IMFacadeNotFoundError,
  IMFacadeConflictError,
  IMFacadeUnavailableError,
} from "../groups/im"
import { MentionParser } from "@deepagent-code/core/im/mention-parser"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { SessionV2 } from "@deepagent-code/core/session"
import type { IMMessage, IMAttachment } from "@deepagent-code/core/im/repository"
import * as IMID from "@deepagent-code/core/im/id"
import { getWorkspaceContext } from "../utils/workspace-context"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RateLimiter } from "@deepagent-code/core/deepagent/rate-limiter"
import { IMAgentExecution } from "@/im/im-agent-execution"
import { IMFacade } from "@/im/facade"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { boundedPositiveInteger } from "./im-config"

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

const toGroupResponse = (g: IMGroup) => ({
  id: g.id,
  workspaceID: g.workspaceID,
  projectID: g.projectID,
  type: g.type,
  name: g.name,
  createdBy: g.createdBy,
  kernelConvID: g.kernelConvID,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
})

// B2 门面错误的归桶：ExchangeError.status（门面真实 HTTP 状态）优先，缺失时按 core
// facadeErrorStatus(code) 归桶。Schema.ErrorClass 的状态是类级常量，故 5xx（含契约 503
// im_unavailable）统一落 IMFacadeUnavailableError（wire 502）——GUI 一律按 data.code 出文案。
const mapExchangeError = (error: IMKernelExchange.ExchangeError) => {
  const data = { code: error.code, message: error.message }
  switch (error.status ?? facadeErrorStatus(error.code)) {
    case 400:
      return new IMFacadeBadRequestError({ name: "IM_FACADE_BAD_REQUEST", data })
    case 403:
      return new IMFacadeForbiddenError({ name: "IM_FACADE_FORBIDDEN", data })
    case 404:
      return new IMFacadeNotFoundError({ name: "IM_FACADE_NOT_FOUND", data })
    case 409:
      return new IMFacadeConflictError({ name: "IM_FACADE_CONFLICT", data })
    default:
      return new IMFacadeUnavailableError({ name: "IM_FACADE_UNAVAILABLE", data })
  }
}

const facadeUnavailable = (message: string) =>
  new IMFacadeUnavailableError({ name: "IM_FACADE_UNAVAILABLE", data: { code: "im_unavailable", message } })

// ExchangeError → 归桶 HTTP 错误；其它错误（如 facadeUnavailable 合成的 IMFacadeUnavailableError）原样透传。
const mapFacadeErrors = <A, E, R>(effect: Effect.Effect<A, E | IMKernelExchange.ExchangeError, R>) =>
  effect.pipe(
    Effect.mapError((error) => (error instanceof IMKernelExchange.ExchangeError ? mapExchangeError(error) : error)),
  )

// Attachment mime allow-list, size cap, checksum, and server-derived storage path all live in the pure
// AttachmentStorage core (@deepagent-code/core/im/attachment-storage) so they are unit-testable without
// the multipart HTTP transport. The handler just calls into it.

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
const getRateLimit = () => boundedPositiveInteger(process.env.IM_RATE_LIMIT_PER_MINUTE, 200, 10_000)
const getMaxMessageLength = () => boundedPositiveInteger(process.env.IM_MAX_MESSAGE_LENGTH, 100_000, 1_000_000)

export const imHandlers = HttpApiBuilder.group(InstanceHttpApi, "im", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* IMRepository
    const broadcaster = yield* IMBroadcasterService
    const agentListProvider = yield* AgentListProviderService
    const rateLimiter = new RateLimiter.Service()
    const flags = yield* RuntimeFlags.Service
    // V2 IM durable-only: mentions are admitted directly as durable SessionV2 work (one
    // session_input per (message, agent), stable session per (group, agent)); the terminal reply
    // returns through the im_reply_outbox daemon, not a fire-and-forget fork.
    const v2Session = yield* SessionV2.Service
    // IM 门面（B2）：内核引擎的唯一所有者。缺席（图层未挂）⇒ 门面端点 fail-closed im_unavailable，
    // 消息发送保持纯本地（单用户路径不动）。
    const facade = Option.getOrUndefined(yield* Effect.serviceOption(IMFacade.Service))

    return handlers
      .handle("listGroups", ({ query }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { workspaceID, userID } = yield* getWorkspaceContext(query)

            const groups = yield* repo.listGroups({ workspaceID, userID })

            return groups.map(toGroupResponse)
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
              return toGroupResponse(group)
            }

            const group = yield* repo.createGroup({
              workspaceID,
              projectID: payload.projectID,
              type: payload.type,
              name: payload.name,
              createdBy: userID,
            })

            return toGroupResponse(group)
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
            if (!(payload.clientRequestID && (yield* repo.getMessage(clientMessageID(userID, payload.clientRequestID)))) && !rateLimiter.check(rateLimitKey, rateLimit, 60 * 1000)) {
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
            const responderEnabled = IMAgentExecution.responderEnabled()

            // Create message.
            // Force senderType to "user" — this endpoint is authenticated as a user,
            // so we must not trust the client-supplied senderType (which would let a
            // user forge "system"/"agent" messages that the UI renders specially).
            const message = yield* repo
              .createMessage({
                groupID: groupId,
                clientRequestID: payload.clientRequestID,
                mentionIntent: responderEnabled
                  ? { names: mentionedAgentNames, directory, workspaceID, userID, origin: "local" }
                  : undefined,
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
                    if (msg.replayed) return
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
                    return yield* Effect.fail(error.code === "message_identity_conflict"
                      ? new IMMessageIdentityConflictError({ name: "MESSAGE_IDENTITY_CONFLICT", data: { message: error.message } })
                      : error)
                  }),
                ),
              )

            // ── IM-kernel (B1/B2): forward the locally persisted text to the kernel ────────────────
            // Best-effort and non-blocking: the local row IS the authoritative copy (design §2);
            // the sync engine owns the kernel send, ack write-back (kernel_msg_id), and pending
            // retry. B1 kernel path is text-only; other types stay purely local. The engine is owned
            // by the facade (B2) and read fresh per send — claim/retry hot-starts must not leave a
            // stale None captured in this long-lived handler layer.
            if (!message.replayed && payload.type === "text" && facade) {
              const engine = yield* Ref.get(facade.engine)
              if (Option.isSome(engine)) {
                yield* engine.value.send({ groupID: groupId, messageID: message.id, content: payload.content })
              }
            }

            // The transaction above owns the live intent. Immediate repair lowers latency;
            // the daemon retries persisted pending intents after process or transport failure.
            if (responderEnabled && !message.replayed && mentionedAgentNames.length > 0)
              yield* IMAgentExecution.reconcileMentions({ repo, v2Session, agents: agentListProvider, broadcaster, origin: "local" }).pipe(Effect.ignore)

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
            // §B3 threads — fail-closed when the flag is off (404: the endpoint does not exist for the
            // caller), mirroring the uploadAttachment gate. Checked FIRST so no membership/thread lookup
            // runs when threads are disabled.
            if (!flags.v4ThreadEnabled) {
              return yield* Effect.fail(
                new IMThreadDisabledError({
                  name: "THREAD_DISABLED",
                  data: { message: "Threads are disabled." },
                }),
              )
            }

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
      // ── B2 门面端点 ─────────────────────────────────────────────────────────────────
      // facade 服务缺席（图层未挂 IMFacade）⇒ status 返回 disabled 快照，mutation 一律
      // im_unavailable（与门面自身 fail-closed 语义一致）。ExchangeError 按状态归桶透传 code。
      .handle("facadeStatus", ({ query }) =>
        Effect.gen(function* () {
          const context = yield* getWorkspaceContext(query)
          const viewer = { memberID: context.userID }
          if (!facade) return { facade: "disabled" as const, identity: null, blocked: null, kernel: null, keyOrigin: "none" as const, viewer }
          const snapshot = yield* facade.status
          return {
            facade: snapshot.facade,
            identity: Option.getOrNull(snapshot.identity),
            blocked: Option.getOrNull(snapshot.blocked),
            kernel: Option.getOrNull(snapshot.kernel),
            keyOrigin: snapshot.keyOrigin,
            recovery: snapshot.recovery,
            viewer,
          }
        }),
      )
      .handle("facadeClaim", ({ payload }) =>
        Effect.gen(function* () {
          if (!facade) return yield* facadeUnavailable("IM facade is not configured on this server")
          return yield* facade.claim(payload.name)
        }).pipe(mapFacadeErrors),
      )
      .handle("facadeRename", ({ payload }) =>
        Effect.gen(function* () {
          if (!facade) return yield* facadeUnavailable("IM facade is not configured on this server")
          return yield* facade.rename(payload.name)
        }).pipe(mapFacadeErrors),
      )
      .handle("facadeRebind", ({ payload }) =>
        Effect.gen(function* () {
          if (!facade) return yield* facadeUnavailable("IM facade is not configured on this server")
          return yield* facade.rebind(payload.newKey)
        }).pipe(mapFacadeErrors),
      )
      .handle("facadeRetry", () =>
        Effect.gen(function* () {
          if (!facade) return yield* facadeUnavailable("IM facade is not configured on this server")
          return yield* facade.retryExchange
        }).pipe(mapFacadeErrors),
      )
      .handle("facadeResolve", ({ query }) =>
        Effect.gen(function* () {
          if (!facade) return yield* facadeUnavailable("IM facade is not configured on this server")
          return yield* facade.resolve(query.name)
        }).pipe(mapFacadeErrors),
      )
      .handle("facadeDirect", ({ query, payload }) =>
        Effect.gen(function* () {
          if (!facade) return yield* facadeUnavailable("IM facade is not configured on this server")
          const { workspaceID } = yield* getWorkspaceContext(query)
          const group = yield* facade.openDirect({ workspaceID, name: payload.name })
          return toGroupResponse(group)
        }).pipe(
          Effect.mapError((error) => {
            if (error instanceof IMKernelExchange.ExchangeError) return mapExchangeError(error)
            if (error instanceof IMRepositoryError)
              return new IMInternalServerError({ name: "INTERNAL_SERVER_ERROR", data: { message: error.message } })
            return error
          }),
        ),
      )
      .handle("facadeCreateGroup", ({ query, payload }) =>
        Effect.gen(function* () {
          if (!facade) return yield* facadeUnavailable("IM facade is not configured on this server")
          const { workspaceID } = yield* getWorkspaceContext(query)
          const group = yield* facade.createGroup({ workspaceID, name: payload.name, memberNames: payload.memberNames })
          return toGroupResponse(group)
        }).pipe(
          Effect.mapError((error) => {
            if (error instanceof IMKernelExchange.ExchangeError) return mapExchangeError(error)
            if (error instanceof IMRepositoryError)
              return new IMInternalServerError({ name: "INTERNAL_SERVER_ERROR", data: { message: error.message } })
            return error
          }),
        ),
      )
      .handle("facadeInvite", ({ params, payload }) =>
        Effect.gen(function* () {
          if (!facade) return yield* facadeUnavailable("IM facade is not configured on this server")
          yield* facade.invite({ groupID: params.groupId, name: payload.name })
          return { ok: true }
        }).pipe(
          Effect.mapError((error) => {
            if (error instanceof IMFacade.GroupLookupError)
              return new IMGroupNotFoundError({ name: "GROUP_NOT_FOUND", data: { message: error.message } })
            if (error instanceof IMKernelExchange.ExchangeError) return mapExchangeError(error)
            if (error instanceof IMRepositoryError)
              return new IMInternalServerError({ name: "INTERNAL_SERVER_ERROR", data: { message: error.message } })
            return error
          }),
        ),
      )
  }),
)
