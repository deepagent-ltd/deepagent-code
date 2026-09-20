import type { useSDK } from "../context/sdk"

export type IMGroup = {
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
  | { type: "agent_no_trigger_mention"; agentID?: string; agentNames?: string[]; eventID?: string; messageID?: string }

export type IMMessage = {
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

export type IMMessagePage = {
  messages: IMMessage[]
  nextCursor: string | null
  hasMore: boolean
}

// W4-3 — the TUI IM client. The IM API is its own HttpApi (not in the generated SDK), so these
// calls ride the SDK client's low-level request escape hatch with the directory routed BOTH as
// ?directory= and the x-deepagent-code-directory header (the gateway proxy drops query strings
// on HTTP hops; only WS upgrades preserve them).
export function createIMClient(sdk: ReturnType<typeof useSDK>) {
  const request = <T,>(options: { method: string; url: string; body?: unknown }) =>
    (
      sdk.client as unknown as {
        client: { request<D>(o: typeof options): Promise<{ data?: T; error?: unknown }> }
      }
    ).client.request<T>(options)

  return {
    listGroups: () => request<IMGroup[]>({ method: "GET", url: "/api/v1/im/groups" }),
    createGroup: (payload: { name: string; type: "project" | "system" | "direct"; member?: { memberID: string; memberType: "user" | "agent" } }) =>
      request<IMGroup>({ method: "POST", url: "/api/v1/im/groups", body: payload }),
    listMessages: (groupID: string, limit = 50) =>
      request<IMMessagePage>({
        method: "GET",
        url: `/api/v1/im/groups/${groupID}/messages?limit=${limit}`,
      }),
    createMessage: (groupID: string, payload: { content: string; type?: string; mentions?: string[] }) =>
      request<IMMessage>({
        method: "POST",
        url: `/api/v1/im/groups/${groupID}/messages`,
        body: { senderType: "user", type: payload.type ?? "text", ...payload },
      }),
    markRead: (groupID: string) =>
      request<{ ok: boolean }>({ method: "POST", url: `/api/v1/im/groups/${groupID}/read` }),
    listAgents: () => request<unknown[]>({ method: "GET", url: "/api/v1/im/agents" }),
  }
}

// Live channel for one group. The WS event protocol (server → client): message_created,
// message_failed, agent_status, typing, read_receipt, ping. Reconnect with backoff; only
// message_created/message_failed matter for the TUI surface so far.
export function openIMGroupSocket(sdk: ReturnType<typeof useSDK>, groupID: string, handlers: {
  onMessage?: (message: IMMessage) => void
  onFailed?: (payload: { clientMessageID?: string; code: string; message: string }) => void
}) {
  const http = sdk.url.replace(/^http/, "ws")
  const url = new URL(`/ws/im/group/${groupID}`, http)
  if (sdk.directory) url.searchParams.set("directory", sdk.directory)
  let socket: WebSocket | undefined
  let closed = false
  let attempt = 0
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const connect = () => {
    if (closed) return
    socket = new WebSocket(url)
    socket.onopen = () => {
      attempt = 0
      heartbeat = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }))
      }, 30_000)
    }
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { type: string; data?: unknown }
        if (payload.type === "message_created") handlers.onMessage?.(payload.data as IMMessage)
        if (payload.type === "message_failed") handlers.onFailed?.(payload.data as { clientMessageID?: string; code: string; message: string })
      } catch {
        // Ignore malformed frames — the next HTTP re-sync heals.
      }
    }
    socket.onclose = () => {
      if (heartbeat) clearInterval(heartbeat)
      if (closed) return
      attempt += 1
      setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)))
    }
  }
  connect()

  return {
    close() {
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      socket?.close()
    },
  }
}
