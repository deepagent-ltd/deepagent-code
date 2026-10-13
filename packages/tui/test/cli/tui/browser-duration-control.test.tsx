/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { ProjectProvider } from "../../../src/context/project"
import { DialogBrowserControl } from "../../../src/component/dialog-browser-control"
import { dict } from "../../../src/i18n/en"
import { mountIM, until } from "../../fixture/im-environment"

test("TUI browser explicit fifteen-minute approval is frozen across unknown exact retry", async () => {
  const root = await mkdtemp("/tmp/dac-browser-duration-tui-")
  const calls: Record<string, unknown>[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return Response.json([])
    calls.push(await request.json() as Record<string, unknown>)
    return Response.json({ code: "BROWSER_UNKNOWN" }, { status: 503 })
  } })
  const ui = await mountIM(root, server.url.origin, () => <ProjectProvider>
    <DialogBrowserControl sessionID="duration-session" onUse={() => { throw new Error("Unknown cannot hand off") }} />
  </ProjectProvider>, 110)
  try {
    await ui.frame(dict["tui.browser.control.duration15"])
    Array.from({ length: 11 }, () => ui.app.mockInput.pressArrow("down"))
    ui.app.mockInput.pressEnter()
    expect(calls).toHaveLength(0)
    Array.from({ length: 11 }, () => ui.app.mockInput.pressArrow("up"))
    ui.app.mockInput.pressEnter()
    await ui.frame(`${dict["tui.browser.control.duration"]}: ${dict["tui.browser.control.duration15"]}`)
    const before = Date.now()
    ui.app.mockInput.pressEnter()
    await until(() => calls.length === 1, "original browser approval POST")
    await ui.frame("The outcome is unconfirmed.")
    expect(calls[0].expiresAt).toBeGreaterThanOrEqual(before + 900_000)
    expect(calls[0].expiresAt).toBeLessThanOrEqual(Date.now() + 900_000)
    expect(await ui.frame("The outcome is unconfirmed.")).not.toContain(dict["tui.browser.control.duration30"])
    ui.app.mockInput.pressEnter()
    await until(() => calls.length === 2, "original exact browser retry")
    expect(calls[1]).toEqual(calls[0])
  } finally { ui.app.renderer.destroy(); server.stop(true); await rm(root, { recursive: true, force: true }) }
}, 15_000)
