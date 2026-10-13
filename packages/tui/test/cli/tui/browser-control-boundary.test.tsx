/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createSignal, onMount } from "solid-js"
import { TextareaRenderable } from "@opentui/core"
import { ProjectProvider, useProject } from "../../../src/context/project"
import { DialogBrowserControl } from "../../../src/component/dialog-browser-control"
import { useDialog } from "../../../src/ui/dialog"
import { dict } from "../../../src/i18n/en"
import { mountIM, until } from "../../fixture/im-environment"

// Real OpenTUI, keyboard, SDK and owned HTTP. Synthetic views establish only
// client rendering/ownership boundaries, never Native or provider execution.
function view(root: string, stopped = false) {
  return { control: { controlID: "boundary-control", scope: { sessionID: "boundary-session", directory: root },
    origin: "http://127.0.0.1:3000", profile: "managed-loopback-interaction-v1", postPaths: [],
    state: stopped ? "stopped" : "active", expiresAt: Date.now() + 60_000, revision: stopped ? 2 : 1 },
    availability: stopped ? "stopped" : "available", nativeVerification: "verified", stopConfirmed: stopped }
}

test.each(["session", "workspace"] as const)("local browser pending completion is fenced by reactive %s identity", async (change) => {
  const root = await mkdtemp("/tmp/dac-browser-tui-boundary-")
  const response = Promise.withResolvers<void>()
  const state = { calls: 0, completed: false, uses: 0 }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/v1/browser/controls")
    expect(request.method).toBe("POST")
    state.calls++
    await response.promise
    state.completed = true
    return Response.json(view(root))
  } })
  const [session, setSession] = createSignal("boundary-session")
  const actions = { workspace: () => {}, closed: () => false }
  function Scoped() {
    const project = useProject()
    actions.workspace = () => project.workspace.set("explicit-other-workspace")
    return <DialogBrowserControl sessionID={session()} onUse={() => state.uses++} />
  }
  function Capture() {
    const dialog = useDialog()
    actions.closed = () => dialog.stack.length === 0
    return <box />
  }
  const ui = await mountIM(root, server.url.origin, () => <ProjectProvider><Scoped /></ProjectProvider>, 80, () => <Capture />)
  try {
    await ui.frame(dict["tui.browser.control.connect"])
    ui.app.mockInput.pressEnter()
    await ui.frame("First line")
    ui.app.mockInput.pressEnter()
    await until(() => state.calls === 1, "original local approval is pending")
    if (change === "session") setSession("other-session")
    if (change === "workspace") actions.workspace()
    await until(actions.closed, "reactive scope closes the old browser dialog")
    await ui.app.renderOnce()
    response.resolve()
    await until(() => state.completed, "owned late HTTP reply")
    await Bun.sleep(20)
    await ui.app.renderOnce()
    ui.app.mockInput.pressEnter()
    expect(actions.closed()).toBe(true)
    expect(ui.app.captureCharFrame()).not.toContain(dict["tui.browser.control.active"])
    expect(state.uses).toBe(0)
    expect(state.calls).toBe(1)
  } finally {
    response.resolve(); ui.app.renderer.destroy(); server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test("unconfirmed local browser cancel keeps Use disabled and retries only the original cancellation", async () => {
  const root = await mkdtemp("/tmp/dac-browser-tui-cancel-")
  const confirmed = Promise.withResolvers<void>()
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = []
  const state = { cancels: 0, uses: 0 }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname
    calls.push({ path: pathname, method: request.method,
      body: request.method === "GET" ? undefined : await request.json() as Record<string, unknown> })
    if (request.method === "GET") return Response.json(view(root, state.cancels >= 3))
    if (pathname.endsWith("/cancel")) {
      state.cancels++
      if (state.cancels === 1) return Response.json({ code: "BROWSER_UNKNOWN" }, { status: 503 })
      if (state.cancels === 2) { await confirmed.promise; return Response.json(view(root)) }
      return Response.json(view(root, true))
    }
    return Response.json(view(root))
  } })
  const ui = await mountIM(root, server.url.origin, () => <ProjectProvider>
    <DialogBrowserControl sessionID="boundary-session" onUse={() => state.uses++} />
  </ProjectProvider>, 80)
  async function choose(index: number) {
    ui.app.mockInput.pressKey("HOME")
    await Bun.sleep(10)
    await ui.app.renderOnce()
    for (const _ of Array.from({ length: index })) {
      ui.app.mockInput.pressArrow("down")
      await Bun.sleep(10)
      await ui.app.renderOnce()
    }
    ui.app.mockInput.pressEnter()
  }
  try {
    await ui.frame(dict["tui.browser.control.connect"])
    ui.app.mockInput.pressEnter()
    await ui.frame("First line")
    ui.app.mockInput.pressEnter()
    await ui.frame(dict["tui.browser.control.active"])
    await choose(2)
    const unknown = await ui.frame("503 Service")
    expect(unknown).not.toContain(dict["tui.browser.control.use"])
    expect(unknown).not.toContain(dict["tui.browser.control.stopped"])
    expect(state.uses).toBe(0)
    await choose(1)
    await until(() => state.cancels === 2, "explicit exact cancel retry")
    const busy = await ui.frame(dict["tui.browser.control.unavailable"].split("; ")[0])
    expect(busy).not.toContain(dict["tui.browser.control.use"])
    expect(busy).not.toContain(dict["tui.browser.control.stopped"])
    ui.app.mockInput.pressEnter()
    await Bun.sleep(20)
    expect(state.cancels).toBe(2)
    expect(calls.filter((call) => call.path.endsWith("/cancel"))[1].body)
      .toEqual(calls.filter((call) => call.path.endsWith("/cancel"))[0].body)
    expect(calls.find((call) => call.path.endsWith("/cancel"))?.body?.expectedRevision).toBe(1)
    confirmed.resolve()
    const incomplete = await ui.frame(dict["tui.browser.control.unavailable"].split("; ")[0])
    expect(incomplete).not.toContain(dict["tui.browser.control.stopped"])
    expect(incomplete).not.toContain(dict["tui.browser.control.use"])
    await choose(1)
    await ui.frame(dict["tui.browser.control.stopped"])
    expect(calls.filter((call) => call.path.endsWith("/cancel"))[2].body)
      .toEqual(calls.filter((call) => call.path.endsWith("/cancel"))[0].body)
    expect(state.cancels).toBe(3)
    expect(calls.filter((call) => call.method === "POST" && !call.path.endsWith("/cancel"))).toHaveLength(1)
    expect(state.uses).toBe(0)
  } finally {
    confirmed.resolve(); ui.app.renderer.destroy(); server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test("browser Escape destroys its editor and returns real keyboard focus to the original textarea", async () => {
  const root = await mkdtemp("/tmp/dac-browser-tui-focus-")
  const state = { requests: 0, uses: 0, editor: undefined as TextareaRenderable | undefined }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    state.requests++
    return Response.json({}, { status: 503 })
  } })
  const actions = { closed: () => false }
  function Capture() {
    const dialog = useDialog()
    actions.closed = () => dialog.stack.length === 0
    onMount(() => state.editor?.focus())
    return <textarea ref={(editor: TextareaRenderable) => { state.editor = editor }} initialValue="原中文草稿" height={3} />
  }
  const ui = await mountIM(root, server.url.origin, () => <ProjectProvider>
    <DialogBrowserControl sessionID="boundary-session" onUse={() => state.uses++} />
  </ProjectProvider>, 80, () => <Capture />)
  try {
    await ui.frame(dict["tui.browser.control.connect"])
    ui.app.mockInput.pressEnter()
    await ui.frame("First line")
    const old = ui.app.renderer.currentFocusedEditor
    if (!(old instanceof TextareaRenderable)) throw new Error("Original browser form is not focused")
    expect(old).not.toBe(state.editor)
    ui.app.mockInput.pressEscape()
    await until(actions.closed, "original browser Escape")
    await ui.app.renderOnce()
    await until(() => old.isDestroyed && state.editor?.focused === true, "old editor released and original focus restored")
    const original = state.editor
    if (!original) throw new Error("Original textarea was removed")
    expect(ui.app.renderer.currentFocusedEditor).toBe(original)
    await ui.app.mockInput.typeText("后续中文")
    expect(original.plainText).toBe("后续中文原中文草稿")
    expect(state.requests).toBe(0)
    expect(state.uses).toBe(0)
  } finally {
    ui.app.renderer.destroy(); server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
  expect(state.editor?.isDestroyed).toBe(true)
}, 15_000)
