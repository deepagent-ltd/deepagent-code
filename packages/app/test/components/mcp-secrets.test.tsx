import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, type JSX } from "solid-js"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { McpSecretsPanel } from "@/components/dialog-mcp-secrets"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@deepagent-code/ui/context/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@deepagent-code/ui/dialog", () => ({
  Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div>,
}))

const directory = "/owned/project"
const requests: { method: string; path: string; directory: string | null; body: Record<string, string> }[] = []
let mode = "normal"
let changed = false
let release = () => {}
let requestID = ""
const migrations = new Map<string, string>()
let client: ReturnType<typeof createDeepAgentCodeClient>
let origin = ""
const preview = {
  name: "fixture",
  source: `${directory}/deepagent-code.json`,
  previewID: "a".repeat(32),
  fields: [
    { field: "headers", key: "Authorization" },
    { field: "oauth", key: "clientSecret" },
  ],
}
const binding = () => ({
  name: "fixture",
  source: preview.source,
  previewID: "b".repeat(32),
  nextObservedProjectId: "current-project",
  old: {
    securityNamespaceId: "namespace",
    locationKey: "location",
    projectScopeKey: "project",
    indexSpaceId: "index",
    canonicalRoot: directory,
    locationCreatedAt: 1,
    projectCreatedAt: 1,
    projectIdentityHash: "c".repeat(64),
    locationObservedProjectId: changed ? "changed" : "global",
    projectObservedProjectId: "global",
  },
})
const server = createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-headers", "*")
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS")
  if (request.method === "OPTIONS") {
    response.writeHead(204)
    response.end()
    return
  }
  const url = new URL(request.url!, origin)
  const name = decodeURIComponent(url.pathname.split("/")[2] ?? "fixture")
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, string>
  requests.push({ method: request.method!, path: url.pathname, directory: url.searchParams.get("directory"), body })
  response.setHeader("content-type", "application/json")
  if (mode === "late" && url.pathname.endsWith("/credentials/preview"))
    await new Promise<void>((resolve) => {
      release = resolve
    })
  if (url.pathname.endsWith("/credentials/preview")) {
    if (mode === "init") {
      response.writeHead(503)
      response.end(JSON.stringify({ code: "unavailable", error: "unavailable" }))
      return
    }
    response.end(JSON.stringify({ ...preview, name }))
    return
  }
  if (url.pathname.endsWith("/binding/preview")) {
    response.end(JSON.stringify(binding()))
    return
  }
  if (url.pathname.endsWith("/binding/repair")) {
    response.end(JSON.stringify({ name: "fixture", source: preview.source, state: "repaired" }))
    return
  }
  if (url.pathname.endsWith("/credentials/initialize")) {
    response.end(JSON.stringify({ name: "fixture", source: preview.source }))
    return
  }
  if (url.pathname.endsWith("/credentials/commit")) {
    requestID = body.requestID!
    migrations.set(name, requestID)
    if (mode === "unknown") {
      response.writeHead(503)
      response.end(JSON.stringify({ code: "unavailable", error: "unknown" }))
      return
    }
  }
  response.end(
    JSON.stringify({
      name,
      requestID: migrations.get(name) ?? requestID,
      state: mode === "unknown" ? "stored" : "committed",
      moved: mode === "unknown" ? 0 : 2,
    }),
  )
})
beforeEach(async () => {
  requests.length = 0
  migrations.clear()
  mode = "normal"
  changed = false
  requestID = ""
  release = () => {}
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Private listener missing")
  origin = `http://127.0.0.1:${address.port}`
  client = createDeepAgentCodeClient({
    baseUrl: origin,
    directory,
    headers: { authorization: "Basic fixture" },
    throwOnError: true,
  })
})
afterEach(async () => {
  release()
  cleanup()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
const mount = (current = () => true) =>
  render(() => (
    <McpSecretsPanel
      name="fixture"
      client={client}
      directory={directory}
      server={origin}
      current={current}
      close={() => {}}
    />
  ))
const button = (key: keyof typeof dict) => screen.getByRole("button", { name: dict[key] })

it("uses actual SDK HTTP and submits only after explicit review confirmation with the original token", async () => {
  mount()
  await screen.findByText("headers.Authorization")
  expect(requests.every((request) => request.method === "GET")).toBe(true)
  fireEvent.click(button("mcp.secrets.commit"))
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(0)
  const confirm = button("mcp.secrets.confirm")
  fireEvent.click(confirm)
  fireEvent.click(confirm)
  await screen.findByText("Committed · 2")
  const posts = requests.filter((request) => request.method === "POST")
  expect(posts).toHaveLength(1)
  expect(posts[0]!.body.previewID).toBe(preview.previewID)
  expect(posts[0]!.body.requestID).toMatch(/^[a-f0-9-]{36}$/)
  expect(requests.every((request) => request.directory === directory)).toBe(true)
})

it("unknown commit retains its original request for GET and blocks a new migration", async () => {
  mode = "unknown"
  mount()
  await screen.findByText("headers.Authorization")
  fireEvent.click(button("mcp.secrets.commit"))
  fireEvent.click(button("mcp.secrets.confirm"))
  await screen.findByRole("alert")
  const original = requests.find((request) => request.path.endsWith("/commit"))!.body.requestID
  expect(button("mcp.secrets.commit").hasAttribute("disabled")).toBe(true)
  fireEvent.click(button("mcp.secrets.status"))
  await screen.findByText("Stored; Config not confirmed · 0")
  expect(requests.at(-1)!.path).toContain(original)
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
})

it("unavailable init and old binding repair remain explicit, and changed review never posts repair", async () => {
  mode = "init"
  mount()
  await screen.findByRole("alert")
  fireEvent.click(button("mcp.secrets.initialize"))
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(0)
  fireEvent.click(button("mcp.secrets.confirm"))
  await screen.findByText(dict["mcp.secrets.initialized"])
  fireEvent.click(button("mcp.secrets.bindingPreview"))
  await screen.findByText(/Current observed project ID: current-project/)
  fireEvent.click(button("mcp.secrets.repair"))
  changed = true
  fireEvent.click(button("mcp.secrets.confirm"))
  await waitFor(() => expect(button("mcp.secrets.bindingPreview").hasAttribute("disabled")).toBe(false))
  expect(requests.filter((request) => request.path.endsWith("/binding/repair"))).toHaveLength(0)
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
})

it("a host change permanently invalidates the owner and a late preview cannot restore actions", async () => {
  mode = "late"
  const [current, setCurrent] = createSignal(true)
  mount(current)
  await waitFor(() => expect(requests).toHaveLength(1))
  setCurrent(false)
  release()
  await screen.findByRole("alert")
  setCurrent(true)
  expect(button("mcp.secrets.initialize").hasAttribute("disabled")).toBe(true)
  expect(button("mcp.secrets.commit").hasAttribute("disabled")).toBe(true)
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(0)
})


it("bounds unknown migration IDs per actual client, retains across remount, and releases a known original receipt", async () => {
  mode = "unknown"
  const panel = (name: string) => render(() => (
    <McpSecretsPanel name={name} client={client} directory={directory} server={origin} current={() => true} close={() => {}} />
  ))
  for (let i = 0; i < 32; i++) {
    const view = panel(`held-${i}`)
    await screen.findByText("headers.Authorization")
    fireEvent.click(button("mcp.secrets.commit"))
    fireEvent.click(button("mcp.secrets.confirm"))
    await screen.findByRole("alert")
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(i + 1)
    view.unmount()
  }
  const blocked = panel("blocked")
  await screen.findByText("headers.Authorization")
  fireEvent.click(button("mcp.secrets.commit"))
  fireEvent.click(button("mcp.secrets.confirm"))
  await screen.findByText(`${dict["mcp.secrets.error"]} (capacity)`)
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(32)
  blocked.unmount()
  const originalID = migrations.get("held-0")!
  const retained = panel("held-0")
  await screen.findByText("Stored; Config not confirmed · 0")
  expect(requests.at(-1)!.path).toContain(originalID)
  expect(button("mcp.secrets.commit").hasAttribute("disabled")).toBe(true)
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(32)
  mode = "normal"
  fireEvent.click(button("mcp.secrets.reconcile"))
  await screen.findByText("Committed · 2")
  expect(requests.at(-1)!.path).toContain(originalID)
  retained.unmount()
  panel("blocked")
  await screen.findByText("headers.Authorization")
  fireEvent.click(button("mcp.secrets.commit"))
  fireEvent.click(button("mcp.secrets.confirm"))
  await screen.findByText("Committed · 2")
  expect(requests.filter((request) => request.path.endsWith("/commit"))).toHaveLength(33)
  expect(migrations.get("held-1")).toBeTruthy()
}, 15_000)
