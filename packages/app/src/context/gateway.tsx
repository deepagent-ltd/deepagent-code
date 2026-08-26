import { createSimpleContext } from "@deepagent-code/ui/context"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "./platform"
import { ServerConnection } from "./server"
import {
  type ContainerResponse,
  type GatewayClient,
  type GatewayUser,
  createGatewayClient,
} from "@/utils/gateway-client"

export type GatewaySessionState = "anonymous" | "authenticated"

interface GatewaySession {
  client: GatewayClient
  user?: GatewayUser
}

/**
 * Owns the live Server Edition (gateway) sessions — one `GatewayClient` per
 * gateway URL, keyed by connection. Holds the in-memory access token, the
 * logged-in user, and container status, and exposes an authenticating `fetch`
 * that injects the live bearer and transparently refreshes on 401.
 *
 * The SDK/IM layers read `server.current.http.bearer` for the initial header,
 * but the authenticating fetch is what keeps long-lived streams valid as the
 * short (~15m) access token rotates.
 */
function createGateway() {
  const platform = usePlatform()
  const baseFetch = platform.fetch ?? globalThis.fetch
  const sessions = new Map<string, GatewaySession>()

  const [state, setState] = createStore({
    // Reactive view of the current bearer per connection key, so consumers can
    // rebuild SDK headers when the token changes.
    tokens: {} as Record<string, string | null>,
    users: {} as Record<string, GatewayUser | undefined>,
    containers: {} as Record<string, ContainerResponse | undefined>,
  })
  const [busy, setBusy] = createSignal(false)

  const clientFor = (conn: ServerConnection.Server): GatewaySession => {
    const key = ServerConnection.key(conn)
    const existing = sessions.get(key)
    if (existing) return existing
    const client = createGatewayClient({
      gatewayUrl: conn.gatewayUrl,
      fetch: baseFetch,
      onAccessToken: (token) => setState("tokens", key, token),
    })
    const session: GatewaySession = { client }
    sessions.set(key, session)
    return session
  }

  const login = async (conn: ServerConnection.Server, email: string, password: string) => {
    setBusy(true)
    try {
      const session = clientFor(conn)
      const result = await session.client.login(email, password)
      session.user = result.user
      setState("users", ServerConnection.key(conn), result.user)
      return result
    } finally {
      setBusy(false)
    }
  }

  const logout = async (conn: ServerConnection.Server) => {
    const key = ServerConnection.key(conn)
    const session = sessions.get(key)
    if (session) await session.client.logout()
    setState("users", key, undefined)
    setState("containers", key, undefined)
  }

  // Ensure the caller's container exists and is running, polling until ready.
  const ensureContainer = async (
    conn: ServerConnection.Server,
    opts?: { imageTag?: string; timeoutMs?: number; onStatus?: (c: ContainerResponse) => void },
  ): Promise<ContainerResponse> => {
    const key = ServerConnection.key(conn)
    const { client } = clientFor(conn)
    const deadline = Date.now() + (opts?.timeoutMs ?? 120_000)

    let container = await client.ensureContainer(opts?.imageTag)
    setState("containers", key, container)
    opts?.onStatus?.(container)

    while (container.status !== "running") {
      if (container.status === "error" || container.status === "deleted") {
        throw new Error(`Container is in state "${container.status}"`)
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the workspace container to start")
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const next = await client.getContainer()
      if (!next) throw new Error("Container disappeared while starting")
      container = next
      setState("containers", key, container)
      opts?.onStatus?.(container)
    }
    return container
  }

  // Authenticating fetch for a given gateway connection: injects the live
  // bearer and refreshes once on 401. Used as the SDK/event-stream fetch so
  // long-lived connections survive access-token rotation. Typed as the DOM
  // fetch (incl. the `preconnect` static) so it drops into SDK config cleanly.
  const fetchFor = (conn: ServerConnection.Server): typeof globalThis.fetch => {
    const authFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const { client } = clientFor(conn)
      const withAuth = (token: string | null): RequestInit => ({
        ...init,
        credentials: "include",
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      })
      let response = await baseFetch(input as never, withAuth(client.accessToken) as never)
      if (response.status === 401) {
        const refreshed = await client.refresh()
        if (refreshed) response = await baseFetch(input as never, withAuth(refreshed) as never)
      }
      return response
    }
    // The SDK only ever calls fetch as a function; `preconnect` is unused but
    // required by the `typeof fetch` structural type.
    return Object.assign(authFetch, { preconnect: () => {} }) as typeof globalThis.fetch
  }

  return {
    busy,
    login,
    logout,
    ensureContainer,
    fetchFor,
    client: (conn: ServerConnection.Server) => clientFor(conn).client,
    token: (conn: ServerConnection.Server) => state.tokens[ServerConnection.key(conn)] ?? null,
    user: (conn: ServerConnection.Server) => state.users[ServerConnection.key(conn)],
    container: (conn: ServerConnection.Server) => state.containers[ServerConnection.key(conn)],
  }
}

export type Gateway = ReturnType<typeof createGateway>

export const { use: useGateway, provider: GatewayProvider } = createSimpleContext({
  name: "Gateway",
  init: createGateway,
})
