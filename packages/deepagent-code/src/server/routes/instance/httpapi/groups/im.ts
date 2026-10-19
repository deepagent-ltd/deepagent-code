import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Multipart } from "effect/unstable/http"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { MediaBatch } from "@deepagent-code/core/im/media-batch"
import { MessageMetadata } from "@deepagent-code/core/im/sql"
import { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { IMGroup, MessagePage } from "@deepagent-code/core/im/repository"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"
import { IMActivationSchema } from "@deepagent-code/core/im/activation.schema"
import { IMDeviceSchema } from "@deepagent-code/core/im/device.schema"
import { ConfigIM } from "@deepagent-code/core/config/im"

const root = "/api/v1/im"

export class IMDacCommandError extends Schema.ErrorClass<IMDacCommandError>("IMDacCommandError")(
  {
    name: Schema.Literal("IM_DAC_COMMAND_REJECTED"),
    data: Schema.Struct({ code: Schema.String, admitted: Schema.optional(Schema.Literal(false)) }),
  },
  { httpApiStatus: 409 },
) {}

// Error classes
export class IMGroupNotFoundError extends Schema.ErrorClass<IMGroupNotFoundError>("IMGroupNotFoundError")(
  {
    name: Schema.Literal("GROUP_NOT_FOUND"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class IMMessageNotFoundError extends Schema.ErrorClass<IMMessageNotFoundError>("IMMessageNotFoundError")(
  {
    name: Schema.Literal("MESSAGE_NOT_FOUND"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class IMMessageIdentityConflictError extends Schema.ErrorClass<IMMessageIdentityConflictError>(
  "IMMessageIdentityConflictError",
)(
  {
    name: Schema.Literal("MESSAGE_IDENTITY_CONFLICT"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 409 },
) {}

export class IMMessageTooLargeError extends Schema.ErrorClass<IMMessageTooLargeError>("IMMessageTooLargeError")(
  {
    name: Schema.Literal("MESSAGE_TOO_LARGE"),
    data: Schema.Struct({
      message: Schema.String,
      maxLength: Schema.Number,
    }),
  },
  { httpApiStatus: 413 },
) {}

export class IMRateLimitExceededError extends Schema.ErrorClass<IMRateLimitExceededError>("IMRateLimitExceededError")(
  {
    name: Schema.Literal("RATE_LIMIT_EXCEEDED"),
    data: Schema.Struct({
      message: Schema.String,
      retryAfter: Schema.optional(Schema.Number),
    }),
  },
  { httpApiStatus: 429 },
) {}

export class IMAgentNotFoundError extends Schema.ErrorClass<IMAgentNotFoundError>("IMAgentNotFoundError")(
  {
    name: Schema.Literal("AGENT_NOT_FOUND"),
    data: Schema.Struct({
      message: Schema.String,
      agentId: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export class IMPermissionDeniedError extends Schema.ErrorClass<IMPermissionDeniedError>("IMPermissionDeniedError")(
  {
    name: Schema.Literal("PERMISSION_DENIED"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 403 },
) {}

export class IMValidationFailedError extends Schema.ErrorClass<IMValidationFailedError>("IMValidationFailedError")(
  {
    name: Schema.Literal("VALIDATION_FAILED"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export class IMInternalServerError extends Schema.ErrorClass<IMInternalServerError>("IMInternalServerError")(
  {
    name: Schema.Literal("INTERNAL_SERVER_ERROR"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 500 },
) {}
export class IMReaderUnavailableError extends Schema.ErrorClass<IMReaderUnavailableError>("IMReaderUnavailableError")(
  {
    name: Schema.Literal("IM_READER_UNAVAILABLE"),
    data: Schema.Struct({
      code: KernelReaderSchema.Code,
      operation: Schema.String,
      wireCode: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
      message: Schema.String,
    }),
  },
  { httpApiStatus: 503 },
) {}

// Request/Response schemas
export const IMGroupResponse = Schema.Struct({
  reader: IMGroup.fields.reader,
  id: Schema.String,
  workspaceID: Schema.String,
  projectID: Schema.NullOr(Schema.String),
  type: Schema.String,
  name: Schema.String,
  createdBy: Schema.String,
  // B2：k:<type>:<id> 内核会话绑定（1=私聊 2=内核群）；GUI 用它区分全员群/内核群/纯本地群。
  kernelConvID: Schema.NullOr(Schema.String),
  createdAt: KernelReaderSchema.Time,
  updatedAt: KernelReaderSchema.Time,
})

export const CreateGroupPayload = Schema.Struct({
  name: Schema.String,
  // V4.0 §B3 — "direct" for private 1:1 groups (see DirectMemberInput / the createGroup handler).
  type: Schema.Literals(["project", "system", "direct"]),
  projectID: Schema.optional(Schema.String),
  // §B3 私聊 — for a "direct" group, the counterparty (the other participant). The creator (server user)
  // is always the first participant; this names the second. Required when type === "direct", ignored
  // otherwise. memberType selects a user↔user or user↔agent direct chat.
  member: Schema.optional(
    Schema.Struct({
      memberID: Schema.String,
      memberType: Schema.Literals(["user", "agent"]),
    }),
  ),
})

export const ListGroupPageQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  lane: Schema.Literals(["ordinary", "protected"]),
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 32 }))),
  cursor: Schema.optional(KernelReaderSchema.text(2048)),
})
export const GroupPageResponse = Schema.Struct({
  version: Schema.Literal(1),
  lane: Schema.Literals(["ordinary", "protected"]),
  groups: Schema.Array(IMGroupResponse),
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
  reader: Schema.optional(KernelReaderSchema.GroupPageReader),
})
export const GroupDetailResponse = Schema.Struct({
  version: Schema.Literal(1),
  group: IMGroupResponse,
  reader: Schema.optional(KernelReaderSchema.GroupPageReader),
})

export const IMMessageResponse = Schema.Struct({
  remoteAttachments: Schema.optional(Schema.Array(KernelReaderSchema.RemoteAttachment)),
  transport: Schema.optional(
    Schema.Struct({
      state: Schema.Literals(["prepared", "acknowledged", "unknown"]),
      reason: Schema.optional(Schema.String),
    }),
  ),
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
})

export const MessagePageResponse = Schema.Struct({
  reader: MessagePage.fields.reader,
  protectedUnavailable: MessagePage.fields.protectedUnavailable,
  messages: Schema.Array(IMMessageResponse),
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
})

export const CreateMessagePayload = Schema.Struct({
  attachmentID: Schema.optional(Schema.String),
  attachmentIDs: Schema.optional(
    Schema.Array(
      Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(512),
        Schema.makeFilter((value) => !value.includes("\u0000") && Buffer.byteLength(value) <= 512),
      ),
    ).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4),
      Schema.makeFilter((value) => new Set(value).size === value.length),
    ),
  ),
  clientRequestID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  senderType: Schema.Literals(["user", "agent", "system"]),
  type: Schema.Literals(["text", "code", "file", "agent_status", "system"]),
  content: Schema.String,
  mentions: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(MessageMetadata),
  replyToID: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter(
    (value) =>
      !(value.attachmentID !== undefined && value.attachmentIDs !== undefined) &&
      (value.attachmentIDs === undefined || (value.type === "file" && value.clientRequestID !== undefined)),
  ),
)

export const MarkReadPayload = Schema.Struct({
  readAt: Schema.optional(Schema.Number),
  actionID: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))),
  reconcile: Schema.optional(Schema.Boolean),
  continue: Schema.optional(Schema.Boolean),
  cancel: Schema.optional(Schema.Boolean),
  newAction: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (value) =>
      [value.reconcile, value.continue, value.cancel, value.newAction].filter(Boolean).length <= 1 &&
      (!(value.reconcile || value.continue || value.cancel || value.newAction) || value.actionID !== undefined),
  ),
)
export const MarkReadResponse = Schema.Struct({
  ok: Schema.Boolean,
  reader: Schema.optional(
    Schema.Struct({
      actionID: Schema.String,
      state: Schema.Literals(["confirmed", "partial", "unknown", "cancelled"]),
      targetAdmitted: Schema.String,
      readOrdinal: Schema.String,
      liveUnread: Schema.String,
    }),
  ),
})

// HTTP wire shape for an agent descriptor. Converged onto the canonical
// `AgentDescriptor` schema (V3.8.1 §C.3 / conflict C6) so the new optional
// metadata fields serialize on the wire without a second definition drifting.
// The canonical schema is plain Structs/Literals/Records — fully serializable.
export const AgentDescriptorResponse = AgentDescriptor

// Query params
export const ListMessagesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  cursor: Schema.optional(Schema.String),
  anchorID: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})

// §B3 Thread — replies to a parent message, keyset paginated (composite created_at,id cursor).
export const ThreadQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})

// §B3 搜索 — full-text + metadata search. `q` is the FTS/LIKE query; the rest are optional filters.
export const SearchQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  q: Schema.String,
  groupId: Schema.optional(Schema.String),
  senderType: Schema.optional(Schema.Literals(["user", "agent", "system"])),
  type: Schema.optional(Schema.Literals(["text", "code", "file", "agent_status", "system"])),
  // Matches metadata.type via json_extract (e.g. "code_ref", "file_ref").
  metadataType: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})

// §B3 文件 — attachment upload response + listing.
export const IMAttachmentResponse = Schema.Struct({
  id: Schema.String,
  workspaceID: Schema.String,
  projectID: Schema.NullOr(Schema.String),
  groupID: Schema.NullOr(Schema.String),
  messageID: Schema.NullOr(Schema.String),
  uploadedBy: Schema.String,
  filename: Schema.String,
  mime: Schema.String,
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  checksum: Schema.String,
  createdAt: Schema.Finite,
  expiresAt: Schema.Finite,
  preview: Schema.Boolean,
})

export const ListAttachmentsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  groupId: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})

// §B3 文件 — 50MB default upload cap (configurable via IM_MAX_ATTACHMENT_BYTES). Single source of truth
// is the pure AttachmentStorage core; the multipart parser caps here and the handler re-checks the
// persisted bytes (defense in depth).
export const IM_MAX_ATTACHMENT_BYTES = AttachmentStorage.maxAttachmentBytes()

// Local gray media requires a group; messageId remains decodable only to reject the old bypass explicitly.
export const UploadAttachmentPayload = Schema.Struct({
  file: Multipart.SingleFileSchema,
  groupId: Schema.String,
  messageId: Schema.optional(Schema.String),
}).pipe(HttpApiSchema.asMultipart({ maxFileSize: IM_MAX_ATTACHMENT_BYTES }))

export class IMFileUploadDisabledError extends Schema.ErrorClass<IMFileUploadDisabledError>(
  "IMFileUploadDisabledError",
)(
  {
    name: Schema.Literal("FILE_UPLOAD_DISABLED"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class IMAttachmentNotFoundError extends Schema.ErrorClass<IMAttachmentNotFoundError>(
  "IMAttachmentNotFoundError",
)(
  {
    name: Schema.Literal("ATTACHMENT_UNAVAILABLE"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 404 },
) {}

// §B3 threads — fail-closed error when the v4ThreadEnabled flag is off, mirroring IMFileUploadDisabledError
// (404: the endpoint does not exist for the caller). Keeps thread gating consistent with the upload gate.
export class IMThreadDisabledError extends Schema.ErrorClass<IMThreadDisabledError>("IMThreadDisabledError")(
  {
    name: Schema.Literal("THREAD_DISABLED"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class IMFileTooLargeError extends Schema.ErrorClass<IMFileTooLargeError>("IMFileTooLargeError")(
  {
    name: Schema.Literal("FILE_TOO_LARGE"),
    data: Schema.Struct({
      message: Schema.String,
      maxBytes: Schema.Number,
    }),
  },
  { httpApiStatus: 413 },
) {}

export class IMUnsupportedMediaTypeError extends Schema.ErrorClass<IMUnsupportedMediaTypeError>(
  "IMUnsupportedMediaTypeError",
)(
  {
    name: Schema.Literal("UNSUPPORTED_MEDIA_TYPE"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 415 },
) {}

// ── B2 门面端点（/api/v1/im/facade/* + status）───────────────────────────────────────────────
// 门面业务码逐码透传：错误体 data.code 即 new-api 的 imError code（或客户端侧分类
// transport_error/invalid_response/invalid_request），HTTP 状态按 core facadeErrorStatus 归桶
// （一类一态：Schema.ErrorClass 的状态是类级常量）。GUI 按 code 出文案，不得笼统报错。

const facadeErrorData = Schema.Struct({ code: Schema.String, message: Schema.String })

export class IMFacadeBadRequestError extends Schema.ErrorClass<IMFacadeBadRequestError>("IMFacadeBadRequestError")(
  { name: Schema.Literal("IM_FACADE_BAD_REQUEST"), data: facadeErrorData },
  { httpApiStatus: 400 },
) {}

export class IMFacadeForbiddenError extends Schema.ErrorClass<IMFacadeForbiddenError>("IMFacadeForbiddenError")(
  { name: Schema.Literal("IM_FACADE_FORBIDDEN"), data: facadeErrorData },
  { httpApiStatus: 403 },
) {}

export class IMFacadeNotFoundError extends Schema.ErrorClass<IMFacadeNotFoundError>("IMFacadeNotFoundError")(
  { name: Schema.Literal("IM_FACADE_NOT_FOUND"), data: facadeErrorData },
  { httpApiStatus: 404 },
) {}

export class IMFacadeConflictError extends Schema.ErrorClass<IMFacadeConflictError>("IMFacadeConflictError")(
  { name: Schema.Literal("IM_FACADE_CONFLICT"), data: facadeErrorData },
  { httpApiStatus: 409 },
) {}

export class IMFacadeUnavailableError extends Schema.ErrorClass<IMFacadeUnavailableError>("IMFacadeUnavailableError")(
  { name: Schema.Literal("IM_FACADE_UNAVAILABLE"), data: facadeErrorData },
  { httpApiStatus: 502 },
) {}

export const IMFacadeEndpointErrors = [
  IMFacadeBadRequestError,
  IMFacadeForbiddenError,
  IMFacadeNotFoundError,
  IMFacadeConflictError,
  IMFacadeUnavailableError,
  IMInternalServerError,
] as const

export const IMIdentityResponse = Schema.Struct({
  uuid: Schema.String,
  name: Schema.String,
  orgID: Schema.Number,
  orgAllGroupID: Schema.String,
})

export const IMStatusResponse = Schema.Struct({
  service: Schema.optional(ConfigIM.ServiceStatus),
  media: Schema.optional(MediaBatch.Policy),
  reader: Schema.optional(
    Schema.Struct({
      state: Schema.Literals(["idle", "syncing", "ready", "partial", "unavailable"]),
      code: Schema.optional(KernelReaderSchema.Code),
      displayEpoch: Schema.String,
      legacyMirrorUnavailable: Schema.Boolean,
    }),
  ),
  facade: Schema.Literals(["disabled", "claim_required", "blocked", "active"]),
  identity: Schema.NullOr(IMIdentityResponse),
  blocked: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  // 内核连接状态机现值（B1 KernelClient.ConnectionState）；无引擎 ⇒ null。
  kernel: Schema.NullOr(Schema.Literals(["connecting", "connected", "disconnected", "failed"])),
  // 当前生效 facade key 的来源（rebind 持久化 > env 注入）；key 值本身绝不出端点。
  keyOrigin: Schema.Literals(["stored", "env", "none"]),
  viewer: Schema.optional(Schema.Struct({ memberID: Schema.String })),
  recovery: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(["pending", "ready", "failed"]),
      message: Schema.optional(Schema.String),
    }),
  ),
})

export const IMResolveResponse = Schema.Struct({ uuid: Schema.String, name: Schema.String })

export const IMNamePayload = Schema.Struct({ name: Schema.String })

export const IMRebindPayload = Schema.Struct({ newKey: Schema.String })

export const IMKernelGroupCreatePayload = Schema.Struct({
  name: Schema.String,
  memberNames: Schema.Array(Schema.String),
})

export const IMResolveQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  name: Schema.String,
})

// Paths
export const IMPaths = {
  activation: `${root}/activation`,
  activationQuote: `${root}/activation/quote`,
  activationStatus: `${root}/activation/:transactionID`,
  deviceInfo: `${root}/device/info`,
  migrationPending: `${root}/device/migrations`,
  migration: `${root}/device/migrate`,
  migrationStatus: `${root}/device/migrations/:migrationID`,
  dacBinding: `${root}/groups/:groupId/dac`,
  dacSubmit: `${root}/groups/:groupId/dac/commands`,
  dacCommand: `${root}/groups/:groupId/dac/commands/:commandID`,
  dacReplyReconcile: `${root}/groups/:groupId/dac/commands/:commandID/reply/reconcile`,
  dacReplyRetry: `${root}/groups/:groupId/dac/commands/:commandID/reply/retry`,
  groups: `${root}/groups`,
  groupPage: `${root}/groups/page`,
  group: `${root}/groups/:groupId`,
  groupRefresh: `${root}/groups/:groupId/refresh`,
  createGroup: `${root}/groups`,
  messages: `${root}/groups/:groupId/messages`,
  createMessage: `${root}/groups/:groupId/messages`,
  thread: `${root}/groups/:groupId/messages/:messageId/thread`,
  markRead: `${root}/groups/:groupId/read`,
  agents: `${root}/agents`,
  message: `${root}/messages/:messageId`,
  search: `${root}/search`,
  uploadAttachment: `${root}/attachments`,
  listAttachments: `${root}/attachments`,
  // B2 门面端点（facade/* 前缀与既有 groups/:groupId、messages/:messageId 天然错开）。
  status: `${root}/status`,
  facadeClaim: `${root}/facade/claim`,
  facadeRename: `${root}/facade/rename`,
  facadeRebind: `${root}/facade/rebind`,
  facadeRetry: `${root}/facade/retry`,
  facadeResolve: `${root}/facade/resolve`,
  facadeDirect: `${root}/facade/direct`,
  facadeGroups: `${root}/facade/groups`,
  facadeInvite: `${root}/facade/groups/:groupId/invite`,
} as const

// API definition
export const IMApi = HttpApi.make("im")
  .add(
    HttpApiGroup.make("im")
      .add(
        HttpApiEndpoint.get("deviceInfo", IMPaths.deviceInfo, {
          query: WorkspaceRoutingQuery,
          success: IMDeviceSchema.Info,
          error: [IMFacadeBadRequestError, IMFacadeConflictError, IMFacadeUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.deviceInfo",
            summary: "Read public IM device identity and verify native custody",
          }),
        ),
        HttpApiEndpoint.get("migrationPending", IMPaths.migrationPending, {
          query: WorkspaceRoutingQuery,
          success: IMDeviceSchema.Pending,
          error: [IMFacadeBadRequestError, IMFacadeConflictError, IMFacadeUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.migrationPending",
            summary: "Read the original unfinished device binding",
          }),
        ),
        HttpApiEndpoint.get("migrationStatus", IMPaths.migrationStatus, {
          params: { migrationID: IMDeviceSchema.Migrate.fields.migrationID },
          query: WorkspaceRoutingQuery,
          success: IMDeviceSchema.Migration,
          error: [IMFacadeBadRequestError, IMFacadeConflictError, IMFacadeUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.migrationStatus",
            summary: "Recover the original zero-credit legacy binding",
          }),
        ),
        HttpApiEndpoint.post("migrate", IMPaths.migration, {
          query: WorkspaceRoutingQuery,
          payload: IMDeviceSchema.Migrate,
          success: IMDeviceSchema.Migration,
          error: [IMFacadeBadRequestError, IMFacadeConflictError, IMFacadeUnavailableError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.migrate",
            summary: "Explicitly bind an existing paid entitlement without charging",
          }),
        ),
        HttpApiEndpoint.get("activationQuote", IMPaths.activationQuote, {
          query: WorkspaceRoutingQuery,
          success: IMActivationSchema.Quote,
          error: [IMFacadeBadRequestError, IMFacadeConflictError, IMFacadeUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.activationQuote",
            summary: "Get explicit IM activation terms without spending credit",
          }),
        ),
        HttpApiEndpoint.get("activationPending", IMPaths.activation, {
          query: WorkspaceRoutingQuery,
          success: IMActivationSchema.Pending,
          error: [IMFacadeBadRequestError, IMFacadeConflictError, IMFacadeUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.activationPending",
            summary: "Read an unfinished IM activation without another purchase",
          }),
        ),
        HttpApiEndpoint.get("activationStatus", IMPaths.activationStatus, {
          params: { transactionID: IMActivationSchema.Transaction.fields.transactionID },
          query: WorkspaceRoutingQuery,
          success: IMActivationSchema.Transaction,
          error: [IMFacadeBadRequestError, IMFacadeConflictError, IMFacadeUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.activationStatus",
            summary: "Recover the original IM activation receipt",
          }),
        ),
        HttpApiEndpoint.post("activate", IMPaths.activation, {
          query: WorkspaceRoutingQuery,
          payload: IMActivationSchema.Submit,
          success: IMActivationSchema.Transaction,
          error: [IMFacadeBadRequestError, IMFacadeConflictError, IMFacadeUnavailableError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.activate",
            summary: "Explicitly redeem an IM code or spend one credit to activate IM",
          }),
        ),
        HttpApiEndpoint.get("dacBinding", IMPaths.dacBinding, {
          params: { groupId: Schema.String },
          query: WorkspaceRoutingQuery,
          success: IMDacSessionSchema.BindingResponse,
          error: [IMReaderUnavailableError, IMGroupNotFoundError, IMDacCommandError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.dacBinding",
            summary: "Read the owner's ordinary DAC Session binding",
          }),
        ),
        HttpApiEndpoint.post("dacSubmit", IMPaths.dacSubmit, {
          params: { groupId: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: IMDacSessionSchema.Submit,
          success: IMDacSessionSchema.CommandResponse,
          error: [
            IMReaderUnavailableError,
            IMGroupNotFoundError,
            IMDacCommandError,
            IMInternalServerError,
            HttpApiError.BadRequest,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.dacSubmit",
            summary: "Admit one private /dac command into an ordinary Session",
          }),
        ),
        HttpApiEndpoint.get("dacCommand", IMPaths.dacCommand, {
          params: { groupId: Schema.String, commandID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: IMDacSessionSchema.CommandResponse,
          error: [IMReaderUnavailableError, IMGroupNotFoundError, IMDacCommandError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.dacCommand",
            summary: "Read durable command admission and final reply status",
          }),
        ),
        HttpApiEndpoint.post("dacReplyReconcile", IMPaths.dacReplyReconcile, {
          params: { groupId: Schema.String, commandID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: IMDacSessionSchema.ReplyReconcileRequest,
          success: IMDacSessionSchema.ReplyReconcileResponse,
          error: [
            IMReaderUnavailableError,
            IMGroupNotFoundError,
            IMDacCommandError,
            IMInternalServerError,
            HttpApiError.BadRequest,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.dacReplyReconcile",
            summary: "Explicitly check original final reply receipts without sending or executing again",
          }),
        ),
        HttpApiEndpoint.post("dacReplyRetry", IMPaths.dacReplyRetry, {
          params: { groupId: Schema.String, commandID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: IMDacSessionSchema.CommandResponse,
          error: [IMReaderUnavailableError, IMGroupNotFoundError, IMDacCommandError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.dacReplyRetry",
            summary: "Explicitly retry a known failed final reply without running the Session again",
          }),
        ),
        HttpApiEndpoint.get("listGroupPage", IMPaths.groupPage, {
          query: ListGroupPageQuery,
          success: described(GroupPageResponse, "Bounded IM group page"),
          error: [IMReaderUnavailableError, IMValidationFailedError, HttpApiError.BadRequest, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.groups.listPage",
            summary: "List an ordinary or protected IM group page",
          }),
        ),
        HttpApiEndpoint.get("getGroup", IMPaths.group, {
          params: { groupId: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(GroupDetailResponse, "Current IM group"),
          error: [IMReaderUnavailableError, IMGroupNotFoundError, IMInternalServerError],
        }).annotateMerge(OpenApi.annotations({ identifier: "im.groups.get", summary: "Get the current IM group" })),
        HttpApiEndpoint.post("refreshGroup", IMPaths.groupRefresh, {
          params: { groupId: KernelReaderSchema.text(512) },
          query: WorkspaceRoutingQuery,
          success: described(GroupDetailResponse, "Current IM group after authenticated metadata refresh"),
          error: [IMReaderUnavailableError, IMGroupNotFoundError, IMInternalServerError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.groups.refresh",
            summary: "Refresh one current protected IM group name",
          }),
        ),
        HttpApiEndpoint.get("listGroups", IMPaths.groups, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(IMGroupResponse), "IM groups"),
          error: [IMReaderUnavailableError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.groups.list",
            summary: "List IM groups",
            description: "List all IM groups in the workspace.",
          }),
        ),
        HttpApiEndpoint.post("createGroup", IMPaths.createGroup, {
          query: WorkspaceRoutingQuery,
          payload: CreateGroupPayload,
          success: described(IMGroupResponse, "Created IM group"),
          error: [IMReaderUnavailableError, IMValidationFailedError, HttpApiError.BadRequest, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.groups.create",
            summary: "Create IM group",
            description: "Create a new IM group.",
          }),
        ),
        HttpApiEndpoint.get("listMessages", IMPaths.messages, {
          params: { groupId: Schema.String },
          query: ListMessagesQuery,
          success: described(MessagePageResponse, "IM messages"),
          error: [IMReaderUnavailableError, IMGroupNotFoundError, IMPermissionDeniedError, IMValidationFailedError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.messages.list",
            summary: "List messages",
            description: "List messages in an IM group with pagination.",
          }),
        ),
        HttpApiEndpoint.post("createMessage", IMPaths.createMessage, {
          params: { groupId: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: CreateMessagePayload,
          success: described(IMMessageResponse, "Created message"),
          error: [
            IMReaderUnavailableError,
            IMGroupNotFoundError,
            IMFileUploadDisabledError,
            IMAttachmentNotFoundError,
            IMValidationFailedError,
            IMMessageTooLargeError,
            IMMessageIdentityConflictError,
            IMRateLimitExceededError,
            IMPermissionDeniedError,
            HttpApiError.BadRequest,
            IMInternalServerError,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.messages.create",
            summary: "Create message",
            description: "Create a new message in an IM group.",
          }),
        ),
        HttpApiEndpoint.post("markRead", IMPaths.markRead, {
          params: { groupId: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: MarkReadPayload,
          success: described(MarkReadResponse, "Mark as read"),
          error: [IMReaderUnavailableError, IMGroupNotFoundError, IMPermissionDeniedError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.messages.markRead",
            summary: "Mark messages as read",
            description: "Mark all messages in a group as read.",
          }),
        ),
        HttpApiEndpoint.get("listAgents", IMPaths.agents, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(AgentDescriptorResponse), "Available agents"),
          error: [IMReaderUnavailableError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.agents.list",
            summary: "List agents",
            description: "List all available agents.",
          }),
        ),
        HttpApiEndpoint.get("getMessage", IMPaths.message, {
          params: { messageId: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(IMMessageResponse, "IM message"),
          error: [IMReaderUnavailableError, IMMessageNotFoundError, IMPermissionDeniedError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.messages.get",
            summary: "Get message",
            description: "Get a single message by ID.",
          }),
        ),
        HttpApiEndpoint.get("listThread", IMPaths.thread, {
          params: { groupId: Schema.String, messageId: Schema.String },
          query: ThreadQuery,
          success: described(MessagePageResponse, "Thread messages"),
          error: [
            IMReaderUnavailableError,
            IMThreadDisabledError,
            IMGroupNotFoundError,
            IMPermissionDeniedError,
            IMInternalServerError,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.messages.thread",
            summary: "List thread",
            description: "List the replies to a message (reply_to_id chain) with keyset pagination.",
          }),
        ),
        // §B3 搜索 — full-text + metadata search scoped to the caller's group memberships.
        HttpApiEndpoint.get("search", IMPaths.search, {
          query: SearchQuery,
          success: described(MessagePageResponse, "Search results"),
          error: [IMReaderUnavailableError, IMValidationFailedError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.messages.search",
            summary: "Search messages",
            description:
              "Full-text search across messages in groups the caller belongs to, with optional group / sender / type / metadata filters and keyset pagination.",
          }),
        ),
        // Upload remains unbound until a file-message transaction claims its attachmentID.
        HttpApiEndpoint.post("uploadAttachment", IMPaths.uploadAttachment, {
          query: WorkspaceRoutingQuery,
          payload: UploadAttachmentPayload,
          success: described(IMAttachmentResponse, "Uploaded attachment"),
          error: [
            IMReaderUnavailableError,
            IMFileUploadDisabledError,
            IMAttachmentNotFoundError,
            IMFileTooLargeError,
            IMUnsupportedMediaTypeError,
            IMGroupNotFoundError,
            IMValidationFailedError,
            HttpApiError.BadRequest,
            IMInternalServerError,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.attachments.upload",
            summary: "Upload attachment",
            description:
              "Upload to an authorized local group. Validates bytes, MIME and size, computes SHA-256, and returns an expiring unbound ID. Requires v4FileUploadEnabled; kernel conversations are unsupported.",
          }),
        ),
        // §B3 文件 — list attachments for a group / message (or the whole workspace).
        HttpApiEndpoint.get("listAttachments", IMPaths.listAttachments, {
          query: ListAttachmentsQuery,
          success: described(Schema.Array(IMAttachmentResponse), "Attachments"),
          error: [
            IMReaderUnavailableError,
            IMFileUploadDisabledError,
            IMGroupNotFoundError,
            IMValidationFailedError,
            IMAttachmentNotFoundError,
            IMInternalServerError,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.attachments.list",
            summary: "List attachments",
            description: "List authorized attachment records for a required local group or message.",
          }),
        ),
        HttpApiEndpoint.get("getAttachment", `${root}/attachments/:attachmentId`, {
          params: { attachmentId: Schema.String },
          query: WorkspaceRoutingQuery,
          success: IMAttachmentResponse,
          error: [
            IMReaderUnavailableError,
            IMFileUploadDisabledError,
            IMGroupNotFoundError,
            IMAttachmentNotFoundError,
            IMValidationFailedError,
            IMInternalServerError,
          ],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "im.attachments.get", summary: "Read an authorized local attachment" }),
        ),
        HttpApiEndpoint.get("downloadAttachment", `${root}/attachments/:attachmentId/content`, {
          params: { attachmentId: Schema.String },
          query: WorkspaceRoutingQuery,
          success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
          error: [
            IMReaderUnavailableError,
            IMFileUploadDisabledError,
            IMGroupNotFoundError,
            IMAttachmentNotFoundError,
            IMValidationFailedError,
            IMInternalServerError,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.attachments.download",
            summary: "Download authorized local attachment bytes",
          }),
        ),
        HttpApiEndpoint.get(
          "getRemoteAttachment",
          `${root}/groups/:groupId/messages/:messageId/attachments/:attachmentId`,
          {
            params: { groupId: Schema.String, messageId: Schema.String, attachmentId: KernelReaderSchema.Hash },
            query: WorkspaceRoutingQuery,
            success: KernelReaderSchema.RemoteAttachment,
            error: [
              IMReaderUnavailableError,
              IMFileUploadDisabledError,
              IMAttachmentNotFoundError,
              IMValidationFailedError,
              IMInternalServerError,
            ],
          },
        ).annotateMerge(
          OpenApi.annotations({
            identifier: "im.attachments.remote.get",
            summary: "Read current protected message attachment metadata",
          }),
        ),
        HttpApiEndpoint.get(
          "downloadRemoteAttachment",
          `${root}/groups/:groupId/messages/:messageId/attachments/:attachmentId/content`,
          {
            params: { groupId: Schema.String, messageId: Schema.String, attachmentId: KernelReaderSchema.Hash },
            query: WorkspaceRoutingQuery,
            success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
            error: [
              IMReaderUnavailableError,
              IMFileUploadDisabledError,
              IMAttachmentNotFoundError,
              IMValidationFailedError,
              IMInternalServerError,
            ],
          },
        ).annotateMerge(
          OpenApi.annotations({
            identifier: "im.attachments.remote.download",
            summary: "Stream current authorized protected attachment bytes",
          }),
        ),
        // ── B2 门面端点 ─────────────────────────────────────────────────────────────
        // 状态快照永远可用（facade 缺席 ⇒ disabled 快照而非错误）；门面操作在 facade 缺席时
        // 由 handler 侧合成 im_unavailable (IMFacadeUnavailableError)。
        HttpApiEndpoint.get("facadeStatus", IMPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(IMStatusResponse, "IM facade status"),
          error: [IMReaderUnavailableError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.facade.status",
            summary: "IM facade status",
            description:
              "Snapshot of the multi-user IM facade state machine (disabled / claim_required / blocked / active), the claimed identity, the kernel engine connection state, and the origin of the facade key in use (never the key itself).",
          }),
        ),
        HttpApiEndpoint.post("facadeClaim", IMPaths.facadeClaim, {
          query: WorkspaceRoutingQuery,
          payload: IMNamePayload,
          success: described(IMIdentityResponse, "Claimed IM identity"),
          error: IMFacadeEndpointErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.facade.claim",
            summary: "Claim IM identity",
            description:
              "Claim the IM identity (an org-unique name) for the configured facade key. Idempotent for an already-claimed key.",
          }),
        ),
        HttpApiEndpoint.post("facadeRename", IMPaths.facadeRename, {
          query: WorkspaceRoutingQuery,
          payload: IMNamePayload,
          success: described(IMIdentityResponse, "Renamed IM identity"),
          error: IMFacadeEndpointErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.facade.rename",
            summary: "Rename IM identity",
            description: "Rename the claimed IM identity. The uuid and group memberships are unchanged.",
          }),
        ),
        HttpApiEndpoint.post("facadeRebind", IMPaths.facadeRebind, {
          query: WorkspaceRoutingQuery,
          payload: IMRebindPayload,
          success: described(IMIdentityResponse, "Rebound IM identity"),
          error: IMFacadeEndpointErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.facade.rebind",
            summary: "Rebind IM identity to a new key",
            description:
              "Migrate the IM identity from the current facade key to a new key (key-rotation recovery). The new key is persisted to auth.json on success.",
          }),
        ),
        HttpApiEndpoint.post("facadeRetry", IMPaths.facadeRetry, {
          query: WorkspaceRoutingQuery,
          success: described(IMIdentityResponse, "Exchanged IM identity"),
          error: IMFacadeEndpointErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.facade.retry",
            summary: "Retry the boot exchange",
            description:
              "Re-run the boot exchange against the facade (recovery from the blocked / claim_required states).",
          }),
        ),
        HttpApiEndpoint.get("facadeResolve", IMPaths.facadeResolve, {
          query: IMResolveQuery,
          success: described(IMResolveResponse, "Resolved IM user"),
          error: IMFacadeEndpointErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.facade.resolve",
            summary: "Resolve an IM user by name",
            description: "Exact-match directory lookup inside the org (no fuzzy search). 404 im_not_found when absent.",
          }),
        ),
        HttpApiEndpoint.post("facadeDirect", IMPaths.facadeDirect, {
          query: WorkspaceRoutingQuery,
          payload: IMNamePayload,
          success: described(IMGroupResponse, "Direct chat group"),
          error: IMFacadeEndpointErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.facade.direct",
            summary: "Open a direct chat by name",
            description:
              "Resolve a directory name and open (idempotently reuse) the local direct-chat group with that user, binding the k:1:<uuid> kernel conversation.",
          }),
        ),
        HttpApiEndpoint.post("facadeCreateGroup", IMPaths.facadeGroups, {
          query: WorkspaceRoutingQuery,
          payload: IMKernelGroupCreatePayload,
          success: described(IMGroupResponse, "Kernel group"),
          error: IMFacadeEndpointErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.facade.groups.create",
            summary: "Create a kernel group",
            description:
              "Create a kernel-backed group via the facade (member_names are org directory names) and mirror it locally with the k:2:<group_id> binding.",
          }),
        ),
        HttpApiEndpoint.post("facadeInvite", IMPaths.facadeInvite, {
          params: { groupId: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: IMNamePayload,
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Invite result"),
          error: [IMReaderUnavailableError, ...IMFacadeEndpointErrors, IMGroupNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.facade.groups.invite",
            summary: "Invite a user to a kernel group",
            description:
              "Invite a directory name into a kernel-bound local group (the group must carry a k:2:<group_id> binding).",
          }),
        ),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware),
  )
  .middleware(Authorization)
