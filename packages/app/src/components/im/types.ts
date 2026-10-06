// The IM agent descriptor is defined canonically in the core package
// (`packages/core/src/im/mention-parser.ts`) and served verbatim by the HTTP
// API (`AgentDescriptorResponse = AgentDescriptor`). Re-export the canonical
// types here instead of hand-mirroring them, so the frontend can never drift
// from the backend contract. `Trigger`, `AutonomyLevel` and `AgentLimits` are
// the sub-schemas referenced by `AgentDescriptor`.
export type { AgentDescriptor, AgentLimits, AutonomyLevel, Trigger } from "@deepagent-code/core/im/mention-parser"

export interface IMGroup {
  id: string
  workspaceID: string
  projectID: string | null
  type: string
  name: string
  createdBy: string
  // B2 — k:<type>:<id> 内核会话绑定（1=私聊 2=内核群；null=纯本地群）。全员群判定见
  // side-panel-im.tsx（kernelConvID === `k:2:${identity.orgAllGroupID}`）。
  kernelConvID: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export type MessageMetadata =
  | { type: "attachment_ref"; attachmentID: string }
  | { type: "file_ref"; path: string; line?: number }
  | { type: "code_ref"; path?: string; startLine?: number; endLine?: number }
  | { type: "agent_run"; sessionID?: string; status: string }
  | { type: "debug"; info: string }
  | { type: "profile"; operation: string; duration: number }
  | { type: "error"; code: string; message: string }
  // W0.4 (P9) — @mention routing receipt. Fields mirror core `NoTriggerMentionMetadata`
  // (packages/core/src/im/sql.ts) exactly: the receipt tells the user their @mention was NOT dispatched
  // (the mentioned agent did not declare the mention trigger, or nobody declared it at all). The
  // optional eventID/messageID/agentID fields link the receipt to the initiating mention message for
  // debugging; the message body itself is the user-visible copy (rendered as plain text — see
  // message-metadata-card.tsx).
  | {
      type: "agent_no_trigger_mention"
      agentID?: string
      agentNames?: string[]
      eventID?: string
      messageID?: string
    }

export interface IMMessage {
  id: string
  groupID: string
  senderID: string
  senderType: "user" | "agent" | "system" | string
  type: string
  content: string
  mentions: string[] | null
  metadata: MessageMetadata | null
  replyToID: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

// V4.0 §B3 file attachments. Mirrors the server's `IMAttachmentResponse`
// (packages/deepagent-code/src/server/routes/instance/httpapi/groups/im.ts).
export interface IMAttachment {
  id: string
  workspaceID: string
  projectID: string | null
  groupID: string | null
  messageID: string | null
  uploadedBy: string
  filename: string
  mime: string
  sizeBytes: number
  checksum: string
  createdAt: number
  expiresAt: number
  preview: boolean
}
