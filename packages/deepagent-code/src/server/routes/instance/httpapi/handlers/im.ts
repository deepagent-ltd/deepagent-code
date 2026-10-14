import { Effect, Option, Ref, Schema, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerResponse, Multipart } from "effect/unstable/http"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { InstanceState } from "@/effect/instance-state"
import { IMDacSession } from "@deepagent-code/core/im/dac-session"
import { GroupID, MessageID } from "@deepagent-code/core/im/id"
import { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"
import { IMActivationSchema } from "@deepagent-code/core/im/activation.schema"
import { IMActivation } from "@/im/activation"
import { ConfigIM } from "@deepagent-code/core/config/im"
import { Config } from "@/config/config"
import { IMKernelReaderProjectionTable, IMKernelReaderScopeTable } from "@deepagent-code/core/im/kernel-reader.sql"
import { MemberTable } from "@deepagent-code/core/im/sql"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { MediaBatch } from "@deepagent-code/core/im/media-batch"
import { clientMessageID, groupPageCandidates, IMRepository, IMRepositoryError } from "@deepagent-code/core/im/repository"
import type { IMGroup } from "@deepagent-code/core/im/repository"
import { facadeErrorStatus } from "@deepagent-code/core/im/facade-contract"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { InstanceHttpApi } from "../api"
import {
  IMGroupNotFoundError,
  IMDacCommandError,
  IMReaderUnavailableError,
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
  UploadAttachmentPayload,
} from "../groups/im"
import { MentionParser } from "@deepagent-code/core/im/mention-parser"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { SessionV2 } from "@deepagent-code/core/session"
import type { IMMessage, IMAttachment } from "@deepagent-code/core/im/repository"
import * as IMID from "@deepagent-code/core/im/id"
import { getWorkspaceContext } from "../utils/workspace-context"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RateLimiter } from "@deepagent-code/core/deepagent/rate-limiter"
import { IMFacade } from "@/im/facade"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { boundedPositiveInteger } from "./im-config"
import { IMMedia } from "./im-media"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import type { WorkspaceRoutingQuery } from "../middleware/workspace-routing"

const IMAttachmentID = IMID.AttachmentID

const GroupCursor = Schema.Struct({ version: Schema.Literal(1), lane: Schema.Literals(["ordinary", "protected"]), limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })), upper: KernelReaderSchema.GroupPosition, after: KernelReaderSchema.GroupPosition, expiresAt: KernelReaderSchema.Time, stamp: KernelReaderSchema.Hash })
const groupPositionBefore = (a: KernelReaderSchema.GroupPosition, b: KernelReaderSchema.GroupPosition) => a.createdAt < b.createdAt || a.createdAt === b.createdAt && a.id < b.id

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
  ...(m.remoteAttachments ? { remoteAttachments: m.remoteAttachments } : {}),
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
  expiresAt: AttachmentStorage.expiresAt(a.createdAt),
  preview: AttachmentStorage.isPreviewMime(a.mime),
})

const toGroupResponse = (g: IMGroup) => ({
  id: g.id,
  workspaceID: g.workspaceID,
  projectID: g.projectID,
  type: g.type,
  name: g.name,
  createdBy: g.createdBy,
  kernelConvID: g.kernelConvID,
  ...(g.reader ? { reader: g.reader } : {}),
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
          error.code && KernelReaderSchema.CODES.includes(error.code as KernelReaderSchema.Code) ? new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: error.code as KernelReaderSchema.Code, operation: error.operation ?? "output", wireCode: error.wireCode, message: "Remote conversation is currently unavailable" } }) : new IMInternalServerError({
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
    const database = yield* Effect.serviceOption(Database.Service)
    const broadcaster = yield* IMBroadcasterService
    const agentListProvider = yield* AgentListProviderService
    const rateLimiter = new RateLimiter.Service()
    const flags = yield* RuntimeFlags.Service
    const config = yield* Config.Service
    // Owner commands privately admit ordinary Session inputs; communication
    // messages and mentions never invoke this admission path.
    const v2Session = yield* SessionV2.Service
    const dac = Option.isSome(database) ? IMDacSession.make(database.value.db, v2Session) : undefined
    // IM 门面（B2）：内核引擎的唯一所有者。缺席（图层未挂）⇒ 门面端点 fail-closed im_unavailable，
    // 纯本地消息无需门面；内核绑定消息必须具备当前引擎身份才能准备外发收据。
    const facade = Option.getOrUndefined(yield* Effect.serviceOption(IMFacade.Service))
    const activation = Option.getOrUndefined(yield* Effect.serviceOption(IMActivation.Service))
    const activationError = <A, R>(effect: Effect.Effect<A, IMActivationSchema.Error, R>) => effect.pipe(Effect.mapError((error) => {
      const data = { code: error.code, message: "IM activation is not complete. Check the original transaction status before paying again." }
      if (error.code === "im_activation_invalid") return new IMFacadeBadRequestError({ name: "IM_FACADE_BAD_REQUEST", data })
      if (["im_activation_conflict", "im_activation_pending", "im_device_migration_pending", "im_device_binding_exists", "im_migration_conflict"].includes(error.code)) return new IMFacadeConflictError({ name: "IM_FACADE_CONFLICT", data })
      return new IMFacadeUnavailableError({ name: "IM_FACADE_UNAVAILABLE", data })
    }))
    const requireActivation = activation ? Effect.succeed(activation) : Effect.fail(new IMActivationSchema.Error({ code: "im_activation_unavailable" }))
    const activationReady = (value: IMActivationSchema.Transaction) => Effect.gen(function* () {
      // Connectivity failures after durable purchase do not turn into another charge.
      if (value.state === "succeeded" && value.credentialStored && facade) yield* facade.retryExchange.pipe(Effect.ignore)
      return value
    })

    const cursorKey = yield* Effect.sync(() => randomBytes(32))
    const cursorStart = { wall: Date.now(), monotonic: performance.now() }
    const cursorClock = () => Math.floor(cursorStart.wall + performance.now() - cursorStart.monotonic)
    const cursorMAC = (purpose: string, value: string) => createHmac("sha256", cursorKey).update(`deepagent.im.groups.${purpose}.v1\0`).update(value).digest("hex")
    const encodeGroupCursor = (value: typeof GroupCursor.Type) => {
      const body = Buffer.from(KernelReaderSchema.encode(GroupCursor, value, 1536)).toString("base64url")
      const encoded = `${body}.${cursorMAC("cursor", body)}`
      if (KernelReaderSchema.bytes(encoded) > 2048) throw new IMValidationFailedError({ name: "VALIDATION_FAILED", data: { message: "Invalid group page cursor or limit" } })
      return encoded
    }
    const decodeGroupCursor = (encoded: string, expected: { lane: "ordinary" | "protected"; limit: number; stamp: string }) => Effect.try({ try: () => {
      if (KernelReaderSchema.bytes(encoded) > 2048 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(encoded)) throw new Error("cursor")
      const parts = encoded.split(".")
      if (!timingSafeEqual(Buffer.from(parts[1]!, "hex"), Buffer.from(cursorMAC("cursor", parts[0]!), "hex"))) throw new Error("cursor")
      const bytes = Buffer.from(parts[0]!, "base64url")
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      const value = KernelReaderSchema.decode(GroupCursor, body, 1536)
      if (encodeGroupCursor(value) !== encoded || value.lane !== expected.lane || value.limit !== expected.limit || value.stamp !== expected.stamp || value.expiresAt <= cursorClock() || value.expiresAt > cursorClock() + 600000 || groupPositionBefore(value.upper, value.after)) throw new Error("cursor")
      return value
    }, catch: () => new IMValidationFailedError({ name: "VALIDATION_FAILED", data: { message: "Invalid group page cursor or limit" } }) })

    const readRequest = <A, E, R>(query: Parameters<typeof getWorkspaceContext>[0], groupID: string | undefined, effect: Effect.Effect<A, E, R> | ((lease?: IMFacade.ReaderLease) => Effect.Effect<A, E, R>), localOnUnavailable: boolean | "partial" = false, mediaMutation = false, options?: { refreshBeforeEffect?: boolean }) => Effect.gen(function* () {
      const context = yield* getWorkspaceContext(query)
      const run = (lease?: IMFacade.ReaderLease) => typeof effect === "function" ? effect(lease) : effect
      if (!facade || Option.isNone(yield* Ref.get(facade.engine))) return yield* run()
      const guarded = facade.withReader(context, (lease) => mediaMutation ? run(lease) : lease.reader.withOutput({ workspaceID: context.workspaceID, userID: context.userID, ...(groupID ? { groupIDs: [groupID] } : {}) }, run(lease), options))
      if (localOnUnavailable) return yield* guarded.pipe(Effect.catchIf((error) => error instanceof KernelReaderSchema.Error && (error.code !== "reader_capacity" || localOnUnavailable === "partial"), () => run()), Effect.mapError((error) => error instanceof KernelReaderSchema.Error ? new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: error.code, operation: error.operation, wireCode: error.wireCode, message: error.message } }) : error))
      return yield* guarded.pipe(Effect.mapError((error) => error instanceof KernelReaderSchema.Error ? new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: error.code, operation: error.operation, wireCode: error.wireCode, message: error.message } }) : error))
    })

    const messageResponses = (messages: readonly IMMessage[], lease?: IMFacade.ReaderLease) =>
      Effect.gen(function* () {
        const ids = messages.map((message) => message.id)
        const states = yield* lease ? lease.engine.deliveryStatuses(ids) : repo.kernelDeliveryStatuses(ids)
        return messages.map((message) => ({
          ...toMessageResponse(message),
          ...(states[message.id] ? { transport: states[message.id] } : {}),
        }))
      })

    const dacScope = (query: Parameters<typeof getWorkspaceContext>[0], groupID: string, lease?: IMFacade.ReaderLease) => Effect.gen(function* () {
      const context = yield* getWorkspaceContext(query)
      const actual = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const group = yield* repo.getGroup({ groupID, workspaceID: context.workspaceID, userID: context.userID })
      if (!group) return yield* new IMGroupNotFoundError({ name: "GROUP_NOT_FOUND", data: { message: "Group not found" } })
      if (!dac || group.projectID && group.projectID !== actual.project.id)
        return yield* new IMDacCommandError({ name: "IM_DAC_COMMAND_REJECTED", data: { code: "binding_unavailable" } })
      const base = { ownerID: context.userID, groupID, projectID: actual.project.id, directory: actual.directory, workspaceID: workspaceID ?? null }
      if (!group.kernelConvID) return { ...base, accountKey: "local", executorID: "local", conversationKey: groupID }
      if (!lease || Option.isNone(database)) return yield* new IMDacCommandError({ name: "IM_DAC_COMMAND_REJECTED", data: { code: "binding_unavailable" } })
      const current = yield* KernelReader.pageIdentity(lease.reader.runtime, context)
      const row = yield* database.value.db.select({ scope: IMKernelReaderScopeTable, projection: IMKernelReaderProjectionTable })
        .from(IMKernelReaderProjectionTable).innerJoin(IMKernelReaderScopeTable, eq(IMKernelReaderScopeTable.reader_key, IMKernelReaderProjectionTable.reader_key))
        .where(and(eq(IMKernelReaderProjectionTable.reader_key, current.readerKey), eq(IMKernelReaderProjectionTable.local_group_id, groupID))).get().pipe(Effect.orDie)
      if (!row || !row.projection.target_id || !row.projection.conversation_type || !["visible", "pending"].includes(row.projection.visibility))
        return yield* new IMDacCommandError({ name: "IM_DAC_COMMAND_REJECTED", data: { code: "binding_unavailable" } })
      // A locally opened conversation can precede its first mirrored message.
      // Only the original current-source, owner-created pending mapping qualifies;
      // message references still pass the protected repository's body checks.
      if (row.projection.visibility === "pending") {
        const metadata = yield* Effect.try({ try: () => KernelReaderSchema.decode(KernelReaderSchema.Pending, row.projection.metadata, 4096), catch: () => new IMDacCommandError({ name: "IM_DAC_COMMAND_REJECTED", data: { code: "binding_unavailable" } }) })
        const source = yield* KernelReader.current(lease.reader.runtime)
        const conversation = yield* lease.reader.conversation(groupID)
        const member = yield* database.value.db.select().from(MemberTable).where(and(eq(MemberTable.group_id, GroupID.make(group.id)), eq(MemberTable.member_id, context.userID), eq(MemberTable.member_type, "user"), eq(MemberTable.role, "owner"))).get().pipe(Effect.orDie)
        const bindingKey = KernelReader.hash(["deepagent.im.reader.mapping.v1", current.readerKey, metadata.conversationType, metadata.targetId])
        if (!member || !conversation || group.createdBy !== context.userID || group.projectID !== null || group.type !== (metadata.conversationType === 1 ? "direct" : "project") ||
          group.id !== `img_kr_${bindingKey}` || group.kernelConvID !== `kr1:${bindingKey}` || row.projection.binding_key !== bindingKey ||
          row.projection.projection_key !== null || row.projection.server_revision !== null || row.projection.cursor !== null ||
          row.projection.metadata_hash !== KernelReader.hash(row.projection.metadata) || metadata.sourceHash !== KernelReader.hash(source.source) ||
          metadata.conversationType !== row.projection.conversation_type || metadata.targetId !== row.projection.target_id ||
          conversation.conversationType !== metadata.conversationType || conversation.conversationID !== metadata.targetId)
          return yield* new IMDacCommandError({ name: "IM_DAC_COMMAND_REJECTED", data: { code: "binding_unavailable" } })
      }
      const account = yield* Effect.try({ try: () => KernelReaderSchema.decode(KernelReaderSchema.Binding, row.scope.binding, 8192), catch: () => new IMDacCommandError({ name: "IM_DAC_COMMAND_REJECTED", data: { code: "binding_unavailable" } }) })
      return { ...base, accountKey: createHash("sha256").update(JSON.stringify([account.realm, account.appkey, account.orgID, account.userID])).digest("hex"),
        executorID: account.instanceID, conversationKey: JSON.stringify([row.projection.conversation_type, row.projection.target_id]) }
    })
    const dacError = <A, E, R>(effect: Effect.Effect<A, E | IMDacSessionSchema.Error, R>) => effect.pipe(Effect.mapError((error) => error instanceof IMDacSessionSchema.Error
      ? new IMDacCommandError({ name: "IM_DAC_COMMAND_REJECTED", data: { code: error.code, ...(error.code === "reference_unavailable" ? { admitted: false as const } : {}) } }) : error))

    return handlers
      .handle("deviceInfo", () => activationError(Effect.flatMap(requireActivation, (value) => value.deviceInfo)))
      .handle("migrationPending", () => activationError(Effect.flatMap(requireActivation, (value) => value.migrationPending)))
      .handle("migrationStatus", ({ params }) => activationError(Effect.gen(function* () {
        const result = yield* (yield* requireActivation).migrationStatus(params.migrationID)
        if (result.state === "succeeded" && result.credentialStored && facade) yield* facade.retryExchange.pipe(Effect.ignore)
        return result
      })))
      .handle("migrate", ({ payload }) => activationError(Effect.gen(function* () {
        const result = yield* (yield* requireActivation).migrate(payload)
        if (result.state === "succeeded" && result.credentialStored && facade) yield* facade.retryExchange.pipe(Effect.ignore)
        return result
      })))
      .handle("activationQuote", () => activationError(Effect.flatMap(requireActivation, (value) => value.quote)))
      .handle("activationPending", () => activationError(Effect.flatMap(requireActivation, (value) => value.pending)))
      .handle("activationStatus", ({ params }) => activationError(Effect.gen(function* () {
        return yield* activationReady(yield* (yield* requireActivation).status(params.transactionID))
      })))
      .handle("activate", ({ payload }) => activationError(Effect.gen(function* () {
        return yield* activationReady(yield* (yield* requireActivation).activate(payload))
      })))
      .handle("dacBinding", ({ params, query }) => mapRepositoryError(dacError(readRequest(query, params.groupId, (lease) => Effect.gen(function* () {
        const scope = yield* dacScope(query, params.groupId, lease)
        return yield* dac!.binding(scope)
      })))))
      .handle("dacCommand", ({ params, query }) => mapRepositoryError(dacError(readRequest(query, params.groupId, (lease) => Effect.gen(function* () {
        const scope = yield* dacScope(query, params.groupId, lease)
        return yield* dac!.command(scope, params.commandID)
      })))))
      .handle("dacReplyRetry", ({ params, query }) => mapRepositoryError(dacError(readRequest(query, params.groupId, (lease) => Effect.gen(function* () {
        const scope = yield* dacScope(query, params.groupId, lease)
        return yield* dac!.retryReply(scope, params.commandID)
      })))))
      .handle("dacSubmit", ({ params, query, payload }) => mapRepositoryError(dacError(readRequest(query, params.groupId, (lease) => Effect.gen(function* () {
        const scope = yield* dacScope(query, params.groupId, lease).pipe(Effect.mapError((error) => error instanceof IMDacCommandError
          ? new IMDacCommandError({ name: "IM_DAC_COMMAND_REJECTED", data: { ...error.data, admitted: false } }) : error))
        const references = Effect.gen(function* () {
          const ids = payload.referenceMessageIDs ?? []
          if (new Set(ids).size !== ids.length || ids.some((id) => !Schema.is(MessageID)(id)))
            return yield* new IMDacSessionSchema.Error({ code: "reference_unavailable" })
          const messages = yield* Effect.forEach(ids, (id) => repo.getMessage(id))
          if (messages.some((message) => !message || message.groupID !== params.groupId)) return yield* new IMDacSessionSchema.Error({ code: "reference_unavailable" })
          return messages.flatMap((message) => message ? [{ messageID: message.id, content: message.content }] : [])
        }).pipe(Effect.mapError(() => new IMDacSessionSchema.Error({ code: "reference_unavailable" })))
        const model = (yield* config.get()).im?.model
        return yield* dac!.submit({ ...scope, ...(model ? { model: ConfigIM.modelReference(model) } : {}) }, payload, references)
      })))))
      .handle("listGroupPage", ({ query }) => mapRepositoryError(Effect.gen(function* () {
        const context = yield* getWorkspaceContext(query)
        const lane = query.lane
        const limit = query.limit ?? (lane === "protected" ? 2 : 32)
        if (limit > (lane === "protected" ? 2 : 32)) return yield* new IMValidationFailedError({ name: "VALIDATION_FAILED", data: { message: "Invalid group page cursor or limit" } })
        const db = Option.getOrUndefined(database)?.db
        if (!db) return yield* new IMInternalServerError({ name: "INTERNAL_SERVER_ERROR", data: { message: "Database unavailable" } })
        const page = (lease?: IMFacade.ReaderLease) => Effect.gen(function* () {
          const readerEngine = lease?.reader
          const identity = lane === "protected" ? yield* KernelReader.pageIdentity(readerEngine!.runtime, context).pipe(Effect.mapError((error) => error instanceof KernelReaderSchema.Error ? new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: error.code, operation: error.operation, wireCode: error.wireCode, message: error.message } }) : new IMInternalServerError({ name: "INTERNAL_SERVER_ERROR", data: { message: "Database operation failed" } }))) : undefined
          const stamp = cursorMAC("scope", JSON.stringify([context.workspaceID, context.userID, identity?.stamp ?? "ordinary"]))
          const cursor = query.cursor ? yield* decodeGroupCursor(query.cursor, { lane, limit, stamp }) : undefined
          const candidates = yield* groupPageCandidates(db, { workspaceID: context.workspaceID, userID: context.userID, lane, limit, upper: cursor?.upper, after: cursor?.after, readerKey: identity?.readerKey }).pipe(Effect.mapError((error) => error instanceof KernelReaderSchema.Error ? new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: error.code, operation: error.operation, wireCode: error.wireCode, message: error.message } }) : new IMRepositoryError({ message: "Database operation failed", cause: error })))
          const effect = Effect.gen(function* () {
            const groups = yield* Effect.forEach(candidates.rows, (row) => repo.getGroup({ groupID: row.id, workspaceID: context.workspaceID, userID: context.userID }))
            const reader = lane === "protected" ? yield* KernelReader.groupPageState(db) : undefined
            const after = candidates.rows.at(-1)
            const nextCursor = candidates.hasMore && candidates.upper && after ? encodeGroupCursor({ version: 1, lane, limit, stamp, upper: candidates.upper, after, expiresAt: cursor?.expiresAt ?? cursorClock() + 600000 }) : null
            return { version: 1 as const, lane, groups: groups.filter((group): group is IMGroup => group !== undefined).map(toGroupResponse), hasMore: nextCursor !== null, nextCursor, ...(reader ? { reader } : {}) }
          })
          if (lane === "ordinary") return yield* effect
          return yield* readerEngine!.withOutput({ workspaceID: context.workspaceID, userID: context.userID, groupIDs: candidates.rows.map((row) => row.id) }, effect).pipe(Effect.mapError((error) => error instanceof KernelReaderSchema.Error ? new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: error.code, operation: error.operation, wireCode: error.wireCode, message: error.message } }) : error))
        })
        if (lane === "ordinary") return yield* page()
        if (!facade) return yield* new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable", operation: "group-page", message: "Remote conversation is currently unavailable" } })
        return yield* facade.withReader(context, page).pipe(Effect.mapError((error) => error instanceof KernelReaderSchema.Error ? new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: error.code, operation: error.operation, wireCode: error.wireCode, message: error.message } }) : error))
      })))
      .handle("getGroup", ({ params, query }) => mapRepositoryError(readRequest(query, params.groupId, Effect.gen(function* () {
        const context = yield* getWorkspaceContext(query)
        const group = yield* repo.getGroup({ groupID: params.groupId, workspaceID: context.workspaceID, userID: context.userID })
        if (!group) return yield* new IMGroupNotFoundError({ name: "GROUP_NOT_FOUND", data: { message: "Group not found" } })
        const db = Option.getOrUndefined(database)?.db
        const reader = db ? yield* KernelReader.groupPageState(db) : undefined
        return { version: 1 as const, group: toGroupResponse(group), ...(reader ? { reader } : {}) }
      }), false)))
      .handle("listGroups", ({ query }) =>
        mapRepositoryError(
          readRequest(query, undefined, Effect.gen(function* () {
            const { workspaceID, userID } = yield* getWorkspaceContext(query)

            const groups = yield* repo.listGroups({ workspaceID, userID })

            return groups.map(toGroupResponse)
          }), true),
        ),
      )
      .handle("refreshGroup", ({ params, query }) => mapRepositoryError(Effect.gen(function* () {
        const context = yield* getWorkspaceContext(query)
        if (!facade) return yield* new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable", operation: "group-name", message: "Remote conversation is currently unavailable" } })
        return yield* facade.withReader(context, (lease) => Effect.gen(function* () {
          yield* lease.reader.refreshGroup(params.groupId)
          return yield* lease.reader.withOutput({ workspaceID: context.workspaceID, userID: context.userID, groupIDs: [params.groupId] }, Effect.gen(function* () {
            const group = yield* repo.getGroup({ groupID: params.groupId, workspaceID: context.workspaceID, userID: context.userID })
            if (!group) return yield* new IMGroupNotFoundError({ name: "GROUP_NOT_FOUND", data: { message: "Group not found" } })
            const db = Option.getOrUndefined(database)?.db
            const reader = db ? yield* KernelReader.groupPageState(db) : undefined
            return { version: 1 as const, group: toGroupResponse(group), ...(reader ? { reader } : {}) }
          }))
        })).pipe(Effect.mapError((error) => error instanceof KernelReaderSchema.Error ? new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: error.code, operation: error.operation, wireCode: error.wireCode, message: error.message } }) : error))
      })))
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
          readRequest(query, params.groupId, (lease) => Effect.gen(function* () {
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

            const limit = clampLimit(query.limit)
            const page = yield* repo.listMessages({
              groupID: groupId,
              cursor: query.cursor,
              limit,
            })

            return {
              messages: yield* messageResponses(page.messages, lease),
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
              ...(page.reader ? { reader: page.reader } : {}),
              ...(page.protectedUnavailable ? { protectedUnavailable: true } : {}),
            }
          }), false),
        ),
      )
      .handle("createMessage", ({ params, query, payload }) =>
        mapRepositoryError(
          readRequest(query, params.groupId, (lease) => Effect.gen(function* () {
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
            if (payload.type === "file" && lease) {
              const ids = payload.attachmentIDs ?? (payload.attachmentID !== undefined ? [payload.attachmentID] : [])
              yield* IMMedia.enabled(flags.v4FileUploadEnabled)
              if (!payload.clientRequestID || !ids.length || ids.length>4 || new Set(ids).size!==ids.length || payload.attachmentID!==undefined&&payload.attachmentIDs!==undefined || payload.metadata || !lease.engine.prepareMediaContinuation) return yield* new IMValidationFailedError({name:"VALIDATION_FAILED",data:{message:"A file message requires original ordered attachments and clientRequestID"}})
              yield* lease.engine.prepareMediaContinuation({messageID:clientMessageID(userID,payload.clientRequestID),clientRequestID:payload.clientRequestID,groupID:groupId,senderID:userID,content:payload.content,replyToID:payload.replyToID,attachmentIDs:ids,batch:payload.attachmentIDs!==undefined}).pipe(Effect.mapError((error)=>error.code === "message_identity_conflict" ? new IMMessageIdentityConflictError({name:"MESSAGE_IDENTITY_CONFLICT",data:{message:error.message}}) : new IMReaderUnavailableError({name:"IM_READER_UNAVAILABLE",data:{code:"reader_unavailable",operation:"media-continuation",message:error.message}})))
            }
            const originalLookup = payload.clientRequestID ? repo.getMessage(clientMessageID(userID, payload.clientRequestID)) : Effect.succeed(undefined)
            const original = yield* payload.type === "file" && lease ? lease.reader.withOutput({ workspaceID, userID, groupIDs: [groupId] }, originalLookup) : originalLookup
            if (!original && !rateLimiter.check(rateLimitKey, rateLimit, 60 * 1000)) {
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
            const groupLookup = repo.getGroup({ groupID: groupId, workspaceID, userID })
            const group = yield* payload.type === "file" && lease ? lease.reader.withOutput({ workspaceID, userID, groupIDs: [groupId] }, groupLookup) : groupLookup
            if (!group) {
              return yield* Effect.fail(
                new IMGroupNotFoundError({
                  name: "GROUP_NOT_FOUND",
                  data: { message: `Group ${groupId} not found` },
                }),
              )
            }

            const attachmentIDs = payload.attachmentIDs ?? (payload.attachmentID !== undefined ? [payload.attachmentID] : [])
            if (payload.type === "file" || payload.attachmentID !== undefined || payload.attachmentIDs !== undefined || payload.metadata?.type === "attachment_ref") {
              yield* IMMedia.enabled(flags.v4FileUploadEnabled)
              if (payload.type !== "file" || !attachmentIDs.length || attachmentIDs.length > 4 || new Set(attachmentIDs).size !== attachmentIDs.length || payload.attachmentID !== undefined && payload.attachmentIDs !== undefined || !payload.clientRequestID || payload.metadata) {
                return yield* new IMValidationFailedError({
                  name: "VALIDATION_FAILED",
                  data: { message: "A file message requires one to four unique attachments and clientRequestID; metadata is server-owned." },
                })
              }
              yield* IMMedia.cleanup(repo, workspaceID)
            }
            const attachmentLookup = Effect.forEach(attachmentIDs, (id) => IMMedia.attachment(repo, {
                  id,
                  workspaceID,
                  userID,
                  bound: false,
                }, lease))
            const attachments = yield* payload.type === "file" && lease ? lease.reader.withOutput({ workspaceID, userID, groupIDs: [groupId] }, attachmentLookup) : attachmentLookup
            if (attachments.some((attachment) => attachment.groupID !== groupId)) return yield* IMMedia.unavailable()
            // A record is committed before bytes are written; do not bind an incomplete upload.
            if (!group.kernelConvID) yield* Effect.forEach(attachments, IMMedia.read, { discard: true })

            // Parse mentions from content
            const mentionedAgentNames = payload.type === "text" ? MentionParser.parse(payload.content) : []


            // Create message.
            // Force senderType to "user" — this endpoint is authenticated as a user,
            // so we must not trust the client-supplied senderType (which would let a
            // user forge "system"/"agent" messages that the UI renders specially).
            const deliveryEngine = lease?.engine
            if (lease) yield* lease.assertCurrent
            const message = yield* (deliveryEngine?.createMessage ?? repo.createMessage)({
                groupID: groupId,
                clientRequestID: payload.clientRequestID,
                attachment: payload.attachmentID !== undefined && attachments[0] ? { id: attachments[0].id, workspaceID, expected: attachments[0] } : undefined,
                attachments: payload.attachmentIDs !== undefined ? attachments.map((attachment) => ({ id: attachment.id, workspaceID, expected: attachment })) : undefined,
                senderID: userID,
                senderType: "user",
                type: payload.type,
                content: payload.attachmentID !== undefined && attachments[0] ? attachments[0].filename : payload.content,
                mentions: mentionedAgentNames, // Use parsed mentions
                metadata: payload.attachmentIDs !== undefined ? attachments.map((attachment) => ({ type: "attachment_ref" as const, attachmentID: attachment.id, batch: true as const })) : attachments[0] ? { type: "attachment_ref", attachmentID: attachments[0].id } : payload.metadata,
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
                    return yield* Effect.fail(
                      error.code === "message_identity_conflict"
                        ? new IMMessageIdentityConflictError({ name: "MESSAGE_IDENTITY_CONFLICT", data: { message: error.message } })
                        : error.code === "kernel_delivery_unavailable"
                          ? new IMValidationFailedError({ name: "VALIDATION_FAILED", data: { message: error.message } })
                        : error.code === "attachment_unavailable"
                          ? IMMedia.unavailable()
                          : error,
                    )
                  }),
                ),
              )

            // ── IM-kernel (B1/B2): forward the locally persisted text to the kernel ────────────────
            // Best-effort and non-blocking: the local row IS the authoritative copy (design §2);
            // the sync engine owns the kernel send, ack write-back (kernel_msg_id), and pending
            // retry. B1 kernel path is text-only; other types stay purely local. The engine is owned
            // by the facade (B2) and read fresh per send — claim/retry hot-starts must not leave a
            // stale None captured in this long-lived handler layer.
            if (!message.replayed && (payload.type === "text" || payload.type === "file") && deliveryEngine)
              yield* deliveryEngine.send({ groupID: groupId, messageID: message.id, content: payload.content })



            const response = messageResponses([message], lease)
            return (yield* payload.type === "file" && lease ? lease.reader.withOutput({ workspaceID, userID, groupIDs: [groupId] }, response) : response)[0]!
          }), false, payload.type === "file", { refreshBeforeEffect: payload.type === "text" }),
        ),
      )
      .handle("markRead", ({ params, query, payload }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const context = yield* getWorkspaceContext(query)
            const userID = context.userID
            const groupId = params.groupId
            const perform = (lease?: IMFacade.ReaderLease) => Effect.gen(function* () {
              // Check if group exists
              const lookup = repo.getGroup({ groupID: groupId, workspaceID: context.workspaceID, userID })
              const group = yield* lease ? lease.reader.withOutput({ workspaceID: context.workspaceID, userID, groupIDs: [groupId] }, lookup) : lookup
              if (!group) {
                return yield* Effect.fail(
                  new IMGroupNotFoundError({
                    name: "GROUP_NOT_FOUND",
                    data: { message: `Group ${groupId} not found` },
                  }),
                )
              }

              if (group.reader) {
                if (!lease) return yield* new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable", operation: "read", message: "Remote conversation is currently unavailable" } })
                yield* lease.assertCurrent
                return yield* lease.reader.read({ groupID: groupId, actionID: payload.actionID, reconcile: payload.reconcile, continue: payload.continue, cancel: payload.cancel, newAction: payload.newAction }).pipe(Effect.mapError((error) => new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: error instanceof KernelReaderSchema.Error ? error.code : "reader_unavailable", operation: error instanceof KernelReaderSchema.Error ? error.operation : "read", wireCode: error instanceof KernelReaderSchema.Error ? error.wireCode : undefined, message: "Remote conversation is currently unavailable" } })))
              }
              const readAt = payload.readAt ?? Date.now()
              yield* repo.markRead({
                groupID: groupId,
                memberID: userID,
                readAt,
              })

              return { ok: true }
            })
            if (!facade || Option.isNone(yield* Ref.get(facade.engine))) return yield* perform()
            return yield* facade.withReader(context, perform).pipe(Effect.mapError((error) => error instanceof KernelReaderSchema.Error ? new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: error.code, operation: error.operation, wireCode: error.wireCode, message: error.message } }) : error))
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
            const context = yield* getWorkspaceContext(query)
            const db = Option.getOrUndefined(database)?.db
            if (!db) return yield* new IMInternalServerError({ name: "INTERNAL_SERVER_ERROR", data: { message: "Database unavailable" } })
            const identity = yield* KernelReader.messageGroup(db, { messageID: params.messageId, workspaceID: context.workspaceID, userID: context.userID }).pipe(Effect.mapError((error) => new IMRepositoryError({ message: "Database operation failed", cause: error })))
            if (!identity) return yield* new IMMessageNotFoundError({ name: "MESSAGE_NOT_FOUND", data: { message: "Message not found" } })
            return yield* readRequest(query, identity.groupID, (lease) => Effect.gen(function* () {
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

            return (yield* messageResponses([message], lease))[0]!
            }), false)
          }),
        ),
      )
      .handle("listThread", ({ params, query }) =>
        mapRepositoryError(
          readRequest(query, params.groupId, (lease) => Effect.gen(function* () {
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
              messages: yield* messageResponses(page.messages, lease),
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
              ...(page.reader ? { reader: page.reader } : {}),
              ...(page.protectedUnavailable ? { protectedUnavailable: true } : {}),
            }
          }), false),
        ),
      )
      .handle("search", ({ query }) =>
        mapRepositoryError(
          readRequest(query, query.groupId, (lease) => Effect.gen(function* () {
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
              messages: yield* messageResponses(page.messages, lease),
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
              ...(page.reader ? { reader: page.reader } : {}),
              ...(page.protectedUnavailable ? { protectedUnavailable: true } : {}),
            }
          }), query.groupId ? false : "partial"),
        ),
      )
      .handleRaw("uploadAttachment", ({ request }) =>
          mapRepositoryError(
            IMMedia.transfer(
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

                const parts = yield* request.multipart.pipe(
                  Effect.provideContext(
                    Multipart.limitsServices({
                      maxFileSize: AttachmentStorage.maxAttachmentBytes(),
                      maxTotalSize: AttachmentStorage.maxAttachmentBytes() + 8192,
                      maxParts: 3,
                    }),
                  ),
                  Effect.mapError((error) =>
                    ["FileTooLarge", "BodyTooLarge"].includes(error.reason._tag)
                      ? new IMFileTooLargeError({
                          name: "FILE_TOO_LARGE",
                          data: {
                            message: "Attachment exceeds the upload limit.",
                            maxBytes: AttachmentStorage.maxAttachmentBytes(),
                          },
                        })
                      : new IMValidationFailedError({
                          name: "VALIDATION_FAILED",
                          data: { message: "Invalid multipart attachment." },
                        }),
                  ),
                )
                const payload = yield* Schema.decodeUnknownEffect(UploadAttachmentPayload)(parts).pipe(
                  Effect.mapError(
                    () =>
                      new IMValidationFailedError({
                        name: "VALIDATION_FAILED",
                        data: { message: "Expected one file attachment." },
                      }),
                  ),
                )
                const context = yield* getWorkspaceContext()
                const { workspaceID, userID } = context
                const file = payload.file

                if (!payload.groupId || payload.messageId)
                  return yield* new IMValidationFailedError({
                    name: "VALIDATION_FAILED",
                    data: { message: "Upload to a local group, then bind using a file message." },
                  })
                const protectedGroup = (yield* repo.getGroupByID(payload.groupId))?.kernelConvID
                const lease =
                  protectedGroup && facade && Option.isSome(yield* Ref.get(facade.engine))
                    ? yield* facade.acquireReader(context).pipe(Effect.mapError(() => IMMedia.unavailable()))
                    : undefined
                const membership = IMMedia.group(repo, { groupID: payload.groupId, workspaceID, userID }, lease)
                yield* lease
                  ? lease.reader
                      .withOutput({ workspaceID, userID, groupIDs: [payload.groupId] }, membership)
                      .pipe(Effect.mapError(() => IMMedia.unavailable()))
                  : membership
                if (protectedGroup) {
                  if (!lease?.engine.media) return yield* IMMedia.unavailable()
                  yield* lease.engine.media.capabilities().pipe(Effect.mapError(() => IMMedia.unavailable()))
                  yield* lease.assertCurrent.pipe(Effect.mapError(() => IMMedia.unavailable()))
                }
                const cleanup = yield* IMMedia.cleanup(repo, workspaceID)

                // If the upload is scoped to a group, the caller must be a member (membership + IDOR guard).
                if (payload.groupId) {
                  const lookup = repo.getGroup({ groupID: payload.groupId, workspaceID, userID })
                  const group = yield* lease
                    ? lease.reader
                        .withOutput({ workspaceID, userID, groupIDs: [payload.groupId] }, lookup)
                        .pipe(Effect.mapError(() => IMMedia.unavailable()))
                    : lookup
                  if (!group) {
                    return yield* Effect.fail(
                      new IMGroupNotFoundError({
                        name: "GROUP_NOT_FOUND",
                        data: { message: `Group ${payload.groupId} not found` },
                      }),
                    )
                  }
                }

                const validated = yield* IMMedia.stagedFile({ path: file.path, mime: file.contentType })

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

                // Persist the cleanup owner first. A crash during the file write leaves a tracked,
                // unbound record whose fixed TTL permits later cleanup, never an untracked file.
                if (lease && !lease.engine.createAttachment) return yield* IMMedia.unavailable()
                const attachment = yield* (lease?.engine.createAttachment ?? repo.createAttachment)({
                  id: attachmentId,
                  workspaceID,
                  groupID: payload.groupId,
                  messageID: payload.messageId,
                  uploadedBy: userID,
                  storagePath: derived.storagePath,
                  // Keep the original filename for display/download; it is never used to build a path.
                  filename: Array.from((file.name || "upload").replace(/[\x00-\x1f\x7f/\\]/g, "_"))
                    .slice(0, 255)
                    .join(""),
                  mime: validated.mime,
                  sizeBytes: validated.sizeBytes,
                  checksum: validated.checksum,
                })

                yield* validated.copy(attachment)
                if (!lease) yield* IMMedia.group(repo, { groupID: payload.groupId, workspaceID, userID })

                if (lease)
                  yield* lease.reader
                    .withOutput(
                      { workspaceID, userID, groupIDs: [payload.groupId] },
                      IMMedia.group(repo, { groupID: payload.groupId, workspaceID, userID }, lease),
                    )
                    .pipe(Effect.mapError(() => IMMedia.unavailable()))

                return HttpServerResponse.jsonUnsafe(toAttachmentResponse(attachment), {
                  headers: { "cache-control": "no-store", "x-im-media-cleanup": cleanup.state, "access-control-expose-headers": "X-IM-Media-Cleanup" },
                })
              }).pipe(Effect.scoped),
            ),
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

            const groupID =
              query.groupId ?? (query.messageId ? (yield* repo.getMessage(query.messageId))?.groupID : undefined)
            if (!groupID)
              return yield* new IMValidationFailedError({
                name: "VALIDATION_FAILED",
                data: { message: "A group or message is required." },
              })
            yield* IMMedia.group(repo, { groupID, workspaceID, userID })
            const records = yield* repo.listAttachments({
              workspaceID,
              groupID,
              messageID: query.messageId,
              limit: clampLimit(query.limit),
            })
            const attachments: IMAttachment[] = []
            for (const item of records) {
              if (AttachmentStorage.expiresAt(item.createdAt) <= Date.now()) continue
              if (!item.messageID && item.uploadedBy === userID) {
                attachments.push(item)
                continue
              }
              const allowed = yield* IMMedia.attachment(repo, { id: item.id, workspaceID, userID }).pipe(Effect.option)
              if (Option.isSome(allowed)) attachments.push(allowed.value)
            }

            return attachments.map(toAttachmentResponse)
          }),
        ),
      )
      .handle("getAttachment", ({ params, query }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            yield* IMMedia.enabled(flags.v4FileUploadEnabled)
            const context = yield* getWorkspaceContext(query)
            const attachment = yield* IMMedia.attachment(repo, { ...context, id: params.attachmentId })
            return toAttachmentResponse(attachment)
          }),
        ),
      )
      .handleRaw("downloadAttachment", ({ params }) =>
          mapRepositoryError(
            Effect.gen(function* () {
              yield* IMMedia.enabled(flags.v4FileUploadEnabled)
              const context = yield* getWorkspaceContext()
              const attachment = yield* IMMedia.attachment(repo, { ...context, id: params.attachmentId })
              const body = IMMedia.localStream(repo, { ...context, id: params.attachmentId }, attachment)
              // Finish the bounded FD, permission and hash checks before sending success headers.
              // The cold stream opens a fresh guarded FD again while delivering the response.
              yield* IMMedia.transfer(Stream.runDrain(body))
              return HttpServerResponse.stream(
                body,
                {
                  contentType: AttachmentStorage.isPreviewMime(attachment.mime)
                    ? attachment.mime
                    : "application/octet-stream",
                  headers: {
                    "cache-control": "no-store",
                    "x-content-type-options": "nosniff",
                    "content-security-policy": "default-src 'none'; sandbox",
                    "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(attachment.filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
                  },
                },
              )
            }),
          ),
        )
      .handle("getRemoteAttachment", ({ params, query }) => mapRepositoryError(Effect.gen(function* () {
        yield* IMMedia.enabled(flags.v4FileUploadEnabled)
        const context = yield* getWorkspaceContext(query)
        if (!facade) return yield* IMMedia.unavailable()
        return yield* facade.withReader(context, (lease) => IMMedia.remoteAttachment(repo, lease, { ...context, groupID: params.groupId, messageID: params.messageId, attachmentID: params.attachmentId })).pipe(Effect.mapError(() => IMMedia.unavailable()))
      })))
      .handleRaw("downloadRemoteAttachment", ({ params, query }) => mapRepositoryError(Effect.gen(function* () {
        yield* IMMedia.enabled(flags.v4FileUploadEnabled)
        const context = yield* getWorkspaceContext(query)
        if (!facade) return yield* IMMedia.unavailable()
        const input = { ...context, groupID: params.groupId, messageID: params.messageId, attachmentID: params.attachmentId }
        const admitted = yield* facade.withReader(context, (lease) => IMMedia.remoteAttachment(repo, lease, input).pipe(Effect.map((descriptor) => ({ descriptor, displayEpoch: lease.reader.runtime.displayEpoch })))).pipe(Effect.mapError(() => IMMedia.unavailable()))
        const services = yield* Effect.context<never>()
        const body = Stream.unwrap(Effect.gen(function* () {
          const lease = yield* facade.acquireReader(context).pipe(Effect.mapError(() => IMMedia.unavailable()))
          if (lease.reader.runtime.displayEpoch !== admitted.displayEpoch) return yield* IMMedia.unavailable()
          const abort = yield* Effect.acquireRelease(Effect.sync(() => new AbortController()), (controller) => Effect.sync(() => controller.abort()))
          return IMMedia.remoteStream(repo, lease, input, admitted.descriptor, abort.signal)
        })).pipe(Stream.provideContext(services))
        return HttpServerResponse.stream(body, { contentType: AttachmentStorage.isPreviewMime(admitted.descriptor.mime) ? admitted.descriptor.mime : "application/octet-stream", headers: {
          "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
          "access-control-expose-headers": "X-Content-Type-Options, Content-Length",
          "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(admitted.descriptor.filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
        } })
      })))
      // ── B2 门面端点 ─────────────────────────────────────────────────────────────────
      // facade 服务缺席（图层未挂 IMFacade）⇒ status 返回 disabled 快照，mutation 一律
      // im_unavailable（与门面自身 fail-closed 语义一致）。ExchangeError 按状态归桶透传 code。
      .handle("facadeStatus", ({ query }) =>
        Effect.gen(function* () {
          const context = yield* getWorkspaceContext(query)
          const viewer = { memberID: context.userID }
          const media = Schema.decodeUnknownSync(MediaBatch.Policy)({ version: 2, enabled: flags.v4FileUploadEnabled, multipleAttachments: true, maxAttachments: 4, maxAttachmentBytes: AttachmentStorage.maxAttachmentBytes(), ttlMs: AttachmentStorage.ttlMs() })
          if (!facade) return { facade: "disabled" as const, identity: null, blocked: null, kernel: null, keyOrigin: "none" as const, viewer, media }
          const snapshot = yield* facade.status.pipe(Effect.mapError((error) => new IMReaderUnavailableError({ name: "IM_READER_UNAVAILABLE", data: { code: error.code, operation: error.operation, wireCode: error.wireCode, message: "Remote conversation is currently unavailable" } })))
          return {
            facade: snapshot.facade,
            identity: Option.getOrNull(snapshot.identity),
            blocked: Option.getOrNull(snapshot.blocked),
            kernel: Option.getOrNull(snapshot.kernel),
            keyOrigin: snapshot.keyOrigin,
            recovery: snapshot.recovery,
            reader: snapshot.reader,
            viewer,
            media,
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
      .handle("facadeRetry", ({ query }) =>
        Effect.gen(function* () {
          if (!facade) return yield* facadeUnavailable("IM facade is not configured on this server")
          const identity = yield* facade.retryExchange
          yield* Effect.gen(function* () {
            const context = yield* getWorkspaceContext(query)
            yield* facade.withCurrentConnectedReader(context, (lease) => lease.reader.refreshPending())
          }).pipe(Effect.mapError(() => facadeUnavailable("IM conversation recovery is currently unavailable")))
          return identity
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
