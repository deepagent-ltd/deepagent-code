import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createServer } from "node:http"
import { createDeepAgentCodeClient, type Config } from "@deepagent-code/sdk/client"
import { createServerSyncContextInner } from "@/context/server-sync"
import type { ServerSDK } from "@/context/server-sdk"
import { ServerScope } from "@/utils/server-scope"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/global-sync/bootstrap", async (original) => ({
  ...(await original<typeof import("@/context/global-sync/bootstrap")>()),
  bootstrapGlobal: async () => {},
  bootstrapDirectory: async () => {},
}))
vi.mock("@/utils/persist", async (original) => ({
  ...(await original<typeof import("@/utils/persist")>()),
  persisted: (_target: unknown, store: unknown[]) => [
    store[0],
    store[1],
    null,
    Object.assign(() => true, { promise: undefined }),
  ],
}))

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  cleanup()
  await Promise.all(closers.splice(0).map((close) => close()))
})

it("MCP add, edit and remove refresh the selected project's actual configuration before reopening its dialog", async () => {
  const state = {
    config: { mcp: {} } as Config,
    globalUnavailable: false,
    connectUnavailable: false,
    catalogUnavailable: false,
  }
  const projectOnly = { type: "local" as const, command: ["echo", "project"], enabled: false }
  const requests: { method: string; path: string; directory: string | null }[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "*")
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const url = new URL(request.url!, "http://127.0.0.1")
    requests.push({ method: request.method!, path: url.pathname, directory: url.searchParams.get("directory") })
    response.setHeader("Content-Type", "application/json")
    if (url.pathname === "/global/config" && request.method === "GET" && state.globalUnavailable) {
      response.writeHead(503).end(JSON.stringify({ message: "Global configuration unavailable" }))
      return
    }
    if (url.pathname === "/mcp/fixture/connect" && state.connectUnavailable) {
      response.writeHead(500).end(JSON.stringify({ message: "Connect unavailable" }))
      return
    }
    if (url.pathname === "/mcp/catalog/enable" && state.catalogUnavailable) {
      response.writeHead(500).end(JSON.stringify({ message: "Catalog connection unavailable" }))
      return
    }
    if (url.pathname === "/global/config" && request.method === "PATCH") {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      state.config = JSON.parse(Buffer.concat(chunks).toString())
    }
    if (url.pathname === "/mcp/fixture/config" && request.method === "DELETE") {
      delete state.config.mcp?.fixture
      response.end(JSON.stringify({ removed: true }))
      return
    }
    const value =
      url.pathname === "/global/config"
        ? state.config
        : url.pathname === "/config"
          ? { ...state.config, mcp: { ...state.config.mcp, projectOnly } }
          : url.pathname === "/provider"
            ? { all: [], connected: [], default: {} }
            : url.pathname === "/path"
              ? { directory: url.searchParams.get("directory") ?? "/owned" }
              : url.pathname === "/mcp"
                ? Object.fromEntries(
                    Object.keys(state.config.mcp ?? {}).map((name) => [
                      name,
                      {
                        status: state.connectUnavailable ? "failed" : "connected",
                        ...(state.connectUnavailable ? { error: "Connection failed" } : {}),
                      },
                    ]),
                  )
                : request.method === "POST"
                  ? true
                  : []
    response.end(JSON.stringify(value))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    server.closeAllConnections()
    await closed
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("MCP configuration listener missing")
  const url = `http://127.0.0.1:${address.port}`
  const sdk: ServerSDK = {
    scope: ServerScope.local,
    url,
    client: createDeepAgentCodeClient({ baseUrl: url, throwOnError: true }),
    event: { listen: () => () => {}, on: () => () => {}, start: async () => {} },
    createClient: (options) => createDeepAgentCodeClient({ baseUrl: url, ...options }),
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  closers.push(async () => query.clear())
  const captured: { sync?: ReturnType<typeof createServerSyncContextInner> } = {}
  function Harness() {
    captured.sync = createServerSyncContextInner(sdk)
    return null
  }
  render(() => (
    <QueryClientProvider client={query}>
      <Harness />
    </QueryClientProvider>
  ))
  await waitFor(() => expect(captured.sync?.data.config).toEqual({ mcp: {} }))
  const sync = captured.sync!
  const child = sync.child("/owned/project", { bootstrap: false, mcp: true })
  child[1]("config", { mcp: {} })
  const added = { type: "remote" as const, url: "http://127.0.0.1:9/first", oauth: false as const }
  await sync.mcp.add("/owned/project", { name: "fixture", config: added })
  expect(child[0].config.mcp?.fixture).toEqual(added)
  expect(child[0].config.mcp?.projectOnly).toEqual(projectOnly)
  expect(sync.data.config.mcp?.projectOnly).toBeUndefined()
  const edited = { ...added, url: "http://127.0.0.1:9/edited", enabled: false }
  await sync.mcp.update("/owned/project", { name: "fixture", config: edited })
  expect(child[0].config.mcp?.fixture).toEqual(edited)
  state.connectUnavailable = true
  const unavailable = { ...edited, enabled: true }
  await expect(sync.mcp.update("/owned/project", { name: "fixture", config: unavailable })).rejects.toThrow(
    "Connect unavailable",
  )
  expect(child[0].config.mcp?.fixture).toEqual(unavailable)
  expect(child[0].mcp.fixture?.status).toBe("failed")
  state.connectUnavailable = false
  await sync.mcp.remove("/owned/project", "fixture")
  expect(child[0].config.mcp?.fixture).toBeUndefined()
  expect(child[0].config.mcp?.projectOnly).toEqual(projectOnly)
  expect(requests.filter((request) => request.path === "/config")).toEqual([
    { method: "GET", path: "/config", directory: "/owned/project" },
    { method: "GET", path: "/config", directory: "/owned/project" },
    { method: "GET", path: "/config", directory: "/owned/project" },
    { method: "GET", path: "/config", directory: "/owned/project" },
  ])
  state.catalogUnavailable = true
  const observed = requests.filter((request) => request.path === "/mcp").length
  await expect(
    sync.mcp.catalogEnable("/owned/project", { id: "fixture", params: {}, credentialRefs: {} }),
  ).rejects.toThrow("Catalog connection unavailable")
  expect(requests.filter((request) => request.path === "/mcp")).toHaveLength(observed + 1)
  state.globalUnavailable = true
  await expect(sync.mcp.refresh("/owned/project")).rejects.toThrow("Global configuration unavailable")
})
