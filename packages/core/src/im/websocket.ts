import { Schema } from "effect"

// WebSocket 消息类型

// Server -> Client: 新消息创建
export const MessageCreatedEvent = Schema.Struct({
  type: Schema.Literal("message_created"),
  data: Schema.Struct({
    id: Schema.String,
    groupID: Schema.String,
    senderID: Schema.String,
    senderType: Schema.String,
    messageType: Schema.String,
    content: Schema.String,
    mentions: Schema.NullOr(Schema.Array(Schema.String)),
    metadata: Schema.NullOr(Schema.Unknown),
    replyToID: Schema.NullOr(Schema.String),
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
  }),
})
export type MessageCreatedEvent = typeof MessageCreatedEvent.Type

// Server -> Client: 消息发送失败
export const MessageFailedEvent = Schema.Struct({
  type: Schema.Literal("message_failed"),
  data: Schema.Struct({
    clientMessageID: Schema.optional(Schema.String),
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
  }),
})
export type MessageFailedEvent = typeof MessageFailedEvent.Type

// Server -> Client: Agent 状态更新
export const AgentStatusEvent = Schema.Struct({
  type: Schema.Literal("agent_status"),
  data: Schema.Struct({
    messageID: Schema.String,
    agentID: Schema.String,
    // V4.1 §S1.2: "steered" = the trigger message was absorbed as a mid-turn steer into an already-
    // running turn (the reply streams through that turn), so there is no separate agent reply. Additive.
    status: Schema.Literals(["started", "running", "success", "failed", "timeout", "steered"]),
    error: Schema.optional(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
      }),
    ),
  }),
})
export type AgentStatusEvent = typeof AgentStatusEvent.Type

// Server -> Client: Agent 推理过程实时流（可展开查看）
// One changed part of an in-flight agent turn. The client keeps a map keyed by
// `partID` and REPLACES each entry, so a dropped/reordered batch self-heals on
// the next snapshot. The authoritative final reply still arrives as a normal
// `message_created`. Fields mirror agent_status's uppercase kernel-WS style.
export const AgentProgressPart = Schema.Struct({
  partID: Schema.String,
  order: Schema.Number,
  kind: Schema.Literals(["reasoning", "text", "tool"]),
  text: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
})
export type AgentProgressPart = typeof AgentProgressPart.Type

export const AgentProgressEvent = Schema.Struct({
  type: Schema.Literal("agent_progress"),
  data: Schema.Struct({
    // Trigger message id the reasoning belongs to (same key agent_status uses),
    // so the client attaches the live view to the right conversation slot.
    messageID: Schema.String,
    agentID: Schema.String,
    parts: Schema.Array(AgentProgressPart),
  }),
})
export type AgentProgressEvent = typeof AgentProgressEvent.Type

// Both directions: 正在输入
export const TypingEvent = Schema.Struct({
  type: Schema.Literal("typing"),
  data: Schema.Struct({
    groupID: Schema.String,
    memberID: Schema.String,
    typing: Schema.Boolean,
  }),
})
export type TypingEvent = typeof TypingEvent.Type

// Both directions: 已读回执
export const ReadReceiptEvent = Schema.Struct({
  type: Schema.Literal("read_receipt"),
  data: Schema.Struct({
    groupID: Schema.String,
    memberID: Schema.String,
    readAt: Schema.Number,
  }),
})
export type ReadReceiptEvent = typeof ReadReceiptEvent.Type

// Both directions: 心跳
export const PingEvent = Schema.Struct({
  type: Schema.Literal("ping"),
  data: Schema.Struct({
    ts: Schema.Number,
  }),
})
export type PingEvent = typeof PingEvent.Type

export const PongEvent = Schema.Struct({
  type: Schema.Literal("pong"),
  data: Schema.Struct({
    ts: Schema.Number,
  }),
})
export type PongEvent = typeof PongEvent.Type

// 所有服务端发送的事件
export const ServerEvent = Schema.Union([
  MessageCreatedEvent,
  MessageFailedEvent,
  AgentStatusEvent,
  AgentProgressEvent,
  TypingEvent,
  ReadReceiptEvent,
  PingEvent,
  PongEvent,
])
export type ServerEvent = typeof ServerEvent.Type

// 所有客户端发送的事件
export const ClientEvent = Schema.Union([TypingEvent, ReadReceiptEvent, PingEvent, PongEvent])
export type ClientEvent = typeof ClientEvent.Type

// WebSocket 连接管理
export interface IMWebSocketConnection {
  groupID: string
  userID: string
  workspaceID: string
  send: (event: ServerEvent) => void
  close: (code?: number, reason?: string) => void
}

// WebSocket 广播管理器
export interface IMBroadcaster {
  // 向群组中的所有连接广播消息
  broadcast: (groupID: string, event: ServerEvent) => void
  // 向特定用户发送消息
  sendToUser: (groupID: string, userID: string, event: ServerEvent) => void
  // 注册连接
  register: (conn: IMWebSocketConnection) => void
  // 注销连接
  unregister: (conn: IMWebSocketConnection) => void
  // 获取群组的连接数
  getConnectionCount: (groupID: string) => number
  // 获取用户在群组中的连接数
  getUserConnectionCount: (groupID: string, userID: string) => number
}
