import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createStore, reconcile } from "solid-js/store"
import { createServer } from "node:http"
import { createDeepAgentCodeClient, type McpStatus } from "@deepagent-code/sdk/client"
import { McpManagement } from "@/components/mcp-management"
import { toggleMcp } from "@/context/global-sync/mcp"
import { dict } from "@/i18n/en"

const fixture = vi.hoisted(() => ({
  data: undefined as { mcp: Record<string, McpStatus> } | undefined,
  toggle: undefined as ((name: string) => Promise<void>) | undefined,
  refresh: undefined as (() => Promise<void>) | undefined,
  remove: undefined as ((name: string) => Promise<void>) | undefined,
  replace: undefined as ((mcp: Record<string, McpStatus>) => void) | undefined,
  show: vi.fn(),
}))
vi.mock("@/context/sync", () => ({
  useSync: () => ({
    data: fixture.data,
    mcp: {
      toggle: (name: string) => fixture.toggle!(name),
      refresh: () => fixture.refresh!(),
      remove: (name: string) => fixture.remove!(name),
    },
  }),
}))
vi.mock("@/context/sdk", async (original) => ({
  ...(await original<typeof import("@/context/sdk")>()),
  useSDK: () => ({ client, directory: "/owned/项目", scope: "mcp-disconnected-fixture" }),
}))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: fixture.show }) }))
vi.mock("@deepagent-code/ui/context/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))

const server = createServer(async (request, response) => {
  const url = new URL(request.url!, "http://127.0.0.1")
  requests.push({
    method: request.method!,
    path: url.pathname,
    directory:
      url.searchParams.get("directory") ??
      (typeof request.headers["x-deepagent-code-directory"] === "string"
        ? decodeURIComponent(request.headers["x-deepagent-code-directory"])
        : null),
  })
  response.setHeader("Access-Control-Allow-Origin", "*")
  response.setHeader("Access-Control-Allow-Headers", "*")
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
  if (request.method === "OPTIONS") {
    requests.pop()
    response.writeHead(204)
    response.end()
    return
  }
  if (request.method === "POST") {
    if (pending)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    nextStatus = url.pathname.endsWith("/disconnect") ? { status: "disabled" } : { status: "connected" }
  }
  if (request.method === "DELETE") removed = true
  response.setHeader("Content-Type", "application/json")
  response.end(
    JSON.stringify(
      request.method === "POST"
        ? true
        : request.method === "DELETE"
          ? { removed: true }
          : removed
            ? {}
            : { fixture: nextStatus },
    ),
  )
})
const requests: { method: string; path: string; directory: string | null }[] = []
const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
let nextStatus: McpStatus
let client: ReturnType<typeof createDeepAgentCodeClient>
let pending = false
let release = () => {}
let removed = false

beforeEach(async () => {
  requests.length = 0
  pending = false
  release = () => {}
  removed = false
  fixture.show.mockClear()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Private test listener missing")
  client = createDeepAgentCodeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory: "/owned/项目",
    throwOnError: true,
  })
  nextStatus = { status: "disconnected", authStatus: "authenticated", reason: "explicit_connect_required" }
  const [data, setData] = createStore({ mcp: { fixture: nextStatus } as Record<string, McpStatus> })
  fixture.data = data
  fixture.replace = (mcp) => setData("mcp", reconcile(mcp))
  fixture.refresh = async () => {
    setData("mcp", reconcile((await client.mcp.status()).data!))
  }
  fixture.remove = async (name) => {
    await client.mcp.removeConfig({ name })
    await fixture.refresh!()
  }
  fixture.toggle = (name) =>
    toggleMcp({
      status: data.mcp[name],
      connect: async () => {
        await client.mcp.connect({ name })
      },
      disconnect: async () => {
        await client.mcp.disconnect({ name })
      },
      authenticate: async () => {
        await client.mcp.auth.authenticate({ name })
      },
      refresh: fixture.refresh!,
    })
})

afterEach(async () => {
  release()
  cleanup()
  query.clear()
  const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  server.closeAllConnections()
  await closed
})

it("MCP empty settings show only add and explanation without unavailable contextual controls", () => {
  fixture.replace!({})
  render(() => (
    <QueryClientProvider client={query}>
      <McpManagement />
    </QueryClientProvider>
  ))
  expect(screen.getAllByRole("button")).toHaveLength(1)
  expect(screen.getByRole("button", { name: dict["dialog.mcp.add"] }).hasAttribute("disabled")).toBe(false)
  expect(screen.getByText(dict["dialog.mcp.empty"])).toBeTruthy()
  for (const key of ["mcp.apps.title", "dialog.mcp.configure", "dialog.mcp.delete", "mcp.secrets.open"] as const)
    expect(screen.queryByRole("button", { name: dict[key] })).toBeNull()
  expect(requests).toEqual([])
})

it("MCP selected settings retain actions, connected-only Apps and withdraw them after the last server disappears", () => {
  fixture.replace!({})
  render(() => (
    <QueryClientProvider client={query}>
      <McpManagement />
    </QueryClientProvider>
  ))
  fixture.replace!({ fixture: nextStatus })
  const configure = screen.getByRole("button", { name: dict["dialog.mcp.configure"] })
  const secrets = screen.getByRole("button", { name: dict["mcp.secrets.open"] })
  const apps = screen.getByRole("button", { name: dict["mcp.apps.title"] })
  expect(configure.hasAttribute("disabled")).toBe(false)
  expect(screen.getByRole("button", { name: dict["dialog.mcp.delete"] }).hasAttribute("disabled")).toBe(false)
  fireEvent.click(configure)
  fireEvent.click(secrets)
  expect(fixture.show).toHaveBeenCalledTimes(2)
  expect(apps.hasAttribute("disabled")).toBe(true)
  fireEvent.click(apps)
  expect(fixture.show).toHaveBeenCalledTimes(2)
  fixture.replace!({ fixture: { status: "connected" } })
  expect(apps.hasAttribute("disabled")).toBe(false)
  fireEvent.click(apps)
  expect(fixture.show).toHaveBeenCalledTimes(3)
  fixture.replace!({})
  expect(screen.getAllByRole("button")).toHaveLength(1)
  expect(screen.queryByRole("button", { name: dict["mcp.apps.title"] })).toBeNull()
  expect(requests).toEqual([])
})

it("renders a cold verified connection as disconnected and connects only on an explicit control", async () => {
  render(() => (
    <QueryClientProvider client={query}>
      <McpManagement />
    </QueryClientProvider>
  ))
  expect(screen.getByText(dict["mcp.status.disconnected"])).toBeTruthy()
  expect(screen.getByText(dict["mcp.connection.authenticated"])).toBeTruthy()
  expect(requests).toEqual([])
  const control = screen.getByRole("switch", { name: dict["mcp.action.connect"] })
  expect(control.getAttribute("aria-checked")).toBe("false")
  fireEvent.click(control)
  await waitFor(() =>
    expect(requests.map((row) => `${row.method} ${row.path}`)).toEqual(["POST /mcp/fixture/connect", "GET /mcp"]),
  )
  expect(requests[1].directory).toBe("/owned/项目")
  await waitFor(() =>
    expect(screen.getByRole("switch", { name: dict["mcp.action.disconnect"] }).getAttribute("aria-checked")).toBe(
      "true",
    ),
  )
})

it("unknown outcome presents a disabled connection and an explicit read-only status refresh", async () => {
  nextStatus = { status: "disconnected", authStatus: "unknown", reason: "unknown_outcome" }
  await fixture.refresh!()
  requests.length = 0
  render(() => (
    <QueryClientProvider client={query}>
      <McpManagement />
    </QueryClientProvider>
  ))
  expect(screen.getByText(dict["mcp.connection.unknown_outcome"])).toBeTruthy()
  const control = screen.getByRole("switch", { name: dict["mcp.action.connect"] })
  expect(control.hasAttribute("disabled")).toBe(true)
  fireEvent.click(control)
  expect(requests).toEqual([])
  fireEvent.click(screen.getByRole("button", { name: dict["mcp.action.refresh"] }))
  await waitFor(() => expect(requests.map((row) => `${row.method} ${row.path}`)).toEqual(["GET /mcp"]))
  expect(requests[0].directory).toBe("/owned/项目")
  expect(screen.getByText(dict["mcp.connection.unknown_outcome"])).toBeTruthy()
})

it("selects the requested row before deleting and respects both confirmation choices", async () => {
  fixture.replace!({ zebra: { status: "disabled" }, alpha: { status: "connected" } })
  render(() => (
    <QueryClientProvider client={query}>
      <McpManagement />
    </QueryClientProvider>
  ))
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
  fireEvent.click(screen.getByRole("button", { name: "zebra" }))
  fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.delete"] }))
  expect(confirm).toHaveBeenCalledOnce()
  expect(requests).toEqual([])
  expect(screen.getByRole("button", { name: "zebra" })).toBeTruthy()
  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.delete"] }))
  await waitFor(() =>
    expect(requests.map((row) => `${row.method} ${row.path}`)).toEqual(["DELETE /mcp/zebra/config", "GET /mcp"]),
  )
  await waitFor(() => expect(screen.queryByRole("button", { name: "zebra" })).toBeNull())
  expect(screen.getByText(dict["dialog.mcp.empty"])).toBeTruthy()
  expect(requests.every((row) => row.directory === "/owned/项目")).toBe(true)
})

it("keeps the pending switch disabled and sends one connect before showing the refreshed state", async () => {
  pending = true
  fixture.replace!({ fixture: nextStatus, zebra: { status: "disabled" } })
  render(() => (
    <QueryClientProvider client={query}>
      <McpManagement />
    </QueryClientProvider>
  ))
  const controls = screen.getAllByRole("switch", { name: dict["mcp.action.connect"] })
  const control = controls[0]
  fireEvent.click(control)
  await waitFor(() => expect(requests).toHaveLength(1))
  await waitFor(() => expect(control.hasAttribute("disabled")).toBe(true))
  expect(controls.every((element) => element.hasAttribute("disabled"))).toBe(true)
  expect(control.getAttribute("aria-checked")).toBe("false")
  fireEvent.click(control)
  fireEvent.click(controls[1])
  expect(requests).toHaveLength(1)
  release()
  await waitFor(() =>
    expect(screen.getByRole("switch", { name: dict["mcp.action.disconnect"] }).getAttribute("aria-checked")).toBe(
      "true",
    ),
  )
  expect(requests.map((row) => `${row.method} ${row.path}`)).toEqual(["POST /mcp/fixture/connect", "GET /mcp"])
})

it("explains failed connections and required client registration without enabling Apps", () => {
  fixture.replace!({
    failed: { status: "failed", error: "connect ECONNREFUSED 127.0.0.1:9926" },
    registration: { status: "needs_client_registration", error: "Register a client in Configure" },
  })
  render(() => (
    <QueryClientProvider client={query}>
      <McpManagement />
    </QueryClientProvider>
  ))
  expect(screen.getByText("connect ECONNREFUSED 127.0.0.1:9926")).toBeTruthy()
  expect(screen.getByText("Register a client in Configure")).toBeTruthy()
  expect(screen.getByRole("button", { name: dict["dialog.mcp.configure"] }).hasAttribute("disabled")).toBe(false)
  expect(screen.getByRole("button", { name: dict["mcp.apps.title"] }).hasAttribute("disabled")).toBe(true)
  expect(requests).toEqual([])
})

it("uses the authentication endpoint for needs_auth and disconnects only after connection succeeds", async () => {
  fixture.replace!({ fixture: { status: "needs_auth" } })
  render(() => (
    <QueryClientProvider client={query}>
      <McpManagement />
    </QueryClientProvider>
  ))
  expect(screen.getByText(dict["mcp.auth.clickToAuthenticate"])).toBeTruthy()
  const apps = screen.getByRole("button", { name: dict["mcp.apps.title"] })
  expect(apps.hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("switch", { name: dict["mcp.action.authenticate"] }))
  await waitFor(() => expect(apps.hasAttribute("disabled")).toBe(false))
  expect(requests.map((row) => `${row.method} ${row.path}`)).toEqual([
    "POST /mcp/fixture/auth/authenticate",
    "GET /mcp",
  ])
  fireEvent.click(screen.getByRole("switch", { name: dict["mcp.action.disconnect"] }))
  await waitFor(() =>
    expect(screen.getByRole("switch", { name: dict["mcp.action.connect"] }).getAttribute("aria-checked")).toBe("false"),
  )
  expect(requests.map((row) => `${row.method} ${row.path}`)).toEqual([
    "POST /mcp/fixture/auth/authenticate",
    "GET /mcp",
    "POST /mcp/fixture/disconnect",
    "GET /mcp",
  ])
})

it("opens add only on explicit click and refuses new actions after its project owner retires", () => {
  const [owner, setOwner] = createStore({ current: true })
  render(() => (
    <QueryClientProvider client={query}>
      <McpManagement current={() => owner.current} />
    </QueryClientProvider>
  ))
  fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.add"] }))
  expect(fixture.show).toHaveBeenCalledOnce()
  setOwner("current", false)
  fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.add"] }))
  fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.configure"] }))
  fireEvent.click(screen.getByRole("button", { name: dict["mcp.secrets.open"] }))
  fireEvent.click(screen.getByRole("switch", { name: dict["mcp.action.connect"] }))
  expect(fixture.show).toHaveBeenCalledOnce()
  expect(requests).toEqual([])
})
