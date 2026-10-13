/** @jsxImportSource @opentui/solid */
import { mkdtemp, rm } from "node:fs/promises"
import { createSignal } from "solid-js"
import { Schema } from "effect"
import { ProjectProvider, useProject } from "../../src/context/project"
import { DialogBrowserControl } from "../../src/component/dialog-browser-control"
import { useDialog } from "../../src/ui/dialog"
import { dict } from "../../src/i18n/en"
import { mountIM, until } from "./im-environment"

export const publicProfiles = [
  { profile: "managed-public-readonly-v1", menuValue: "publicDoH", configuration: {
    origin: "https://example.com", approvedOrigins: ["https://example.com", "https://assets.example.com"],
    resolverPolicy: "cloudflare_doh_v1" } },
  { profile: "managed-public-interaction-v1", menuValue: "publicInteraction", configuration: {
    origin: "https://example.com", approvedOrigins: ["https://example.com", "https://assets.example.com"],
    resolverPolicy: "cloudflare_doh_v1", pageMode: "dynamic", postTargets: [{ origin: "https://example.com", path: "/submit" }] } },
  { profile: "managed-public-api-v1", menuValue: "apiPost", configuration: {
    origin: "https://example.com", approvedOrigins: ["https://example.com", "https://assets.example.com"],
    resolverPolicy: "cloudflare_doh_v1", pageMode: "dynamic", apiPostTargets: [{ url: "https://example.com/api?version=1",
      contentTypes: ["application/json"], maxBodyBytes: 1024 }] } },
] as const
export const publicProfileInventory = { peersOpened: 0, peersClosed: 0, renderersOpened: 0, renderersDestroyed: 0,
  rootsCreated: 0, rootsRemoved: 0, unexpectedRequests: 0 }

// Original Project/SDK/Dialog providers, 80-column OpenTUI and keyboard. A loopback
// peer supplies synthetic verified views; it cannot create Native/provider proof.
export async function mountPublicProfile() {
  const root = await mkdtemp("/tmp/dac-browser-public-profile-tui-")
  publicProfileInventory.rootsCreated++
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const state = { created: undefined as Record<string, unknown> | undefined, gate: undefined as Promise<void> | undefined,
    cancelGate: undefined as Promise<void> | undefined, cancels: 0, completed: 0, expiresAt: undefined as number | undefined,
    directory: root }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/path") return Response.json({ directory: state.directory })
    if (path === "/project/current") return Response.json({ id: "profile-project", worktree: root })
    if (!path.startsWith("/api/v1/browser/controls")) {
      publicProfileInventory.unexpectedRequests++
      return Response.json({}, { status: 404 })
    }
    const body = request.method === "GET" ? undefined : Schema.decodeUnknownSync(
      Schema.Record(Schema.String, Schema.Unknown))(await request.json())
    calls.push({ method: request.method, path, body })
    const cancel = path.endsWith("/cancel")
    if (cancel) {
      state.cancels++
      if (state.cancels === 1) { state.completed++; return Response.json({ code: "BROWSER_UNKNOWN" }, { status: 503 }) }
      await state.cancelGate
    }
    if (request.method === "POST" && !cancel) { state.created = body; await state.gate }
    state.completed++
    return Response.json({ control: { ...state.created, controlID: "public-tui-boundary-control",
      expiresAt: state.expiresAt ?? state.created?.expiresAt, revision: cancel ? 2 : 1, state: cancel ? "stopped" : "active",
      scope: { sessionID: "profile-session", directory: root } }, availability: cancel ? "stopped" : "available",
      nativeVerification: "verified", stopConfirmed: cancel })
  } })
  publicProfileInventory.peersOpened++
  const uses: string[] = []
  const [session, setSession] = createSignal("profile-session")
  const actions = { closed: () => false, workspace: () => {}, directory: async () => {} }
  function Scoped() {
    const project = useProject()
    actions.workspace = () => project.workspace.set("foreign-workspace")
    actions.directory = async () => { state.directory = `${root}/foreign`; await project.sync() }
    return <DialogBrowserControl sessionID={session()} onUse={(controlID) => uses.push(controlID)} />
  }
  function Capture() {
    const dialog = useDialog()
    actions.closed = () => dialog.stack.length === 0
    return <box />
  }
  const ui = await mountIM(root, server.url.origin, () => <ProjectProvider><Scoped /></ProjectProvider>, 80, () => <Capture />)
  publicProfileInventory.renderersOpened++
  async function highlight(index: number) {
      ui.app.mockInput.pressKey("HOME")
      await Bun.sleep(10)
      await ui.app.renderOnce()
      for (const _ of Array.from({ length: index })) {
        ui.app.mockInput.pressArrow("down")
        await Bun.sleep(10)
        await ui.app.renderOnce()
      }
  }
  return { ...ui, calls, state, uses, setSession, actions, highlight,
    async choose(index: number) { await highlight(index); ui.app.mockInput.pressEnter() },
    async create(profile: typeof publicProfiles[number]) {
      await ui.frame(dict["tui.browser.control.apiPost"])
      await ui.choose(profile.menuValue)
      await ui.frame(profile.profile === "managed-public-readonly-v1" ? "First line: initial HTTPS origin" : profile.profile === "managed-public-api-v1" ? "apiPostTargets" : "JSON: origin")
      await ui.type(profile.profile === "managed-public-readonly-v1" ? profile.configuration.approvedOrigins.join("\n")
        : JSON.stringify(profile.configuration), true)
      ui.app.mockInput.pressEnter()
      await ui.app.renderOnce()
      await until(() => calls.length > 0, "explicit original public create")
    },
    async close() {
      ui.app.renderer.destroy()
      publicProfileInventory.renderersDestroyed++
      server.stop(true)
      publicProfileInventory.peersClosed++
      await rm(root, { recursive: true, force: true })
      publicProfileInventory.rootsRemoved++
    },
  }
}
