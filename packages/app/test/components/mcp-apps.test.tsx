import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { Storage, type Window } from "happy-dom"
import { Dialog } from "@kobalte/core/dialog"
import { createDeepAgentCodeClient, type McpAppOpenResponse, type McpAppsResponse } from "@deepagent-code/sdk/client"
import { McpAppsPanel } from "@/components/dialog-mcp-apps"
import { LanguageProvider } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { dict } from "@/i18n/en"

const descriptor: McpAppsResponse[number] = {
  server: "owned",
  tool: "view",
  toolName: "mcp__owned__view",
  generation: "11111111-1111-4111-8111-111111111111",
  resourceUri: "ui://owned/view",
  mimeType: "text/html;profile=mcp-app",
}
const view = (): McpAppOpenResponse => ({
  viewID: "22222222-2222-4222-8222-222222222222",
  descriptor,
  html: "<!doctype html><html><body>Owned view</body></html>",
  csp: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'",
  prefersBorder: false,
  expiresAt: Date.now() + 300000,
})
const directory = "/owned/project"
const surface = window as unknown as Window
const iframePageLoading = surface.happyDOM.settings.disableIframePageLoading
const calls: {
  method: string
  path: string
  origin: string
  directory: string | null
  body: Record<string, unknown>
  signal: AbortSignal
}[] = []
const state = {
  delayed: false,
  release: undefined as (() => void) | undefined,
  invalidate: undefined as (() => void) | undefined,
  unsubscribed: 0,
  empty: false,
  close: vi.fn(),
}
const client = createDeepAgentCodeClient({
  baseUrl: "http://owned.example",
  directory,
  fetch: Object.assign(
    async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const body = request.method === "GET" ? {} : ((await request.clone().json()) as Record<string, unknown>)
      calls.push({
        method: request.method,
        path: url.pathname,
        origin: url.origin,
        directory: url.searchParams.get("directory"),
        body,
        signal: request.signal,
      })
      if (url.pathname === "/mcp/apps")
        return Response.json(
          state.empty ? [] : [descriptor, { ...descriptor, server: "foreign", resourceUri: "ui://foreign/secret" }],
        )
      if (url.pathname === "/mcp/apps/open") {
        if (state.delayed)
          await new Promise<void>((resolve) => {
            state.release = resolve
          })
        return Response.json(view())
      }
      if (url.pathname === "/mcp/apps/check") return Response.json(descriptor)
      if (url.pathname === "/mcp/apps/close") return Response.json(true)
      throw new Error(`Unexpected fixture API ${url.pathname}`)
    },
    { preconnect: () => {} },
  ),
})

const mount = (
  current = () => true,
  props?: { name: () => string; directory: () => string; client: () => typeof client },
) =>
  render(() => (
    <PlatformProvider
      value={{
        platform: "web",
        openLink: () => {},
        restart: async () => {},
        back: () => {},
        forward: () => {},
        notify: async () => {},
      }}
    >
      <LanguageProvider locale="en">
        <Dialog open>
          <McpAppsPanel
            name={props?.name() ?? "owned"}
            url="http://owned.example"
            client={props?.client() ?? client}
            directory={props?.directory() ?? directory}
            current={current}
            subscribe={(invalidate) => {
              state.invalidate = invalidate
              return () => {
                state.unsubscribed++
              }
            }}
            close={state.close}
          />
        </Dialog>
      </LanguageProvider>
    </PlatformProvider>
  ))
const button = () => screen.getByRole("button", { name: dict["mcp.apps.open"] })
const opened = () => calls.filter((call) => call.path === "/mcp/apps/open")
const closed = () => calls.filter((call) => call.path === "/mcp/apps/close")

beforeEach(() => {
  vi.stubGlobal("localStorage", new Storage())
  // Chromium verifies proxy loading and CSP separately; these component tests only observe
  // iframe mounting and disposal, and must not fetch the reserved fixture origin.
  surface.happyDOM.settings.disableIframePageLoading = true
  calls.length = 0
  state.delayed = false
  state.release = undefined
  state.invalidate = undefined
  state.unsubscribed = 0
  state.empty = false
  state.close.mockReset()
})
afterEach(() => {
  state.release?.()
  cleanup()
  surface.happyDOM.settings.disableIframePageLoading = iframePageLoading
  vi.unstubAllGlobals()
})

it("lists through the generated SDK and opens only the explicitly chosen exact server/tool snapshot", async () => {
  const panel = mount()
  await waitFor(() => expect(button().hasAttribute("disabled")).toBe(false))
  expect(calls.map((call) => call.path)).toEqual(["/mcp/apps"])
  expect(opened()).toHaveLength(0)
  expect(document.querySelector("iframe")).toBeNull()
  expect(document.body.textContent).not.toContain("ui://foreign/secret")
  fireEvent.click(button())
  await waitFor(() => expect(document.querySelector('iframe[title="MCP App"]')).not.toBeNull())
  expect(opened()).toHaveLength(1)
  expect(opened()[0]!.body).toEqual({
    server: descriptor.server,
    tool: descriptor.tool,
    generation: descriptor.generation,
    resourceUri: descriptor.resourceUri,
    consent: true,
  })
  expect(calls.every((call) => call.origin === "http://owned.example" && call.directory === directory)).toBe(true)
  panel.unmount()
  await waitFor(() => expect(closed()).toHaveLength(1))
  expect(closed()[0]!.body).toEqual({ viewID: view().viewID })
  expect(document.querySelector("iframe")).toBeNull()
  expect(state.unsubscribed).toBe(1)
})

it("a tool notification removes an existing iframe and closes its original observer without automatically reopening", async () => {
  mount()
  await waitFor(() => expect(button().hasAttribute("disabled")).toBe(false))
  fireEvent.click(button())
  await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull())
  state.invalidate!()
  await waitFor(() => expect(closed()).toHaveLength(1))
  expect(document.querySelector("iframe")).toBeNull()
  expect(button().hasAttribute("disabled")).toBe(true)
  expect(opened()).toHaveLength(1)
  expect(calls.filter((call) => call.path === "/mcp/apps")).toHaveLength(1)
  expect(screen.getByRole("alert").textContent).toBe(dict["mcp.apps.expired"])
})

it("a late open after source invalidation is retired on the original client/directory and cannot resurrect an iframe", async () => {
  state.delayed = true
  const [scope, setScope] = createStore({ current: true, name: "owned", directory, client })
  const replacement = createDeepAgentCodeClient({
    baseUrl: "http://replacement.example",
    fetch: Object.assign(
      async () => {
        throw new Error("Old owner called replacement client")
      },
      { preconnect: () => {} },
    ),
  })
  mount(() => scope.current, { name: () => scope.name, directory: () => scope.directory, client: () => scope.client })
  await waitFor(() => expect(button().hasAttribute("disabled")).toBe(false))
  fireEvent.click(button())
  await waitFor(() => expect(state.release).toBeDefined())
  const pending = opened()[0]!
  setScope({ current: false, name: "replacement", directory: "/replacement/project", client: replacement })
  await waitFor(() => expect(pending.signal.aborted).toBe(true))
  state.release!()
  await waitFor(() => expect(closed()).toHaveLength(1))
  expect(document.querySelector("iframe")).toBeNull()
  expect(closed()[0]!.origin).toBe("http://owned.example")
  expect(closed()[0]!.directory).toBe(directory)
  expect(closed()[0]!.signal.aborted).toBe(false)
  expect(calls.every((call) => call.directory === directory && call.origin === "http://owned.example")).toBe(true)
  expect(opened()).toHaveLength(1)
})

it("unmount aborts pending open and retires a completed late response without mounting a frame", async () => {
  state.delayed = true
  const panel = mount()
  await waitFor(() => expect(button().hasAttribute("disabled")).toBe(false))
  fireEvent.click(button())
  await waitFor(() => expect(state.release).toBeDefined())
  const pending = opened()[0]!
  panel.unmount()
  expect(pending.signal.aborted).toBe(true)
  expect(state.unsubscribed).toBe(1)
  state.release!()
  await waitFor(() => expect(closed()).toHaveLength(1))
  expect(document.querySelector("iframe")).toBeNull()
  expect(calls.every((call) => call.directory === directory && call.origin === "http://owned.example")).toBe(true)
})

it("an MCP with no App resources keeps open disabled and allows explicit refresh and close", async () => {
  state.empty = true
  mount()
  const refresh = screen.getByRole("button", { name: dict["oversight.common.refresh"] })
  await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(false))
  expect(screen.getByText(dict["mcp.apps.empty"])).toBeTruthy()
  expect(screen.queryByRole("combobox")).toBeNull()
  expect(button().hasAttribute("disabled")).toBe(true)
  fireEvent.click(button())
  expect(opened()).toHaveLength(0)
  expect(calls.map((call) => call.path)).toEqual(["/mcp/apps"])
  fireEvent.click(refresh)
  await waitFor(() => expect(calls.map((call) => call.path)).toEqual(["/mcp/apps", "/mcp/apps"]))
  fireEvent.click(screen.getAllByRole("button", { name: dict["common.close"] }).at(-1)!)
  expect(state.close).toHaveBeenCalledOnce()
  expect(opened()).toHaveLength(0)
  expect(closed()).toHaveLength(0)
})
