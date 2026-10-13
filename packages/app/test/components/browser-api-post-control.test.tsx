import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { createServer } from "node:http"
import { webcrypto } from "node:crypto"
import { Schema } from "effect"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { DialogBrowserControl } from "@/components/dialog-browser-control"
import { dict } from "@/i18n/en"

const wiring: { sdk?: { client: ReturnType<typeof createDeepAgentCodeClient>; directory: string; scope: string }; close: ReturnType<typeof vi.fn> } =
  vi.hoisted(() => ({ sdk: undefined, close: vi.fn() }))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ close: wiring.close }) }))
vi.mock("@deepagent-code/ui/dialog", () => ({ Dialog: (props: { title: string; children: JSX.Element }) =>
  <section aria-label={props.title}>{props.children}</section> }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); wiring.close.mockClear() })

// Real approval component and generated SDK talk to a controlled HTTP peer. Its synthetic
// verified view is not a Main/native descriptor, provider turn or canonical execution proof.
const configuration = { origin: "https://example.com", approvedOrigins: ["https://example.com", "https://assets.example.com"],
  resolverPolicy: "cloudflare_doh_v1", pageMode: "dynamic", apiPostTargets: [{ url: "https://example.com/api?version=1",
    contentTypes: ["application/json", "text/plain"], maxBodyBytes: 1024 }] }

async function select(label: string, option: string) {
  const button = within(screen.getByRole("group", { name: label })).getByRole("button")
  button.focus()
  fireEvent.keyDown(button, { key: "ArrowDown" })
  const target = await screen.findByRole("option", { name: option })
  target.focus()
  fireEvent.keyDown(target, { key: "Enter" })
}

async function peer() {
  vi.stubGlobal("crypto", webcrypto)
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = []
  const state: { unknownFirst: boolean; wrongScopeAt: number; completed: number; gates: Promise<void>[] } =
    { unknownFirst: false, wrongScopeAt: 0, completed: 0, gates: [] }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(new Uint8Array(chunk))
    const body = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(Buffer.concat(chunks).toString())
    calls.push({ method: request.method ?? "", path: request.url ?? "", body })
    const ordinal = calls.length
    await state.gates[ordinal - 1]
    state.completed++
    response.setHeader("Content-Type", "application/json")
    if (state.unknownFirst && ordinal === 1) { response.writeHead(503); response.end(JSON.stringify({ code: "BROWSER_UNKNOWN" })); return }
    response.end(JSON.stringify({ control: { ...body, controlID: "api-control", revision: 1, state: "active",
      scope: { sessionID: state.wrongScopeAt === ordinal ? "foreign-session" : "api-session", directory: "/api-project" } },
      availability: "available", nativeVerification: "verified", stopConfirmed: false }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Controlled HTTP peer was not bound")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const sdk = { client: createDeepAgentCodeClient({ baseUrl }), directory: "/api-project", scope: "api-scope" }
  wiring.sdk = sdk
  return { calls, state, sdk, baseUrl, async close() {
    cleanup()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  } }
}

it("actual API approval rejects invalid targets before HTTP and freezes the exact unknown request across remount", async () => {
  const server = await peer()
  server.state.unknownFirst = true
  const used = vi.fn()
  try {
    render(() => <DialogBrowserControl sessionID="api-session" onUse={used} />)
    await select(dict["browser.control.mode"], dict["browser.control.apiPost"])
    expect(screen.queryByLabelText(dict["browser.control.paths"])).toBeNull()
    expect(screen.queryByLabelText(dict["browser.control.scriptSource"])).toBeNull()
    const targets = screen.getByLabelText(dict["browser.control.apiTargets"])
    for (const value of ["{broken", JSON.stringify([{ ...configuration.apiPostTargets[0], url: "https://assets.example.com/api" }]),
      JSON.stringify([{ ...configuration.apiPostTargets[0], url: "https://example.com/api#" }])]) {
      fireEvent.input(targets, { target: { value } })
      fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
      expect((await screen.findByRole("alert")).textContent).toContain(dict["browser.control.invalid"])
      await waitFor(() => expect(screen.getByRole("button", { name: dict["browser.control.connect"] }).hasAttribute("disabled")).toBe(false))
      expect(server.calls).toHaveLength(0)
    }
    fireEvent.input(targets, { target: { value: JSON.stringify(configuration.apiPostTargets) } })
    fireEvent.input(screen.getByLabelText(dict["browser.control.approvedOrigins"]), { target: { value: configuration.approvedOrigins.join("\n") } })
    await select(dict["browser.control.resolver"], dict["browser.control.resolverCloudflare"])
    await select(dict["browser.control.pageMode"], dict["browser.control.pageDynamic"])
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    await screen.findByRole("alert")
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/browser/controls",
      body: { profile: "managed-public-api-v1", sessionID: "api-session", ...configuration } })
    expect(server.calls[0].body.requestID).toEqual(expect.any(String))
    for (const field of ["postTargets", "postPaths", "scriptGrants", "programGrants", "filePolicy", "clipboardPolicy"])
      expect(server.calls[0].body).not.toHaveProperty(field)
    cleanup()
    render(() => <DialogBrowserControl sessionID="api-session" onUse={used} />)
    expect(server.calls).toHaveLength(1)
    expect(screen.getByLabelText(dict["browser.control.apiTargets"]).hasAttribute("disabled")).toBe(true)
    const mode = within(screen.getByRole("group", { name: dict["browser.control.mode"] })).getByRole("button")
    expect(mode.hasAttribute("data-disabled")).toBe(true)
    fireEvent.keyDown(mode, { key: "ArrowDown" })
    expect(screen.queryByRole("option", { name: dict["browser.control.localInteractive"] })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.retry"] }))
    await screen.findByText(dict["browser.control.active"])
    expect(server.calls).toHaveLength(2)
    expect(server.calls[1].body).toEqual(server.calls[0].body)
    expect(used).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.use"] }))
    expect(used).toHaveBeenCalledTimes(1)
    expect(used).toHaveBeenCalledWith("api-control")
  } finally { await server.close() }
})

it("a late cached owner, foreign returned scope and changed SDK client cannot authorize API control use", async () => {
  const server = await peer()
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  server.state.gates = [first.promise, second.promise]
  server.state.wrongScopeAt = 2
  const used = vi.fn()
  try {
    const old = render(() => <DialogBrowserControl sessionID="api-session" onUse={used} />)
    await select(dict["browser.control.mode"], dict["browser.control.apiPost"])
    fireEvent.input(screen.getByLabelText(dict["browser.control.apiTargets"]), { target: { value: JSON.stringify(configuration.apiPostTargets) } })
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    await waitFor(() => expect(server.calls).toHaveLength(1))
    old.container.hidden = true
    const next = render(() => <DialogBrowserControl sessionID="api-session" onUse={used} />)
    const current = within(next.container)
    fireEvent.click(current.getByRole("button", { name: dict["browser.control.retry"] }))
    await waitFor(() => expect(server.calls).toHaveLength(2))
    first.resolve()
    await waitFor(() => expect(server.state.completed).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(current.getByRole("button", { name: dict["browser.control.retry"] }).hasAttribute("disabled")).toBe(true)
    expect(current.getByRole("button", { name: dict["browser.control.use"] }).hasAttribute("disabled")).toBe(true)
    expect(current.queryByText(dict["browser.control.active"])).toBeNull()
    expect(used).not.toHaveBeenCalled()
    second.resolve()
    expect((await current.findByRole("alert")).textContent).toContain(dict["browser.control.scopeChanged"])
    expect(used).not.toHaveBeenCalled()
    expect(server.calls[1].body).toEqual(server.calls[0].body)
    fireEvent.click(current.getByRole("button", { name: dict["browser.control.retry"] }))
    await current.findByText(dict["browser.control.active"])
    server.sdk.client = createDeepAgentCodeClient({ baseUrl: server.baseUrl })
    fireEvent.click(current.getByRole("button", { name: dict["browser.control.use"] }))
    expect(used).not.toHaveBeenCalled()
  } finally { first.resolve(); second.resolve(); await server.close() }
})
