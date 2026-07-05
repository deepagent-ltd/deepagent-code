export interface AgentDescriptor {
  id: string
  name: string
  displayName: string
  description?: string
  visible: boolean
}

export interface IMGroup {
  id: string
  workspaceID: string
  projectID: string | null
  type: string
  name: string
  createdBy: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export type MessageMetadata =
  | { type: "file_ref"; path: string; line?: number }
  | { type: "code_ref"; path?: string; startLine?: number; endLine?: number }
  | { type: "agent_run"; sessionID?: string; status: string }
  | { type: "debug"; info: string }
  | { type: "profile"; operation: string; duration: number }
  | { type: "error"; code: string; message: string }

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
