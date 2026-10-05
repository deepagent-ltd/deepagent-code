import type { useSDK } from "../context/sdk"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"

export type IMGroup = {
  id: string
  workspaceID: string
  projectID: string | null
  type: string
  name: string
  createdBy: string
  kernelConvID: string | null
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

export type IMFacadeIdentity = { uuid: string; name: string; orgID: number; orgAllGroupID: string }
export type IMFacadeStatus = {
  facade: "disabled" | "claim_required" | "blocked" | "active"
  identity: IMFacadeIdentity | null
  blocked: { code: string; message: string } | null
  kernel: "connecting" | "connected" | "disconnected" | "failed" | null
  keyOrigin: "stored" | "env" | "none"
  viewer?: { memberID: string }
  recovery?: { status: "pending" | "ready" | "failed"; message?: string }
}
export type IMSDK = Pick<ReturnType<typeof useSDK>, "client" | "url" | "directory"> & { fetch?: typeof fetch }

export class IMRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "IMRequestError"
  }
}

function transport(sdk: IMSDK) {
  return (
    sdk.client as unknown as {
      client: {
        getConfig(): { headers?: RequestInit["headers"]; signal?: AbortSignal | null }
      }
    }
  ).client
}

// Keep the SDK credentials, but preserve the routing header on GETs too. The SDK's generic
// query rewrite strips it, while a gateway HTTP hop may drop the query string.
export function createIMClient(sdk: IMSDK) {
  const request = async <T>(options: { method: string; url: string; body?: unknown }): Promise<T> => {
    const url = new URL(`${sdk.url.replace(/\/+$/, "")}${options.url}`)
    const config = transport(sdk).getConfig()
    const headers = new Headers(config.headers)
    if (sdk.directory) {
      url.searchParams.set("directory", sdk.directory)
      url.searchParams.set("location[directory]", sdk.directory)
      headers.set("x-deepagent-code-directory", encodeURIComponent(sdk.directory))
    }
    if (options.body !== undefined) headers.set("Content-Type", "application/json")
    const response = await (sdk.fetch ?? fetch)(
      new Request(url, {
        method: options.method,
        headers,
        signal: config.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      }),
    ).catch(() => {
      throw new IMRequestError("transport_error", "IM server could not be reached")
    })
    const result: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const error = result as { data?: { code?: unknown; message?: unknown } } | undefined
      throw new IMRequestError(
        typeof error?.data?.code === "string" ? error.data.code : "http_error",
        typeof error?.data?.message === "string" ? error.data.message : "IM request failed",
      )
    }
    if (result === undefined || result === null)
      throw new IMRequestError("invalid_response", "IM server returned no data")
    return result as T
  }

  return {
    listGroups: () => request<IMGroup[]>({ method: "GET", url: "/api/v1/im/groups" }),
    createGroup: (payload: {
      name: string
      type: "project" | "system" | "direct"
      member?: { memberID: string; memberType: "user" | "agent" }
    }) => request<IMGroup>({ method: "POST", url: "/api/v1/im/groups", body: payload }),
    listMessages: (groupID: string, limit = 50, cursor?: string) =>
      request<IMMessagePage>({
        method: "GET",
        url: `/api/v1/im/groups/${encodeURIComponent(groupID)}/messages?${new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) })}`,
      }),
    createMessage: (groupID: string, payload: { content: string; type?: string; mentions?: string[]; clientRequestID?: string }) =>
      request<IMMessage>({
        method: "POST",
        url: `/api/v1/im/groups/${encodeURIComponent(groupID)}/messages`,
        body: { senderType: "user", type: payload.type ?? "text", ...payload },
      }),
    markRead: (groupID: string) =>
      request<{ ok: boolean }>({
        method: "POST",
        url: `/api/v1/im/groups/${encodeURIComponent(groupID)}/read`,
        body: {},
      }),
    listAgents: () => request<AgentDescriptor[]>({ method: "GET", url: "/api/v1/im/agents" }),
    facadeStatus: () => request<IMFacadeStatus>({ method: "GET", url: "/api/v1/im/status" }),
    facadeClaim: (name: string) =>
      request<IMFacadeIdentity>({ method: "POST", url: "/api/v1/im/facade/claim", body: { name } }),
    facadeRename: (name: string) =>
      request<IMFacadeIdentity>({ method: "POST", url: "/api/v1/im/facade/rename", body: { name } }),
    facadeRebind: (newKey: string) =>
      request<IMFacadeIdentity>({ method: "POST", url: "/api/v1/im/facade/rebind", body: { newKey } }),
    storeFacadeKey: (key: string) =>
      request<boolean>({ method: "PUT", url: "/auth/im-facade", body: { type: "api", key } }),
    facadeRetry: () => request<IMFacadeIdentity>({ method: "POST", url: "/api/v1/im/facade/retry", body: {} }),
    facadeResolve: (name: string) =>
      request<{ uuid: string; name: string }>({
        method: "GET",
        url: `/api/v1/im/facade/resolve?${new URLSearchParams({ name })}`,
      }),
    facadeOpenDirect: (name: string) =>
      request<IMGroup>({ method: "POST", url: "/api/v1/im/facade/direct", body: { name } }),
    facadeCreateGroup: (name: string, memberNames: string[]) =>
      request<IMGroup>({ method: "POST", url: "/api/v1/im/facade/groups", body: { name, memberNames } }),
    facadeInvite: (groupID: string, name: string) =>
      request<{ ok: boolean }>({
        method: "POST",
        url: `/api/v1/im/facade/groups/${encodeURIComponent(groupID)}/invite`,
        body: { name },
      }),
  }
}

export type IMClient = ReturnType<typeof createIMClient>

// Recover the entire gap to the oldest displayed message. Stopping at any shared ID is
// unsafe: a WS message received during the HTTP request can overlap the first page while
// the disconnected interval is still missing farther down the history.
export async function recoverIMMessages(client: IMClient, groupID: string, oldestID?: string) {
  const messages: IMMessage[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let pageCount = 0; pageCount < 256; pageCount += 1) {
    const page = await client.listMessages(groupID, 50, cursor)
    const boundary = page.messages.findIndex((message) => message.id === oldestID)
    messages.push(...(boundary < 0 ? page.messages : page.messages.slice(0, boundary + 1)))
    if (!oldestID || boundary >= 0 || !page.hasMore)
      return { ...page, messages }
    if (!page.nextCursor || cursors.has(page.nextCursor))
      throw new IMRequestError("invalid_response", "IM history did not advance; retry the recovery")
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  throw new IMRequestError("invalid_response", "IM history recovery exceeded its page limit; retry the recovery")
}

export function mergeIMMessages(current: IMMessage[], incoming: IMMessage[]) {
  return [...new Map([...current, ...incoming].map((message) => [message.id, message])).values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  )
}

// Live channel for one group. The WS event protocol (server → client): message_created,
// message_failed, agent_status, typing, read_receipt, ping. Reconnect with backoff; only
// message_created/message_failed matter for the TUI surface so far.
export function openIMGroupSocket(
  sdk: IMSDK,
  groupID: string,
  handlers: {
    onMessage?: (message: IMMessage) => void
    onFailed?: (payload: { clientMessageID?: string; code: string; message: string }) => void
    onOpen?: () => void
    onState?: (state: "connecting" | "connected" | "disconnected") => void
  },
) {
  const url = new URL(`${sdk.url.replace(/\/+$/, "")}/ws/im/group/${encodeURIComponent(groupID)}`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  if (sdk.directory) {
    url.searchParams.set("directory", sdk.directory)
    url.searchParams.set("location[directory]", sdk.directory)
  }
  const signal = transport(sdk).getConfig().signal
  let socket: WebSocket | undefined
  let closed = false
  let attempt = 0
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined

  const close = () => {
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    if (retry) clearTimeout(retry)
    signal?.removeEventListener("abort", close)
    socket?.close()
  }

  const connect = () => {
    if (closed) return
    handlers.onState?.("connecting")
    // TUI runs on Bun, whose WebSocket supports the same authenticated headers as HTTP.
    const Socket = WebSocket as unknown as new (url: string, options: { headers?: RequestInit["headers"] }) => WebSocket
    const headers = new Headers(transport(sdk).getConfig().headers)
    if (sdk.directory) headers.set("x-deepagent-code-directory", encodeURIComponent(sdk.directory))
    const active = new Socket(url.toString(), { headers })
    socket = active
    active.onopen = () => {
      if (closed || socket !== active) return
      attempt = 0
      handlers.onState?.("connected")
      handlers.onOpen?.()
      heartbeat = setInterval(() => {
        if (active.readyState === WebSocket.OPEN) active.send(JSON.stringify({ type: "ping" }))
      }, 30_000)
    }
    active.onmessage = (event) => {
      if (closed || socket !== active) return
      try {
        const payload = JSON.parse(String(event.data)) as { type: string; data?: unknown }
        if (payload.type === "message_created") handlers.onMessage?.(payload.data as IMMessage)
        if (payload.type === "message_failed")
          handlers.onFailed?.(payload.data as { clientMessageID?: string; code: string; message: string })
      } catch {
        // Ignore malformed frames — the next HTTP re-sync heals.
      }
    }
    active.onerror = () => {
      // Bun emits close after a failed handshake; that single owner schedules the retry.
    }
    active.onclose = () => {
      if (socket !== active) return
      if (heartbeat) clearInterval(heartbeat)
      if (closed) return
      handlers.onState?.("disconnected")
      attempt += 1
      retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)))
    }
  }
  signal?.addEventListener("abort", close, { once: true })
  if (signal?.aborted) close()
  if (!closed) connect()

  return { close }
}
