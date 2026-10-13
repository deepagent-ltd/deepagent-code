/** @jsxImportSource @opentui/solid */
import { afterAll, expect, test } from "bun:test"
import { dict } from "../../../src/i18n/en"
import { until } from "../../fixture/im-environment"
import { mountPublicProfile, publicProfileInventory, publicProfiles } from "../../fixture/browser-public-profile"

afterAll(() => { console.log("BROWSER_PUBLIC_TUI_BOUNDARY_SAFE", JSON.stringify(publicProfileInventory)) })

test.each([...publicProfiles])("$profile explicitly creates and hands off only on keyboard Use", async (profile) => {
  const ui = await mountPublicProfile()
  try {
    expect(ui.calls).toHaveLength(0)
    await ui.create(profile)
    await ui.frame(dict["tui.browser.control.active"])
    expect(ui.calls.filter((call) => call.method === "POST")).toHaveLength(1)
    expect(ui.calls.filter((call) => call.method === "GET").every((call) =>
      call.path === "/api/v1/browser/controls/public-tui-boundary-control")).toBe(true)
    expect(ui.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/browser/controls",
      body: { profile: profile.profile, sessionID: "profile-session", ...profile.configuration } })
    expect(ui.calls[0].body?.requestID).toEqual(expect.any(String))
    expect(Number(ui.calls[0].body?.expiresAt)).toBeGreaterThan(Date.now())
    expect(ui.calls[0].body).not.toHaveProperty("scriptGrants")
    expect(ui.calls[0].body).not.toHaveProperty("programGrants")
    expect(ui.calls[0].body).not.toHaveProperty("clipboardPolicy")
    expect(ui.uses).toEqual([])
    await ui.choose(1)
    await until(ui.actions.closed, "original keyboard Use clears the actual dialog")
    expect(ui.uses).toEqual(["public-tui-boundary-control"])
    expect(ui.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  } finally { await ui.close() }
}, 15_000)

test.each([...publicProfiles])("$profile refuses keyboard Use when the already rendered control expires", async (profile) => {
  const ui = await mountPublicProfile()
  try {
    await ui.create(profile)
    await ui.frame(dict["tui.browser.control.active"])
    const before = ui.calls.length
    const expiresAt = Date.now() + 250
    ui.state.expiresAt = expiresAt
    await ui.choose(0)
    await until(() => ui.calls.length === before + 1 && ui.state.completed === before + 1, "original refresh gets the short-lived view")
    await ui.frame(dict["tui.browser.control.use"])
    await ui.highlight(1)
    await Bun.sleep(Math.max(0, expiresAt - Date.now()) + 30)
    ui.app.mockInput.pressEnter()
    await ui.app.renderOnce()
    expect(Date.now()).toBeGreaterThan(expiresAt)
    expect(ui.uses).toEqual([])
    expect(ui.actions.closed()).toBe(false)
    expect(ui.calls).toHaveLength(before + 1)
  } finally { await ui.close() }
}, 15_000)

for (const profile of publicProfiles) test.each(["session", "directory", "workspace"])(
  `${profile.profile} fences a late create response after reactive %s changes`, async (change) => {
    const ui = await mountPublicProfile()
    const gate = Promise.withResolvers<void>()
    ui.state.gate = gate.promise
    try {
      await ui.create(profile)
      expect(ui.calls).toHaveLength(1)
      if (change === "session") ui.setSession("foreign-session")
      if (change === "directory") await ui.actions.directory()
      if (change === "workspace") ui.actions.workspace()
      await until(ui.actions.closed, "reactive original placement closes the old public dialog")
      gate.resolve()
      await until(() => ui.state.completed === 1, "owned late public response")
      await Bun.sleep(20)
      await ui.app.renderOnce()
      expect(ui.actions.closed()).toBe(true)
      expect(ui.app.captureCharFrame()).not.toContain(dict["tui.browser.control.active"])
      expect(ui.uses).toEqual([])
      expect(ui.calls).toHaveLength(1)
    } finally { gate.resolve(); await ui.close() }
  }, 15_000,
)

test.each([...publicProfiles])("$profile removes Use through cancel unknown and retries the original tuple by keyboard", async (profile) => {
  const ui = await mountPublicProfile()
  const gate = Promise.withResolvers<void>()
  ui.state.cancelGate = gate.promise
  try {
    await ui.create(profile)
    await ui.frame(dict["tui.browser.control.active"])
    await ui.choose(2)
    const unknown = await ui.frame("→ 503")
    expect(unknown).not.toContain(dict["tui.browser.control.use"])
    expect(unknown).not.toContain(dict["tui.browser.control.stopped"])
    expect(ui.uses).toEqual([])
    await ui.choose(1)
    await until(() => ui.state.cancels === 2, "original public cancellation exact retry")
    const pending = await ui.frame(dict["tui.browser.control.unavailable"].split("; ")[0])
    expect(pending).not.toContain(dict["tui.browser.control.use"])
    expect(pending).not.toContain(dict["tui.browser.control.stopped"])
    ui.app.mockInput.pressEnter()
    await Bun.sleep(20)
    expect(ui.state.cancels).toBe(2)
    expect(ui.calls.filter((call) => call.path.endsWith("/cancel"))[1].body)
      .toEqual(ui.calls.filter((call) => call.path.endsWith("/cancel"))[0].body)
    expect(ui.calls.find((call) => call.path.endsWith("/cancel"))?.body)
      .toMatchObject({ requestID: expect.any(String), expectedRevision: 1 })
    gate.resolve()
    const stopped = await ui.frame(dict["tui.browser.control.stopped"])
    expect(stopped).not.toContain(dict["tui.browser.control.use"])
    expect(ui.uses).toEqual([])
    expect(ui.calls.filter((call) => call.path === "/api/v1/browser/controls")).toHaveLength(1)
    ui.app.mockInput.pressEscape()
    await until(ui.actions.closed, "original Escape after confirmed cancellation")
  } finally { gate.resolve(); await ui.close() }
}, 15_000)
