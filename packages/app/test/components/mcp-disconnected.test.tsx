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
  replace: undefined as ((mcp: Record<string, McpStatus>) => void) | undefined,
  show: vi.fn(),
}))
vi.mock("@/context/sync", () => ({
  useSync: () => ({
    data: fixture.data,
    mcp: {
      toggle: (name: string) => fixture.toggle!(name),
      refresh: () => fixture.refresh!(),
      remove: async () => {},
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

const server = createServer((request, response) => {
  const url = new URL(request.url!, "http://127.0.0.1")
  requests.push({ method: request.method!, path: url.pathname, directory: url.searchParams.get("directory") })
  response.setHeader("Access-Control-Allow-Origin", "*")
  response.setHeader("Access-Control-Allow-Headers", "*")
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  if (request.method === "OPTIONS") {
    requests.pop()
    response.writeHead(204)
    response.end()
    return
  }
  if (request.method === "POST") nextStatus = { status: "connected" }
  response.setHeader("Content-Type", "application/json")
  response.end(JSON.stringify(request.method === "POST" ? true : { fixture: nextStatus }))
})
const requests: { method: string; path: string; directory: string | null }[] = []
const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
let nextStatus: McpStatus
let client: ReturnType<typeof createDeepAgentCodeClient>

beforeEach(async () => {
  requests.length = 0
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
    setData("mcp", (await client.mcp.status()).data!)
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
