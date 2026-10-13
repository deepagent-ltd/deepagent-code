// The IM agent descriptor is defined canonically in the core package
// (`packages/core/src/im/mention-parser.ts`) and served verbatim by the HTTP
// API (`AgentDescriptorResponse = AgentDescriptor`). Re-export the canonical
// types here instead of hand-mirroring them, so the frontend can never drift
// from the backend contract. `Trigger`, `AutonomyLevel` and `AgentLimits` are
// the sub-schemas referenced by `AgentDescriptor`.
export type { AgentDescriptor, AgentLimits, AutonomyLevel, Trigger } from "@deepagent-code/core/im/mention-parser"
import type {
  ImMessagesCreateResponse,
  ImGroupsListResponse,
  ImGroupsListPageResponse,
  ImGroupsGetResponse,
  ImMessagesListResponse,
  ImFacadeStatusResponse,
  ImMessagesMarkReadResponse,
  ImMessagesMarkReadData,
} from "@deepagent-code/sdk"
import type { MediaIntent } from "@deepagent-code/core/im/media-intent"

export type IMGroupPage = ImGroupsListPageResponse
export type IMGroupDetail = ImGroupsGetResponse

export type IMRemoteAttachment = NonNullable<ImMessagesCreateResponse["remoteAttachments"]>[number]

export type IMTransport = ImMessagesCreateResponse["transport"]

export type IMReaderGroup = NonNullable<ImGroupsListResponse[number]["reader"]>
export type IMReaderPage = NonNullable<ImMessagesListResponse["reader"]>
export type IMReaderStatus = NonNullable<ImFacadeStatusResponse["reader"]>
export type IMReadResult = ImMessagesMarkReadResponse
export type IMReadAction = Required<Pick<ImMessagesMarkReadData["body"], "actionID">> &
  Pick<ImMessagesMarkReadData["body"], "reconcile" | "continue" | "cancel" | "newAction">

export interface IMGroup {
  reader?: IMReaderGroup
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
  | (readonly { type: "attachment_ref"; attachmentID: string; batch: true }[] & { readonly type?: undefined })
  | { type: "attachment_ref"; attachmentID: string }
  | { type: "file_ref"; path: string; line?: number }
  | { type: "code_ref"; path?: string; startLine?: number; endLine?: number }
  | { type: "agent_run"; sessionID?: string; status: string }
  | { type: "debug"; info: string }
  | { type: "profile"; operation: string; duration: number }
  | { type: "error"; code: string; message: string }

export interface IMMessage {
  remoteAttachments?: IMRemoteAttachment[]
  transport?: IMTransport
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
export type IMAttachment = MediaIntent.Attachment
