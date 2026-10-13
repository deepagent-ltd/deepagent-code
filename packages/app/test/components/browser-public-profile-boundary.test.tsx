import { afterAll, afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createServer } from "node:http"
import { webcrypto } from "node:crypto"
import { Schema } from "effect"
import { DialogProvider, useDialog } from "@deepagent-code/ui/context/dialog"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { DialogBrowserControl } from "@/components/dialog-browser-control"
import { dict } from "@/i18n/en"

const wiring: { sdk?: { client: ReturnType<typeof createDeepAgentCodeClient>; directory: string; scope: string } } =
  vi.hoisted(() => ({}))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))

// Original Solid control, DialogProvider/Kobalte dialog, keyboard and generated SDK.
// Only placement/language context is supplied at the client seam. Controlled HTTP
// verified views establish no native descriptor, provider turn or public page visit.
const profiles = [
  { profile: "managed-public-readonly-v1", mode: "publicReadonly", configuration: {
    origin: "https://example.com", approvedOrigins: ["https://example.com", "https://assets.example.com"],
    resolverPolicy: "cloudflare_doh_v1" } },
  { profile: "managed-public-interaction-v1", mode: "publicInteraction", configuration: {
    origin: "https://example.com", approvedOrigins: ["https://example.com", "https://assets.example.com"],
    resolverPolicy: "cloudflare_doh_v1", pageMode: "dynamic", postTargets: [{ origin: "https://example.com", path: "/submit" }] } },
  { profile: "managed-public-api-v1", mode: "apiPost", configuration: {
    origin: "https://example.com", approvedOrigins: ["https://example.com", "https://assets.example.com"],
    resolverPolicy: "cloudflare_doh_v1", pageMode: "dynamic", apiPostTargets: [{ url: "https://example.com/api?version=1",
      contentTypes: ["application/json"], maxBodyBytes: 1024 }] } },
] as const
const inventory = { assertions: 0, peersOpened: 0, peersClosed: 0 }
afterEach(() => { inventory.assertions += expect.getState().assertionCalls; cleanup(); vi.unstubAllGlobals() })
afterAll(() => { console.log("BROWSER_PUBLIC_GUI_BOUNDARY_SAFE", JSON.stringify(inventory)) })

async function peer() {
  vi.stubGlobal("crypto", webcrypto)
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const state = { created: undefined as Record<string, unknown> | undefined, gate: undefined as Promise<void> | undefined,
    cancelGate: undefined as Promise<void> | undefined, cancels: 0, completed: 0, expiresAt: undefined as number | undefined }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(new Uint8Array(chunk))
    const body = request.method === "GET" ? undefined : Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(Buffer.concat(chunks).toString())
    calls.push({ method: request.method ?? "", path: request.url ?? "", body })
    const cancel = request.url?.endsWith("/cancel") === true
    if (cancel) {
      state.cancels++
      if (state.cancels === 1) { response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ code: "BROWSER_UNKNOWN" })); state.completed++; return }
      await state.cancelGate
    }
    if (request.method === "POST" && !cancel) { state.created = body; await state.gate }
    state.completed++
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ control: { ...state.created, controlID: "public-boundary-control",
      expiresAt: state.expiresAt ?? state.created?.expiresAt, revision: cancel ? 2 : 1, state: cancel ? "stopped" : "active",
      scope: { sessionID: "profile-session", directory: "/profile-project" } },
      availability: cancel ? "stopped" : "available", nativeVerification: "verified", stopConfirmed: cancel }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  inventory.peersOpened++
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Controlled peer was not bound")
  const [sdk, setSDK] = createStore({ client: createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` }),
    directory: "/profile-project", scope: "profile-workspace" })
  wiring.sdk = sdk
  return { calls, state, setSDK, async close() {
    cleanup(); server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    inventory.peersClosed++
  } }
}

function mount() {
  const [session, setSession] = createSignal("profile-session")
  const uses: string[] = []
  function Caller() {
    const dialog = useDialog()
    return <button onClick={() => void dialog.show(() => <DialogBrowserControl sessionID={session()}
      onUse={(controlID) => uses.push(controlID)} />)}>Open public browser</button>
  }
  render(() => <DialogProvider><Caller /></DialogProvider>)
  return { uses, setSession }
}

async function enter(name: string) {
  const button = screen.getByRole("button", { name })
  button.focus()
  await userEvent.setup().keyboard("{Enter}")
}

async function select(label: string, option: string) {
  const trigger = within(screen.getByRole("group", { name: label })).getByRole("button")
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  const target = await screen.findByRole("option", { name: option })
  target.focus()
  fireEvent.keyDown(target, { key: "Enter" })
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"))
  const content = target.closest('[data-slot="select-v2-content"]')
  if (content) fireEvent.animationEnd(content, { animationName: getComputedStyle(content).animationName })
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0))
}

async function create(profile: typeof profiles[number]) {
  await enter("Open public browser")
  await screen.findByRole("dialog", { name: dict["browser.control.title"] })
  await select(dict["browser.control.mode"], dict[`browser.control.${profile.mode}`])
  fireEvent.input(screen.getByLabelText(dict["browser.control.approvedOrigins"]),
    { target: { value: profile.configuration.approvedOrigins.join("\n") } })
  await select(dict["browser.control.resolver"], dict["browser.control.resolverCloudflare"])
  if (profile.profile !== "managed-public-readonly-v1")
    await select(dict["browser.control.pageMode"], dict["browser.control.pageDynamic"])
  if (profile.profile === "managed-public-interaction-v1")
    fireEvent.input(screen.getByLabelText(dict["browser.control.paths"]), { target: { value: "/submit" } })
  if (profile.profile === "managed-public-api-v1")
    fireEvent.input(screen.getByLabelText(dict["browser.control.apiTargets"]),
      { target: { value: JSON.stringify(profile.configuration.apiPostTargets) } })
  await enter(dict["browser.control.connect"])
}

it.each(profiles)("$profile explicitly creates and hands off only on keyboard Use", async (profile) => {
  const server = await peer()
  const ui = mount()
  try {
    expect(server.calls).toHaveLength(0)
    await create(profile)
    await screen.findByText(dict["browser.control.active"])
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/browser/controls",
      body: { profile: profile.profile, sessionID: "profile-session", ...profile.configuration } })
    expect(server.calls[0].body?.requestID).toEqual(expect.any(String))
    expect(Number(server.calls[0].body?.expiresAt)).toBeGreaterThan(Date.now())
    expect(server.calls[0].body).not.toHaveProperty("scriptGrants")
    expect(server.calls[0].body).not.toHaveProperty("programGrants")
    expect(server.calls[0].body).not.toHaveProperty("clipboardPolicy")
    expect(ui.uses).toEqual([])
    await enter(dict["browser.control.use"])
    expect(ui.uses).toEqual(["public-boundary-control"])
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(server.calls).toHaveLength(1)
  } finally { await server.close() }
})

it.each(profiles)("$profile refuses keyboard Use when the already rendered control expires", async (profile) => {
  const server = await peer()
  const ui = mount()
  try {
    await create(profile)
    await screen.findByText(dict["browser.control.active"])
    const expiresAt = Date.now() + 120
    server.state.expiresAt = expiresAt
    await enter(dict["browser.control.refresh"])
    await waitFor(() => expect(server.calls).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole("button", { name: dict["browser.control.use"] }).hasAttribute("disabled")).toBe(false))
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now()) + 30))
    await enter(dict["browser.control.use"])
    expect(Date.now()).toBeGreaterThan(expiresAt)
    expect(ui.uses).toEqual([])
    expect(screen.getByRole("dialog")).toBeDefined()
    expect(server.calls).toHaveLength(2)
  } finally { await server.close() }
})

for (const profile of profiles) it.each(["session", "directory", "workspace"] as const)(
  `${profile.profile} fences a late create response after reactive %s changes`, async (change) => {
    const server = await peer()
    const gate = Promise.withResolvers<void>()
    server.state.gate = gate.promise
    const ui = mount()
    try {
      await create(profile)
      await waitFor(() => expect(server.calls).toHaveLength(1))
      if (change === "session") ui.setSession("foreign-session")
      if (change === "directory") server.setSDK("directory", "/foreign-project")
      if (change === "workspace") server.setSDK("scope", "foreign-workspace")
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
      gate.resolve()
      await waitFor(() => expect(server.state.completed).toBe(1))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(ui.uses).toEqual([])
      expect(screen.queryByText(dict["browser.control.active"])).toBeNull()
      expect(server.calls).toHaveLength(1)
    } finally { gate.resolve(); await server.close() }
  },
)

it.each(profiles)("$profile disables Use through cancel unknown and retries the original tuple by keyboard", async (profile) => {
  const server = await peer()
  const gate = Promise.withResolvers<void>()
  server.state.cancelGate = gate.promise
  const ui = mount()
  try {
    await create(profile)
    await screen.findByText(dict["browser.control.active"])
    await enter(dict["browser.control.stop"])
    await screen.findByRole("alert")
    expect(screen.getByRole("button", { name: dict["browser.control.use"] }).hasAttribute("disabled")).toBe(true)
    await enter(dict["browser.control.use"])
    expect(ui.uses).toEqual([])
    expect(screen.queryByText(dict["browser.control.stopped"])).toBeNull()
    await enter(dict["browser.control.stop"])
    await waitFor(() => expect(server.state.cancels).toBe(2))
    expect(screen.getByRole("button", { name: dict["browser.control.use"] }).hasAttribute("disabled")).toBe(true)
    expect(server.calls.filter((call) => call.path.endsWith("/cancel"))[1].body)
      .toEqual(server.calls.filter((call) => call.path.endsWith("/cancel"))[0].body)
    expect(server.calls.find((call) => call.path.endsWith("/cancel"))?.body)
      .toMatchObject({ requestID: expect.any(String), expectedRevision: 1 })
    gate.resolve()
    await screen.findByText(dict["browser.control.stopped"])
    expect(screen.getByRole("button", { name: dict["browser.control.use"] }).hasAttribute("disabled")).toBe(true)
    expect(ui.uses).toEqual([])
    expect(server.calls.filter((call) => call.path === "/api/v1/browser/controls")).toHaveLength(1)
    await userEvent.setup().keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  } finally { gate.resolve(); await server.close() }
})
