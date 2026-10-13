/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSignal, Show } from "solid-js"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { DialogMcpSecrets } from "../src/component/dialog-mcp-secrets"
import { tmpdir } from "./fixture/fixture"
import { mountIM } from "./fixture/im-environment"

test("actual keyboard/SDK migration retains 32 unknown IDs per client and only known original receipt releases capacity", async () => {
  await using root = await tmpdir()
  const calls: { path: string; method: string; requestID?: string }[] = []
  const retained = new Map<string, string>()
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const name = decodeURIComponent(url.pathname.split("/")[2]!)
      const text = request.method === "GET" ? "" : await request.text()
      const body = text ? JSON.parse(text) as { requestID?: string } : undefined
      calls.push({ path: url.pathname, method: request.method, requestID: body?.requestID })
      if (url.pathname.endsWith("/preview")) return Response.json({ name, source: `${root.path}/deepagent-code.json`, previewID: "a".repeat(32), fields: [{ field: "headers", key: "Authorization" }] })
      if (url.pathname.endsWith("/commit")) {
        retained.set(name, body!.requestID!)
        return Response.json({ code: "unavailable", error: "controlled unknown" }, { status: 503 })
      }
      const known = url.pathname.endsWith("/reconcile")
      return Response.json({ name, requestID: retained.get(name), state: known ? "committed" : "stored", moved: known ? 1 : 0 })
    },
  })
  try {
    const original = createDeepAgentCodeClient({ baseUrl: server.url.origin, directory: root.path, throwOnError: true })
    let client = original
    const [name, setName] = createSignal("held-0")
    using ui = await mountIM(root.path, server.url.origin, () => <Show when={name()} keyed>{(current) => (
      <DialogMcpSecrets name={current} client={client} directory={root.path} server={server.url.origin} current={() => true} close={() => {}} />
    )}</Show>, 80)
    ui.app.renderer.resize(80, 24)
    const selections = [] as number[]
    const initialSelections = ui.app.renderer.listenerCount("selection")
    const commit = async () => {
      await ui.frame("Migrate these fields")
      ui.app.mockInput.pressArrow("down")
      ui.app.mockInput.pressArrow("down")
      ui.app.mockInput.pressArrow("down")
      ui.app.mockInput.pressEnter()
      await ui.frame("Move exactly the reviewed fields")
      ui.app.mockInput.pressEnter()
    }
    for (let i = 0; i < 32; i++) {
      setName(`held-${i}`)
      await commit()
      await ui.frame("Outcome unknown.")
      selections.push(ui.app.renderer.listenerCount("selection"))
      expect(calls.filter((call) => call.path.endsWith("/commit"))).toHaveLength(i + 1)
    }
    setName("blocked")
    await commit()
    await ui.frame("(capacity)")
    expect(calls.filter((call) => call.path.endsWith("/commit"))).toHaveLength(32)
    client = createDeepAgentCodeClient({ baseUrl: server.url.origin, directory: root.path, throwOnError: true })
    setName("independent-client")
    await commit()
    await ui.frame("Outcome unknown.")
    expect(calls.filter((call) => call.path.endsWith("/commit"))).toHaveLength(33)
    client = original
    setName("held-0")
    await ui.frame("Stored; Config not confirmed · 0")
    expect(ui.app.captureCharFrame()).not.toContain("Migrate these fields")
    expect(calls.filter((call) => call.path.endsWith("/commit"))).toHaveLength(33)
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressEnter()
    await ui.frame("Committed · 1")
    expect(calls.at(-1)?.path).toContain(retained.get("held-0")!)
    setName("blocked")
    await commit()
    await ui.frame("Outcome unknown.")
    expect(calls.filter((call) => call.path.endsWith("/commit"))).toHaveLength(34)
    expect(retained.size).toBe(34)
    ui[Symbol.dispose]()
    console.log("RI94_SELECTION_PROBE", JSON.stringify({ initialSelections, selections, afterRendererDestroy: ui.app.renderer.listenerCount("selection") }))
    expect(Math.max(...selections)).toBeLessThanOrEqual(4)
    expect(ui.app.renderer.listenerCount("selection")).toBe(0)
  } finally { server.stop(true) }
}, 30_000)
