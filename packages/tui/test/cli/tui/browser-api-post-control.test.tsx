/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { Schema } from "effect"
import { ProjectProvider } from "../../../src/context/project"
import { DialogBrowserControl } from "../../../src/component/dialog-browser-control"
import { useDialog } from "../../../src/ui/dialog"
import { dict } from "../../../src/i18n/en"
import { mountIM, until } from "../../fixture/im-environment"

// Actual 80-column renderer, form confirmation and generated SDK use controlled HTTP.
// The peer's synthetic verified view proves no Main/native or canonical provider execution.
const configuration = { origin: "https://example.com", approvedOrigins: ["https://example.com", "https://assets.example.com"],
  resolverPolicy: "cloudflare_doh_v1", pageMode: "dynamic", apiPostTargets: [{ url: "https://example.com/api?version=1",
    contentTypes: ["application/json", "text/plain"], maxBodyBytes: 1024 }] }

test("80-column API form rejects invalid targets before HTTP and preserves the exact approval through unknown remount", async () => {
  const root = await mkdtemp("/tmp/dac-browser-api-post-tui-")
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await request.json())
    calls.push({ path: new URL(request.url).pathname, method: request.method, body })
    if (calls.length === 1) return Response.json({ code: "BROWSER_UNKNOWN" }, { status: 503 })
    return Response.json({ control: { ...body, controlID: "api-tui-control", state: "active", revision: 1,
      scope: { sessionID: "api-session", directory: root } }, availability: "available", nativeVerification: "verified", stopConfirmed: false })
  } })
  const uses: string[] = []
  const actions = { reopen: () => {} }
  const control = () => <ProjectProvider><DialogBrowserControl sessionID="api-session" onUse={(id) => uses.push(id)} /></ProjectProvider>
  function Capture() {
    const dialog = useDialog()
    actions.reopen = () => dialog.replace(control)
    return <box />
  }
  const ui = await mountIM(root, server.url.origin, control, 80, () => <Capture />)
  try {
    await ui.frame(dict["tui.browser.control.apiPost"])
    await ui.choose("apiPost")
    await ui.frame("apiPostTargets")
    for (const value of ["{broken", JSON.stringify({ ...configuration,
      apiPostTargets: [{ ...configuration.apiPostTargets[0], url: "https://assets.example.com/api" }] }),
      JSON.stringify({ ...configuration, apiPostTargets: [{ ...configuration.apiPostTargets[0], url: "https://example.com/api#" }] })]) {
      await ui.type(value, true)
      ui.app.mockInput.pressEnter()
      await ui.frame(dict["tui.browser.control.invalid"].split(". ")[0])
      expect(calls).toHaveLength(0)
    }
    await ui.type(JSON.stringify(configuration), true)
    ui.app.mockInput.pressEnter()
    await ui.frame(dict["tui.browser.control.unknown"].split(". ")[0])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/browser/controls",
      body: { profile: "managed-public-api-v1", sessionID: "api-session", ...configuration } })
    for (const field of ["postTargets", "postPaths", "scriptGrants", "programGrants", "filePolicy", "clipboardPolicy"])
      expect(calls[0].body).not.toHaveProperty(field)
    actions.reopen()
    const frame = await ui.frame(dict["tui.browser.control.retry"])
    expect(calls).toHaveLength(1)
    expect(frame).not.toContain(dict["tui.browser.control.apiPost"])
    expect(frame).not.toContain("apiPostTargets")
    ui.app.mockInput.pressEnter()
    await ui.frame(dict["tui.browser.control.active"])
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toEqual(calls[0].body)
    expect(uses).toEqual([])
  } finally { ui.app.renderer.destroy(); server.stop(true); await rm(root, { recursive: true, force: true }) }
}, 15000)

test("late owner, foreign returned scope and closed TUI dialog never hand off an API control", async () => {
  const root = await mkdtemp("/tmp/dac-browser-api-post-owner-tui-")
  const calls: Record<string, unknown>[] = []
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const third = Promise.withResolvers<void>()
  const state = { completed: 0 }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await request.json())
    calls.push(body)
    const ordinal = calls.length
    await [first.promise, second.promise, third.promise][ordinal - 1]
    state.completed++
    return Response.json({ control: { ...body, controlID: "api-owner-control", state: "active", revision: 1,
      scope: { sessionID: ordinal === 2 ? "foreign-session" : "api-session", directory: root } },
      availability: "available", nativeVerification: "verified", stopConfirmed: false })
  } })
  const uses: string[] = []
  const actions = { reopen: () => {}, close: () => {} }
  const control = () => <ProjectProvider><DialogBrowserControl sessionID="api-session" onUse={(id) => uses.push(id)} /></ProjectProvider>
  function Capture() {
    const dialog = useDialog()
    actions.reopen = () => dialog.replace(control)
    actions.close = () => dialog.clear()
    return <box />
  }
  const ui = await mountIM(root, server.url.origin, control, 80, () => <Capture />)
  try {
    await ui.frame(dict["tui.browser.control.apiPost"])
    await ui.choose("apiPost")
    await ui.frame("apiPostTargets")
    await ui.type(JSON.stringify(configuration), true)
    ui.app.mockInput.pressEnter()
    await until(() => calls.length === 1, "first controlled API request")
    actions.reopen()
    await ui.frame("apiPostTargets")
    await ui.type(JSON.stringify({ ...configuration, apiPostTargets: [] }), true)
    ui.app.mockInput.pressEnter()
    await until(() => calls.length === 2, "same request new owner")
    first.resolve()
    await until(() => state.completed === 1, "late old owner response")
    await ui.frame("processing...")
    expect(uses).toEqual([])
    second.resolve()
    await ui.frame(dict["tui.browser.control.scopeChanged"].split(". ")[0])
    expect(calls[1]).toEqual(calls[0])
    expect(uses).toEqual([])
    ui.app.mockInput.pressEnter()
    await until(() => calls.length === 3, "explicit retry after foreign returned scope")
    actions.close()
    third.resolve()
    await until(() => state.completed === 3, "completion after actual dialog cleanup")
    await Bun.sleep(20)
    expect(calls[2]).toEqual(calls[0])
    expect(uses).toEqual([])
  } finally { first.resolve(); second.resolve(); third.resolve(); ui.app.renderer.destroy(); server.stop(true);
    await rm(root, { recursive: true, force: true }) }
}, 15000)
