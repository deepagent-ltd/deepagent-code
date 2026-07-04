import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"
import type { AgentDescriptor, IMGroup, IMMessage } from "@/components/im/types"

export interface IMClientConfig {
  /** Server base URL (e.g. http://127.0.0.1:PORT, or <gateway>/w in server mode). */
  url: string
  /** Active project directory — routed to the server as `?directory=`. */
  directory: string
  /** Grouping workspace id, when a routed workspace is available. */
  workspace?: string
  username?: string
  password?: string
  /** JWT bearer for Server Edition (gateway) connections. Takes precedence over Basic. */
  bearer?: string
}

export interface IMMessagePage {
  messages: IMMessage[]
  nextCursor: string | null
  hasMore: boolean
}

function authHeaders(config: IMClientConfig): Record<string, string> {
  if (config.bearer) return { Authorization: `Bearer ${config.bearer}` }
  if (!config.password) return {}
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: config.username, password: config.password })}`,
  }
}

/**
 * Authenticated client for the IM HTTP + WebSocket API.
 *
 * The IM API is defined as its own `HttpApi` (not part of the generated SDK
 * client), so we hand-roll the requests here — but we route them through the
 * same base URL, Basic auth, and `?directory=` routing the rest of the app uses
 * via the SDK. Config is read lazily through an accessor so credentials and the
 * active directory stay reactive.
 */
export function createIMClient(config: () => IMClientConfig) {
  const buildURL = (path: string, query?: Record<string, string | undefined>) => {
    const c = config()
    const base = new URL(c.url, typeof location !== "undefined" ? location.href : undefined)
    // Append `path` onto the base's pathname rather than treating it as an
    // absolute path — the Server Edition base URL is `<gateway>/w`, and a bare
    // `new URL("/ws/...", base)` would discard the `/w` prefix, breaking the
    // gateway proxy route. Join with exactly one slash.
    const basePath = base.pathname.replace(/\/+$/, "")
    const url = new URL(base.origin + basePath + (path.startsWith("/") ? path : `/${path}`))
    if (c.directory) url.searchParams.set("directory", c.directory)
    if (c.workspace) url.searchParams.set("workspace", c.workspace)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    return url
  }

  const request = async <T>(
    path: string,
    options?: { method?: string; query?: Record<string, string | undefined>; body?: unknown },
  ): Promise<T> => {
    const c = config()
    const headers: Record<string, string> = { ...authHeaders(c) }
    // Also send the directory as a header, not just `?directory=`. The Server
    // Edition gateway's HTTP proxy forwards the path but DROPS the query string
    // (only WebSocket upgrades preserve it), so a query-only directory would be
    // lost end-to-end. The header survives the proxy and is what the SDK uses.
    if (c.directory) headers["x-deepagent-code-directory"] = c.directory
    if (c.workspace) headers["x-deepagent-code-workspace"] = c.workspace
    const init: RequestInit = { method: options?.method ?? "GET", headers }
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(options.body)
    }
    const response = await fetch(buildURL(path, options?.query), init)
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`IM request failed (${response.status}): ${text || response.statusText}`)
    }
    return (await response.json()) as T
  }

  return {
    listGroups: () => request<IMGroup[]>(`/api/v1/im/groups`),
    createGroup: (payload: { name: string; type: "project" | "system"; projectID?: string }) =>
      request<IMGroup>(`/api/v1/im/groups`, { method: "POST", body: payload }),
    listMessages: (groupID: string, limit = 50, cursor?: string) =>
      request<IMMessagePage>(`/api/v1/im/groups/${groupID}/messages`, {
        query: { limit: String(limit), cursor },
      }),
    createMessage: (
      groupID: string,
      payload: { content: string; type?: string; mentions?: string[]; replyToID?: string },
    ) =>
      request<IMMessage>(`/api/v1/im/groups/${groupID}/messages`, {
        method: "POST",
        body: { senderType: "user", type: payload.type ?? "text", ...payload },
      }),
    markRead: (groupID: string, readAt?: number) =>
      request<{ ok: boolean }>(`/api/v1/im/groups/${groupID}/read`, {
        method: "POST",
        body: { readAt },
      }),
    listAgents: () => request<AgentDescriptor[]>(`/api/v1/im/agents`),
    // Server Edition only: set the `access_token` cookie the gateway reads to
    // authenticate the WebSocket upgrade (browsers can't set WS headers). No-op
    // for self-hosted (which uses the `auth_token` query instead) or outside a
    // document context. The cookie is scoped to the gateway origin's `/w` path.
    setWebSocketAuthCookie: () => {
      const c = config()
      if (!c.bearer || typeof document === "undefined") return
      try {
        const base = new URL(c.url, typeof location !== "undefined" ? location.href : undefined)
        const secure = base.protocol === "https:" ? "; Secure" : ""
        document.cookie = `access_token=${encodeURIComponent(c.bearer)}; Path=/; SameSite=None${secure}`
      } catch {
        // Ignore malformed base URLs.
      }
    },
    webSocketURL: (groupID: string) => {
      const c = config()
      const url = buildURL(`/ws/im/group/${groupID}`)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      // Server Edition: the gateway authenticates the WS upgrade via the JWT
      // (bearer or an `access_token` cookie) and injects Basic to the container
      // downstream — so we must NOT append the container's `auth_token` here.
      // `directory` still travels as a query param (the gateway's WS proxy
      // preserves the query string, unlike its HTTP proxy). The bearer is
      // delivered out-of-band via an `access_token` cookie (see setWebSocketAuthCookie).
      if (c.bearer) return url.toString()
      // Self-hosted: browsers can't set WS headers, so Basic travels as the
      // `auth_token` base64 query, exactly like the PTY connect endpoint.
      if (c.password) {
        url.searchParams.set(
          "auth_token",
          authTokenFromCredentials({ username: c.username, password: c.password }),
        )
      }
      return url.toString()
    },
  }
}

export type IMClient = ReturnType<typeof createIMClient>

/**
 * Build an IM client bound to the current SDK/server context. Must be called
 * under `SDKProvider` (the `/:dir` layout) so a directory is available.
 */
export function useIMClient(): IMClient {
  const sdk = useSDK()
  const server = useServer()
  return createIMClient(() => ({
    url: sdk.url,
    directory: sdk.directory,
    username: server.current?.http.username,
    password: server.current?.http.password,
    bearer: server.current?.http.bearer,
  }))
}
