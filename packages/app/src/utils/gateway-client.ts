// Client for the DeepAgent Server Edition control-plane gateway.
//
// The gateway (deepagent-server) exposes:
//   - Control plane under `/control/v1/*` — JWT-authenticated (Bearer).
//   - A transparent workspace-agent proxy under `/w` — everything after `/w`
//     is forwarded verbatim to the user's container's deepagent-code data-plane.
//
// Contract (verified against the deepagent-server repo, not the design doc):
//   - POST /control/v1/auth/login   { email, password }
//       → 200 { accessToken, user }   (+ Set-Cookie: refresh_token, HttpOnly)
//   - POST /control/v1/auth/refresh  (refresh_token cookie)  → 200 { accessToken }
//   - POST /control/v1/auth/logout   → 200
//   - GET  /control/v1/containers    → 200 ContainerResponse | 404 CONTAINER_NOT_FOUND
//   - POST /control/v1/containers    { imageTag? } → 200 (exists) | 202 (provisioning)
//   - The access token is returned in the JSON body only; the refresh token is
//     an HttpOnly cookie the browser/webview stores and replays automatically.
//   - Access token is short-lived (~15m); on 401 we refresh once and retry.

export interface GatewayUser {
  id: string
  email: string
  displayName?: string
  role: string
  orgId: string
}

export type ContainerStatus = "none" | "creating" | "running" | "suspended" | "deleted" | "error"

export interface ContainerResponse {
  id: string
  userId: string
  status: ContainerStatus
  containerId?: string
  imageVersion: string
  deepagentCodeVersion: string
  lastActive?: number
  createdAt: number
}

export interface LoginResult {
  accessToken: string
  user: GatewayUser
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = "GatewayError"
  }
}

/** Normalize a gateway base URL: strip trailing slashes. */
export function normalizeGatewayUrl(input: string): string | undefined {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

/** The base URL a deepagent-code SDK/IM client targets in server mode: `<gateway>/w`. */
export function workspaceBaseUrl(gatewayUrl: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}/w`
}

interface GatewayClientOptions {
  gatewayUrl: string
  fetch?: typeof globalThis.fetch
  /** Called whenever a fresh access token is obtained (login or refresh). */
  onAccessToken?: (token: string | null) => void
}

async function parseError(response: Response): Promise<GatewayError> {
  let code: string | undefined
  let message = `${response.status} ${response.statusText}`
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } }
    if (body?.error) {
      code = body.error.code
      message = body.error.message ?? message
    }
  } catch {
    // Non-JSON body; keep the status text.
  }
  return new GatewayError(response.status, code, message)
}

/**
 * A stateful gateway client. Holds the current access token in memory (the
 * refresh token lives in an HttpOnly cookie the fetch layer replays with
 * `credentials: "include"`). Not persisted — on app restart the client
 * refreshes from the cookie, or the user logs in again.
 */
export function createGatewayClient(options: GatewayClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch
  const control = (path: string) => `${options.gatewayUrl}/control/v1${path}`
  let accessToken: string | null = null

  const setAccessToken = (token: string | null) => {
    accessToken = token
    options.onAccessToken?.(token)
  }

  const login = async (email: string, password: string): Promise<LoginResult> => {
    const response = await doFetch(control("/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include", // accept the refresh_token Set-Cookie
      body: JSON.stringify({ email, password }),
    })
    if (!response.ok) throw await parseError(response)
    const result = (await response.json()) as LoginResult
    setAccessToken(result.accessToken)
    return result
  }

  // Refresh the access token from the refresh_token cookie. Returns the new
  // token, or null if the session is gone (401) — the caller should re-login.
  const refresh = async (): Promise<string | null> => {
    const response = await doFetch(control("/auth/refresh"), {
      method: "POST",
      credentials: "include",
    })
    if (response.status === 401) {
      setAccessToken(null)
      return null
    }
    if (!response.ok) throw await parseError(response)
    const result = (await response.json()) as { accessToken: string }
    setAccessToken(result.accessToken)
    return result.accessToken
  }

  const logout = async (): Promise<void> => {
    try {
      await doFetch(control("/auth/logout"), { method: "POST", credentials: "include" })
    } finally {
      setAccessToken(null)
    }
  }

  // Authenticated control-plane request with a single refresh-and-retry on 401.
  const authed = async (path: string, init?: RequestInit): Promise<Response> => {
    const send = (token: string | null) =>
      doFetch(control(path), {
        ...init,
        credentials: "include",
        headers: {
          ...init?.headers,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      })
    let response = await send(accessToken)
    if (response.status === 401) {
      const refreshed = await refresh()
      if (refreshed) response = await send(refreshed)
    }
    return response
  }

  const getContainer = async (): Promise<ContainerResponse | null> => {
    const response = await authed("/containers", { method: "GET" })
    if (response.status === 404) return null
    if (!response.ok) throw await parseError(response)
    return (await response.json()) as ContainerResponse
  }

  // Idempotent: creates the caller's container if absent (202) or returns the
  // existing one (200). Poll getContainer() until status === "running".
  const ensureContainer = async (imageTag?: string): Promise<ContainerResponse> => {
    const response = await authed("/containers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(imageTag ? { imageTag } : {}),
    })
    if (!response.ok) throw await parseError(response)
    return (await response.json()) as ContainerResponse
  }

  return {
    get accessToken() {
      return accessToken
    },
    setAccessToken,
    login,
    refresh,
    logout,
    getContainer,
    ensureContainer,
    /** The workspace-agent base URL SDK clients should target. */
    workspaceBaseUrl: () => workspaceBaseUrl(options.gatewayUrl),
  }
}

export type GatewayClient = ReturnType<typeof createGatewayClient>
