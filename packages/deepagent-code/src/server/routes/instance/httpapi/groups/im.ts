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
          error: [IMGroupNotFoundError, IMPermissionDeniedError, IMInternalServerError],
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
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware),
  )
  .middleware(Authorization)
