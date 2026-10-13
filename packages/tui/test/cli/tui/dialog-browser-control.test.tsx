/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { ProjectProvider } from "../../../src/context/project"
import { DialogBrowserControl, type BrowserValidationScript } from "../../../src/component/dialog-browser-control"
import { useDialog } from "../../../src/ui/dialog"
import { dict } from "../../../src/i18n/en"
import { mountIM, until } from "../../fixture/im-environment"
import { TextareaRenderable } from "@opentui/core"

test("browser prompt step identity gives code and JSON independent defaults, edits and cleanup", async () => {
  const root = await mkdtemp("/tmp/dac-browser-tui-step-")
  const peer = await browserPeer(root)
  const source = "return {value:'中文参数分离'}"
  const argsJSON = '{"value":"独立中文参数"}'
  const actions = { closed: () => false }
  function Capture() {
    const dialog = useDialog()
    actions.closed = () => dialog.stack.length === 0
    return <box />
  }
  const ui = await mountIM(root, peer.server.url.origin, () => <ProjectProvider>
    <DialogBrowserControl sessionID="browser-session" onUse={() => {}} />
  </ProjectProvider>, 100, () => <Capture />)
  try {
    await ui.frame("Approve and connect")
    Array.from({ length: 2 }, () => ui.app.mockInput.pressArrow("down"))
    ui.app.mockInput.pressEnter()
    await ui.frame("Page validation code")
    const code = ui.app.renderer.currentFocusedEditor
    if (!(code instanceof TextareaRenderable)) throw new Error("Original code textarea is not focused")
    expect(code.plainText).toBe("")
    await ui.type(source)
    ui.app.mockInput.pressEnter()
    await ui.frame("JSON arguments")
    const args = ui.app.renderer.currentFocusedEditor
    if (!(args instanceof TextareaRenderable)) throw new Error("Original JSON textarea is not focused")
    expect(args.plainText).toBe("null")
    expect(args).not.toBe(code)
    expect(code.isDestroyed).toBe(true)
    await ui.type(argsJSON, true)
    ui.app.mockInput.pressEnter()
    await ui.frame("Approve and connect")
    Array.from({ length: 2 }, () => ui.app.mockInput.pressArrow("down"))
    ui.app.mockInput.pressEnter()
    await ui.frame("Page validation code")
    const reopened = ui.app.renderer.currentFocusedEditor
    if (!(reopened instanceof TextareaRenderable)) throw new Error("Original reopened code textarea is not focused")
    expect(reopened.plainText).toBe(source)
    ui.app.mockInput.pressEnter()
    await ui.frame("JSON arguments")
    const independent = ui.app.renderer.currentFocusedEditor
    if (!(independent instanceof TextareaRenderable)) throw new Error("Original independent JSON textarea is not focused")
    expect(independent.plainText).toBe(argsJSON)
    expect(reopened.isDestroyed).toBe(true)
    ui.app.mockInput.pressEscape()
    await until(actions.closed, "original Escape closes the browser form")
    await ui.app.renderOnce()
    await until(() => independent.isDestroyed, "original Escape releases the JSON editor")
    expect(independent.isDestroyed).toBe(true)
    expect(peer.calls).toHaveLength(0)
  } finally {
    ui.app.renderer.destroy()
    peer.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
  expect(ui.app.renderer.isDestroyed).toBe(true)
}, 15_000)

test("TUI unverified native clipboard is unavailable and new controls omit the grant", async () => {
  const root = await mkdtemp("/tmp/dac-browser-clipboard-tui-")
  const calls: Record<string, unknown>[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = request.method === "GET" ? calls[0] : await request.json() as Record<string, unknown>
    if (request.method !== "GET") calls.push(body)
    return Response.json({ control: { ...body, controlID: "clipboard-tui-control", state: "active", revision: 1,
      scope: { sessionID: "browser-session", directory: root } },
      availability: "available", nativeVerification: "verified", stopConfirmed: false })
  } })
  const rendered = await mountIM(root, server.url.origin, () => <ProjectProvider>
    <DialogBrowserControl sessionID="browser-session" onUse={() => {}} />
  </ProjectProvider>)
  try {
    await rendered.frame("Clipboard is unavailable")
    expect(calls).toHaveLength(0)
    rendered.app.mockInput.pressEnter()
    await rendered.frame("First line")
    await rendered.type("http://127.0.0.1:3000", true)
    rendered.app.mockInput.pressEnter()
    await until(() => calls.length === 1, "explicit browser creation without a clipboard grant")
    await rendered.frame("Browser connected")
    expect(calls[0]?.clipboardPolicy).toBeUndefined()
    expect(calls[0]?.profile).toBe("managed-loopback-interaction-v1")
  } finally {
    rendered.app.renderer.destroy()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test("public static TUI creation sends only explicitly approved origins and the selected DoH policy", async () => {
  const root = await mkdtemp("/tmp/dac-public-browser-tui-")
  const calls: Record<string, unknown>[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = request.method === "GET" ? calls[0] : await request.json() as Record<string, unknown>
    if (request.method !== "GET") calls.push(body)
    return Response.json({ control: { ...body, controlID: "public-tui-control", state: "active", revision: 1,
      scope: { sessionID: "browser-session", directory: root } },
      availability: "available", nativeVerification: "verified", stopConfirmed: false })
  } })
  const rendered = await mountIM(root, server.url.origin, () => <ProjectProvider>
    <DialogBrowserControl sessionID="browser-session" onUse={() => {}} />
  </ProjectProvider>)
  try {
    await rendered.frame("Public static pages · Cloudflare DNS")
    expect(calls).toHaveLength(0)
    Array.from({ length: 4 }, () => rendered.app.mockInput.pressArrow("down"))
    rendered.app.mockInput.pressEnter()
    await rendered.frame("First line: initial HTTPS origin")
    expect(calls).toHaveLength(0)
    await rendered.type("https://example.com\nhttps://www.example.com\nhttps://example.com", true)
    rendered.app.mockInput.pressEnter()
    await until(() => calls.length === 1, "explicit public permission")
    await rendered.frame("Browser connected")
    expect(calls[0]).toMatchObject({ profile: "managed-public-readonly-v1", origin: "https://example.com",
      approvedOrigins: ["https://example.com", "https://www.example.com"], resolverPolicy: "cloudflare_doh_v1" })
    expect(calls[0]?.postPaths).toBeUndefined()
    expect(calls[0]?.scriptGrants).toBeUndefined()
  } finally {
    rendered.app.renderer.destroy()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test("public interaction TUI rejects foreign submission before HTTP and preserves exact approval after unknown", async () => {
  const root = await mkdtemp("/tmp/dac-public-interaction-tui-")
  const calls: Record<string, unknown>[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = request.method === "GET" ? calls[0] : await request.json() as Record<string, unknown>
    if (request.method !== "GET") calls.push(body)
    if (calls.length === 1) return Response.json({ code: "BROWSER_UNKNOWN" }, { status: 503 })
    return Response.json({ control: { ...body, controlID: "public-interaction-tui-control", state: "active", revision: 1,
      scope: { sessionID: "browser-session", directory: root } },
      availability: "available", nativeVerification: "verified", stopConfirmed: false })
  } })
  const actions = { reopen: () => {} }
  const control = () => <ProjectProvider><DialogBrowserControl sessionID="browser-session" onUse={() => {}} /></ProjectProvider>
  function Capture() {
    const dialog = useDialog()
    actions.reopen = () => dialog.replace(control)
    return <box />
  }
  const ui = await mountIM(root, server.url.origin, control, 80, () => <Capture />)
  const configuration = { origin: "https://example.com", approvedOrigins: ["https://example.com", "https://assets.example.com"],
    resolverPolicy: "cloudflare_doh_v1", pageMode: "dynamic", postTargets: [{ origin: "https://example.com", path: "/submit" }] }
  try {
    await ui.frame("Public web · approved interaction")
    await ui.choose("publicInteraction")
    await ui.frame("JSON: origin")
    expect(calls).toHaveLength(0)
    await ui.type(JSON.stringify({ ...configuration, postTargets: [{ origin: "https://assets.example.com", path: "/submit" }] }), true)
    ui.app.mockInput.pressEnter()
    await ui.frame("The origin or allowed paths are invalid")
    expect(calls).toHaveLength(0)
    await ui.type(JSON.stringify(configuration), true)
    ui.app.mockInput.pressEnter()
    await ui.frame("The outcome is unconfirmed")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ profile: "managed-public-interaction-v1", ...configuration })
    expect(calls[0]?.scriptGrants).toBeUndefined()
    expect(calls[0]?.programGrants).toBeUndefined()
    expect(calls[0]?.clipboardPolicy).toBeUndefined()
    actions.reopen()
    await ui.frame(dict["tui.browser.control.retry"])
    expect(calls).toHaveLength(1)
    ui.app.mockInput.pressEnter()
    await ui.frame("Browser connected")
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
  } finally {
    ui.app.renderer.destroy()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test("actual TUI and generated SDK submit an explicit interaction policy, then observe and cancel the same control", async () => {
  const root = await mkdtemp("/tmp/dac-browser-tui-")
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> | undefined }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = request.method === "GET" ? undefined : ((await request.json()) as Record<string, unknown>)
      const pathname = new URL(request.url).pathname
      calls.push({ path: pathname, method: request.method, body })
      const stopped = pathname.endsWith("/cancel")
      return Response.json({
        control: {
          controlID: "tui-control",
          scope: { sessionID: "browser-session", directory: root },
          origin: "http://127.0.0.1:3000",
          profile: "managed-loopback-interaction-v1",
          postPaths: ["/submit"],
          state: stopped ? "stopped" : "active",
          expiresAt: Date.now() + 60_000,
          revision: stopped ? 2 : 1,
        },
        availability: stopped ? "stopped" : "available",
        nativeVerification: "verified",
        stopConfirmed: stopped,
      })
    },
  })
  const rendered = await mountIM(root, server.url.origin, () => (
    <ProjectProvider>
      <DialogBrowserControl sessionID="browser-session" onUse={() => {}} />
    </ProjectProvider>
  ))
  try {
    await rendered.frame("Approve and connect")
    expect(calls).toHaveLength(0)
    rendered.app.mockInput.pressEnter()
    await rendered.type("http://127.0.0.1:3000\n/submit", true)
    rendered.app.mockInput.pressEnter()
    await until(() => calls.some((call) => call.method === "POST"), "explicit create")
    await rendered.frame("Browser connected")
    expect(calls[0]?.body?.profile).toBe("managed-loopback-interaction-v1")
    expect(calls[0]?.body?.postPaths).toEqual(["/submit"])
    expect(calls[0]?.body?.scriptGrants).toBeUndefined()
    rendered.app.mockInput.pressArrow("down")
    rendered.app.mockInput.pressArrow("down")
    rendered.app.mockInput.pressEnter()
    await rendered.frame("Browser stop confirmed")
    expect(calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(1)
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2)
  } finally {
    rendered.app.renderer.destroy()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

async function browserPeer(root: string) {
  const calls: { method: string; body?: Record<string, unknown> }[] = []
  const state = { gates: [] as Promise<void>[], completed: 0 }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = request.method === "GET" ? undefined : await request.json() as Record<string, unknown>
    calls.push({ method: request.method, body })
    await state.gates[calls.length - 1]
    state.completed++
    return Response.json({
      control: { controlID: "tui-script-control", scope: { sessionID: "browser-session", directory: root },
        origin: "http://127.0.0.1:3000", profile: "managed-loopback-interaction-v1", postPaths: [],
        scriptGrants: body?.scriptGrants ?? calls.find((call) => call.body)?.body?.scriptGrants,
        programGrants: body?.programGrants ?? calls.find((call) => call.body)?.body?.programGrants,
        state: "active", expiresAt: Date.now() + 60_000, revision: 1 },
      availability: "available", nativeVerification: "verified", stopConfirmed: false,
    })
  } })
  return { calls, state, server }
}

test("actual TUI explicitly approves bounded operations then hands off the exact program without executing it", async () => {
  const root = await mkdtemp("/tmp/dac-browser-tui-program-")
  const peer = await browserPeer(root)
  const source = 'return {version:1,steps:[{type:"fill",target:"field",text:args.value}]}'
  const argsJSON = '{"value":"approved"}'
  const uses: { controlID: string; script?: BrowserValidationScript }[] = []
  const ui = await mountIM(root, peer.server.url.origin, () => <ProjectProvider>
    <DialogBrowserControl sessionID="browser-session" onUse={(controlID, script) => uses.push({ controlID, script })} />
  </ProjectProvider>, 80)
  try {
    await ui.frame("Configure bounded page changes")
    await ui.choose("programPolicy")
    await ui.frame("JSON policy")
    await ui.type('{"operations":["fill","click"],"maxSteps":2}', true)
    ui.app.mockInput.pressEnter()
    await ui.frame("Approve and connect")
    Array.from({ length: 2 }, () => ui.app.mockInput.pressArrow("down"))
    ui.app.mockInput.pressEnter()
    await ui.frame("Page validation code")
    await ui.type(source, true)
    ui.app.mockInput.pressEnter()
    await ui.frame("JSON arguments")
    await ui.type(argsJSON, true)
    ui.app.mockInput.pressEnter()
    await ui.frame("Approve and connect")
    expect(peer.calls).toHaveLength(0)
    ui.app.mockInput.pressEnter()
    await ui.type("http://127.0.0.1:3000\n", true)
    ui.app.mockInput.pressEnter()
    await ui.frame("Bounded page program approved")
    const hashes = { scriptHash: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
      argsHash: new Bun.CryptoHasher("sha256").update(argsJSON).digest("hex") }
    expect(peer.calls[0].body?.programGrants).toEqual([{ ...hashes, operations: ["fill", "click"], maxSteps: 2 }])
    expect(peer.calls[0].body?.scriptGrants).toBeUndefined()
    expect(peer.calls[0].body?.clipboardPolicy).toBeUndefined()
    expect(uses).toHaveLength(0)
    Array.from({ length: 2 }, () => ui.app.mockInput.pressArrow("down"))
    ui.app.mockInput.pressEnter()
    await until(() => uses.length === 1, "explicit bounded program handoff")
    expect(uses[0]).toEqual({ controlID: "tui-script-control", script: { source, argsJSON, ...hashes,
      mode: "program", operations: ["fill", "click"], maxSteps: 2 } })
    expect(peer.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  } finally {
    ui.app.renderer.destroy()
    peer.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test("actual TUI approves only raw-byte hashes and explicitly adds read-only code after ordinary reference use", async () => {
  const root = await mkdtemp("/tmp/dac-browser-tui-script-")
  const peer = await browserPeer(root)
  const source = "document.title \n"
  const argsJSON = ' { "label": "中" } \n'
  const uses: { controlID: string; script?: BrowserValidationScript }[] = []
  const actions = { reopen: () => {} }
  const control = () => <ProjectProvider><DialogBrowserControl sessionID="browser-session"
    onUse={(controlID, script) => uses.push({ controlID, ...(script ? { script } : {}) })} /></ProjectProvider>
  function Capture() {
    const dialog = useDialog()
    actions.reopen = () => dialog.replace(control)
    return <box />
  }
  const ui = await mountIM(root, peer.server.url.origin, control, 80, () => <Capture />)
  try {
    await ui.frame("Configure read-only page validation")
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressEnter()
    await ui.frame("Page validation code")
    await ui.type(source, true)
    ui.app.mockInput.pressEnter()
    await ui.frame("JSON arguments")
    await ui.type(argsJSON, true)
    ui.app.mockInput.pressEnter()
    await ui.frame("Approve and connect")
    expect(peer.calls).toHaveLength(0)
    ui.app.mockInput.pressEnter()
    await ui.type("http://127.0.0.1:3000\n", true)
    ui.app.mockInput.pressEnter()
    await ui.frame("Read-only page validation approved")
    expect(peer.calls[0].body?.scriptGrants).toEqual([{
      scriptHash: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
      argsHash: new Bun.CryptoHasher("sha256").update(argsJSON).digest("hex"), readOnly: true,
    }])
    expect(peer.calls[0].body).not.toHaveProperty("source")
    expect(peer.calls[0].body).not.toHaveProperty("argsJSON")
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressEnter()
    await until(() => uses.length === 1, "ordinary reference use")
    expect(uses[0]).toEqual({ controlID: "tui-script-control" })
    actions.reopen()
    await ui.frame("Read-only page validation approved")
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressEnter()
    await until(() => uses.length === 2, "explicit code draft")
    expect(uses[1]).toEqual({ controlID: "tui-script-control", script: { source, argsJSON,
      scriptHash: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
      argsHash: new Bun.CryptoHasher("sha256").update(argsJSON).digest("hex"),
    } })
    expect(peer.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  } finally { ui.app.renderer.destroy(); peer.server.stop(true); await rm(root, { recursive: true, force: true }) }
}, 15_000)

test("oversized UTF-8 and invalid JSON in actual TUI configuration submit zero approval requests", async () => {
  const root = await mkdtemp("/tmp/dac-browser-tui-invalid-")
  const peer = await browserPeer(root)
  const ui = await mountIM(root, peer.server.url.origin, () => <ProjectProvider>
    <DialogBrowserControl sessionID="browser-session" onUse={() => {}} /></ProjectProvider>, 80)
  try {
    await ui.frame("Configure read-only page validation")
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressEnter()
    await ui.frame("Page validation code")
    await ui.type("中".repeat(2731), true)
    ui.app.mockInput.pressEnter()
    await ui.frame("Enter valid JSON")
    expect(peer.calls).toHaveLength(0)
    await ui.type("document.title", true)
    ui.app.mockInput.pressEnter()
    await ui.frame("JSON arguments")
    await ui.type("{", true)
    ui.app.mockInput.pressEnter()
    await ui.frame("Enter valid JSON")
    expect(peer.calls).toHaveLength(0)
    await ui.type(`"${"中".repeat(2731)}"`, true)
    ui.app.mockInput.pressEnter()
    await ui.frame("Enter valid JSON")
    expect(peer.calls).toHaveLength(0)
  } finally { ui.app.renderer.destroy(); peer.server.stop(true); await rm(root, { recursive: true, force: true }) }
}, 15_000)

test("an actual old TUI HTTP completion cannot unlock the new cached-owner pending retry", async () => {
  const root = await mkdtemp("/tmp/dac-browser-tui-owner-")
  const peer = await browserPeer(root)
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  peer.state.gates = [first.promise, second.promise]
  const actions = { reopen: () => {} }
  const control = () => <ProjectProvider><DialogBrowserControl sessionID="browser-session" onUse={() => {}} /></ProjectProvider>
  function Capture() {
    const dialog = useDialog()
    actions.reopen = () => dialog.replace(control)
    return <box />
  }
  const ui = await mountIM(root, peer.server.url.origin, control, 80, () => <Capture />)
  try {
    await ui.frame("Approve and connect")
    ui.app.mockInput.pressEnter()
    await ui.type("http://127.0.0.1:3000\n", true)
    ui.app.mockInput.pressEnter()
    await until(() => peer.calls.length === 1, "first actual pending approval")
    actions.reopen()
    await ui.frame("Approve and connect")
    await ui.type("http://127.0.0.1:3000\n", true)
    ui.app.mockInput.pressEnter()
    await until(() => peer.calls.length === 2, "new owner exact retry")
    first.resolve()
    await until(() => peer.state.completed === 1, "old completion")
    await Bun.sleep(20)
    await ui.frame("processing...")
    ui.app.mockInput.pressEnter()
    await Bun.sleep(20)
    expect(peer.calls).toHaveLength(2)
    expect(peer.calls[1].body).toEqual(peer.calls[0].body)
    second.resolve()
    await ui.frame("Browser connected")
  } finally { first.resolve(); second.resolve(); ui.app.renderer.destroy(); peer.server.stop(true); await rm(root, { recursive: true, force: true }) }
}, 15_000)
