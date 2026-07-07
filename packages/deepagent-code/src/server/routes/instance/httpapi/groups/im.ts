import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
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
  type: Schema.Literals(["project", "system"]),
  projectID: Schema.optional(Schema.String),
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

// Paths
export const IMPaths = {
  groups: `${root}/groups`,
  createGroup: `${root}/groups`,
  messages: `${root}/groups/:groupId/messages`,
  createMessage: `${root}/groups/:groupId/messages`,
  markRead: `${root}/groups/:groupId/read`,
  agents: `${root}/agents`,
  message: `${root}/messages/:messageId`,
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
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware),
  )
  .middleware(Authorization)
