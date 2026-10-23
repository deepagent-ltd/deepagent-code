import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createServer } from "node:http"
import { createDeepAgentCodeClient, type Config } from "@deepagent-code/sdk/client"
import { createServerSyncContextInner } from "@/context/server-sync"
import type { ServerSDK } from "@/context/server-sdk"
import { ServerScope } from "@/utils/server-scope"
import { normalizeProviderList } from "@/context/global-sync/utils"

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

async function fixture() {
  const state = {
    config: { disabled_providers: [] } as Config,
    projectEmpty: false,
    providerUnavailable: false,
    holdProject: false,
    releases: [] as (() => void)[],
    providerRequests: 0,
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "*")
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const url = new URL(request.url!, "http://127.0.0.1")
    response.setHeader("Content-Type", "application/json")
    if (url.pathname === "/provider") {
      state.providerRequests++
      if (state.holdProject && url.searchParams.has("directory"))
        await new Promise<void>((resolve) => state.releases.push(resolve))
      if (state.providerUnavailable) {
        response.writeHead(503).end(JSON.stringify({ message: "Provider list unavailable" }))
        return
      }
      const empty = state.projectEmpty && url.searchParams.has("directory")
      response.end(
        JSON.stringify({
          all: empty ? [] : [{ id: "fixture", name: "Fixture", env: [], models: {} }],
          connected: empty ? [] : ["fixture"],
          default: {},
        }),
      )
      return
    }
    response.end(JSON.stringify(url.pathname === "/global/config" || url.pathname === "/config" ? state.config : {}))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(async () => {
    state.releases.splice(0).forEach((release) => release())
    const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    server.closeAllConnections()
    await closed
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Provider fixture listener missing")
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
  query.setQueryData(
    [ServerScope.local, null, "providers"],
    normalizeProviderList((await sdk.client.provider.list()).data!),
  )
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
  await waitFor(() => expect(captured.sync?.data.provider.connected).toEqual(["fixture"]))
  const sync = captured.sync!
  const child = sync.child("/owned/project", { bootstrap: false })
  await waitFor(() => expect(child[0].provider_ready).toBe(true))
  return { state, sync, child }
}

it("keeps a successful empty project provider response instead of borrowing global providers", async () => {
  const api = await fixture()
  api.state.projectEmpty = true
  await api.sync.refreshProviders()
  await waitFor(() => expect(api.child[0].provider.all.size).toBe(0))
  expect(api.child[0].provider.connected).toEqual([])
  expect(api.sync.data.provider.connected).toEqual(["fixture"])
})

it("awaits refreshed project provider and configuration state before completing a connection refresh", async () => {
  const api = await fixture()
  api.state.config = { disabled_providers: ["retired"] }
  api.state.holdProject = true
  const completion = { done: false }
  const refresh = Promise.resolve(api.sync.refreshProviders()).then(() => {
    completion.done = true
  })
  await waitFor(() => expect(api.state.releases.length).toBeGreaterThan(0))
  expect(completion.done).toBe(false)
  api.state.holdProject = false
  api.state.releases.splice(0).forEach((release) => release())
  await refresh
  expect(api.sync.data.config.disabled_providers).toEqual(["retired"])
  expect(api.child[0].config.disabled_providers).toEqual(["retired"])
})

it("reports an explicit provider refresh failure instead of confirming stale data", async () => {
  const api = await fixture()
  api.state.providerUnavailable = true
  await expect(api.sync.refreshProviders({ throwOnError: true })).rejects.toThrow("Provider list unavailable")
})
