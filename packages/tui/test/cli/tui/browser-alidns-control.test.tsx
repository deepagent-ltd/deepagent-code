/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { ProjectProvider } from "../../../src/context/project"
import { DialogBrowserControl } from "../../../src/component/dialog-browser-control"
import { dict } from "../../../src/i18n/en"
import { mountIM, until } from "../../fixture/im-environment"
import { createFetch } from "../../fixture/tui-sdk"

test("original TUI explicitly selects AliDNS and cold refresh displays its fixed policy without fallback or handoff", async () => {
  const root = await mkdtemp("/tmp/dac-alidns-tui-")
  const calls: { method: string; body?: Record<string, unknown> }[] = []
  const state = { body: undefined as Record<string, unknown> | undefined }
  const defaults = createFetch()
  // Inject only the HTTP transport. Original SDKProvider, generated SDK and render/form code remain intact.
  const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (!new URL(request.url).pathname.startsWith("/api/v1/browser/")) return defaults.fetch(request)
    const body = request.method === "POST" ? await request.json() as Record<string, unknown> : undefined
    calls.push({ method: request.method, body })
    if (body) state.body = body
    return Response.json({ control: { ...state.body, controlID: "alidns-tui-control", state: "active", revision: 1,
      scope: { sessionID: "alidns-session", directory: root } },
      availability: "unavailable", nativeVerification: "unverified", stopConfirmed: false })
  }, { preconnect: () => { throw new Error("In-memory transport cannot preconnect") } }))
  const uses: string[] = []
  const ui = await mountIM(root, "https://fixture.invalid", () => <ProjectProvider>
    <DialogBrowserControl sessionID="alidns-session" onUse={(id) => uses.push(id)} />
  </ProjectProvider>, 110)
  try {
    await ui.frame(dict["tui.browser.control.publicConnectAliDNS"])
    expect(calls).toHaveLength(0)
    Array.from({ length: 5 }, () => ui.app.mockInput.pressArrow("down"))
    ui.app.mockInput.pressEnter()
    await ui.frame("First line: initial HTTPS origin")
    expect(calls).toHaveLength(0)
    await ui.type("https://example.com\nhttps://assets.example.com", true)
    ui.app.mockInput.pressEnter()
    await until(() => calls.some((call) => call.method === "POST"), "original generated SDK AliDNS request")
    await ui.frame(dict["tui.browser.control.unavailable"])
    expect(calls[0]).toMatchObject({ method: "POST", body: { profile: "managed-public-readonly-v1",
      resolverPolicy: "alidns_doh_v1", approvedOrigins: ["https://example.com", "https://assets.example.com"] } })
    expect(calls[0].body).not.toHaveProperty("resolverEndpoint")
    expect(calls[0].body).not.toHaveProperty("fallbackResolver")
    expect(await ui.frame(dict["tui.browser.control.resolverAliDNS"])).not.toContain(dict["tui.browser.control.resolverCloudflare"])
    expect(uses).toEqual([])
    const readCount = calls.filter((call) => call.method === "GET").length
    ui.app.mockInput.pressEnter()
    await until(() => calls.filter((call) => call.method === "GET").length === readCount + 1, "cold current view GET")
    expect(calls.at(-1)?.method).toBe("GET")
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1)
    await ui.frame(dict["tui.browser.control.resolverAliDNS"])
    expect(uses).toEqual([])
    const zh = await import("../../../src/i18n/zh")
    const zht = await import("../../../src/i18n/zht")
    expect(zh.dict["tui.browser.control.resolverAliDNS"]).toBe("阿里 DNS over HTTPS")
    expect(zht.dict["tui.browser.control.resolverAliDNS"]).toBe("阿里 DNS over HTTPS")
  } finally {
    ui.app.renderer.destroy()
    transport.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
