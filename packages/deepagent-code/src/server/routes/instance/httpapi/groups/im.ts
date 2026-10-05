import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Multipart } from "effect/unstable/http"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { MessageMetadata } from "@deepagent-code/core/im/sql"
import { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/api/v1/im"

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

// Request/Response schemas
export const IMGroupResponse = Schema.Struct({
  id: Schema.String,
  workspaceID: Schema.String,
  projectID: Schema.NullOr(Schema.String),
  type: Schema.String,
  name: Schema.String,
  createdBy: Schema.String,
  // B2：k:<type>:<id> 内核会话绑定（1=私聊 2=内核群）；GUI 用它区分全员群/内核群/纯本地群。
  kernelConvID: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
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

export const IMMessageResponse = Schema.Struct({
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
  messages: Schema.Array(IMMessageResponse),
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
})

export const CreateMessagePayload = Schema.Struct({
  senderType: Schema.Literals(["user", "agent", "system"]),
  type: Schema.Literals(["text", "code", "file", "agent_status", "system"]),
  content: Schema.String,
  mentions: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(MessageMetadata),
  replyToID: Schema.optional(Schema.String),
})

export const MarkReadPayload = Schema.Struct({
  readAt: Schema.optional(Schema.Number),
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
  sizeBytes: Schema.Number,
  checksum: Schema.String,
  createdAt: Schema.Number,
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

// §B3 文件 — multipart upload payload. `file` is the uploaded file part; the remaining OPTIONAL text
// fields scope the attachment (a file may be decoupled from any message: groupId/messageId omitted).
export const UploadAttachmentPayload = Schema.Struct({
  file: Multipart.SingleFileSchema,
  groupId: Schema.optional(Schema.String),
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

// §B3 threads — fail-closed error when the v4ThreadEnabled flag is off, mirroring IMFileUploadDisabledError
// (404: the endpoint does not exist for the caller). Keeps thread gating consistent with the upload gate.
export class IMThreadDisabledError extends Schema.ErrorClass<IMThreadDisabledError>(
  "IMThreadDisabledError",
)(
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
  groups: `${root}/groups`,
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
        HttpApiEndpoint.get("listGroups", IMPaths.groups, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(IMGroupResponse), "IM groups"),
          error: IMInternalServerError,
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
          error: [IMValidationFailedError, HttpApiError.BadRequest, IMInternalServerError],
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
          error: [IMGroupNotFoundError, IMPermissionDeniedError, IMInternalServerError],
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
            IMGroupNotFoundError,
            IMMessageTooLargeError,
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
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Mark as read"),
          error: [IMGroupNotFoundError, IMPermissionDeniedError, IMInternalServerError],
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
          error: IMInternalServerError,
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
          error: [IMMessageNotFoundError, IMPermissionDeniedError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.messages.get",
            summary: "Get message",
            description: "Get a single message by ID.",
          }),
        ),
        // §B3 Thread — list the replies to a parent message, ASC chronological, keyset paginated.
        HttpApiEndpoint.get("listThread", IMPaths.thread, {
          params: { groupId: Schema.String, messageId: Schema.String },
          query: ThreadQuery,
          success: described(MessagePageResponse, "Thread messages"),
          error: [IMThreadDisabledError, IMGroupNotFoundError, IMPermissionDeniedError, IMInternalServerError],
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
          error: [IMValidationFailedError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.messages.search",
            summary: "Search messages",
            description:
              "Full-text search across messages in groups the caller belongs to, with optional group / sender / type / metadata filters and keyset pagination.",
          }),
        ),
        // §B3 文件 — upload a file (multipart). Stored on local disk under the workspace data dir; the
        // record is decoupled from any message unless groupId/messageId are supplied.
        HttpApiEndpoint.post("uploadAttachment", IMPaths.uploadAttachment, {
          query: WorkspaceRoutingQuery,
          payload: UploadAttachmentPayload,
          success: described(IMAttachmentResponse, "Uploaded attachment"),
          error: [
            IMFileUploadDisabledError,
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
              "Upload a file to local disk under the workspace data directory. Validates mime + size and computes a sha256 checksum. Gated on the v4FileUploadEnabled flag.",
          }),
        ),
        // §B3 文件 — list attachments for a group / message (or the whole workspace).
        HttpApiEndpoint.get("listAttachments", IMPaths.listAttachments, {
          query: ListAttachmentsQuery,
          success: described(Schema.Array(IMAttachmentResponse), "Attachments"),
          error: [IMFileUploadDisabledError, IMGroupNotFoundError, IMInternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "im.attachments.list",
            summary: "List attachments",
            description: "List attachment records for a group, message, or the workspace.",
          }),
        ),
        // ── B2 门面端点 ─────────────────────────────────────────────────────────────
        // 状态快照永远可用（facade 缺席 ⇒ disabled 快照而非错误）；门面操作在 facade 缺席时
        // 由 handler 侧合成 im_unavailable (IMFacadeUnavailableError)。
        HttpApiEndpoint.get("facadeStatus", IMPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(IMStatusResponse, "IM facade status"),
          error: IMInternalServerError,
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
            description: "Re-run the boot exchange against the facade (recovery from the blocked / claim_required states).",
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
          error: [...IMFacadeEndpointErrors, IMGroupNotFoundError],
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
