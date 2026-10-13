/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { ProjectProvider } from "../../../src/context/project"
import { DialogEventWork } from "../../../src/component/dialog-event-work"
import { mountIM, until } from "../../fixture/im-environment"
import { createFetch } from "../../fixture/tui-sdk"

const budget = { maxTotalTokens: 2_105_344, maxInputTokens: 1_048_576, maxCompletionTokens: 4096,
  maxProviderDispatches: 2, maxToolCalls: 4, maxChildren: 2, maxDurationMs: 600_000,
  hourTokensMax: 2_105_344, hourWindowMinutes: 60 }
const candidate = { originID: "approved-origin", targetID: "approved-target", sourceSessionID: "ordinary-source",
  mode: "dag", available: true, profile: { id: "event_deepseek_dag_v1", version: 1, hash: "a".repeat(64) },
  providerID: "deepseek", modelID: "deepseek-flash", budget, serverNow: Date.now(), maxExpiresAt: Date.now() + 3_600_000 }
const rule = { ruleID: "original-rule", revision: 1, epoch: 1, originID: candidate.originID, targetID: candidate.targetID,
  mode: "dag", state: "enabled", instruction: "Original event task", expiresAt: candidate.maxExpiresAt,
  enabledAfterOrdinal: 3, allowedActions: ["pause", "revoke"] }
const root = { rootID: "original-root", receiptID: "original-receipt", ruleID: rule.ruleID, revision: 1,
  mode: "dag", state: "unknown", controlState: "active", expiresAt: candidate.maxExpiresAt, budget,
  reservedTokens: 1_052_672, providerConcurrency: 1, schedulingConcurrency: 2, reason: "effect_unconfirmed",
  nodes: [{ nodeID: "read", agentID: "original-agent", dependencies: [], state: "unknown", workID: "original-work",
    sessionID: "historical-session", inputID: "original-input", controlRevision: 1, reservedTokens: 1_052_672, sessionAvailable: false }],
  allowedActions: ["cancel"] }

async function serve(unavailable = false) {
  const defaults = createFetch()
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const commands: Record<string, unknown>[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/api/v1/event-work/")) return defaults.fetch(request)
    const body = await request.json() as Record<string, unknown>
    requests.push({ path: url.pathname, body })
    if (unavailable) return Response.json({ code: "EVENT_WORK_AUTH_REQUIRED", message: "Unavailable", status: 403 }, { status: 403 })
    if (url.pathname.endsWith("/candidates")) return Response.json([candidate])
    if (url.pathname.endsWith("/rules")) return Response.json({ items: [rule], nextCursor: null })
    if (url.pathname.endsWith("/roots")) return Response.json({ items: [root], nextCursor: null })
    if (url.pathname.endsWith("/control")) {
      commands.push(body)
      if (commands.length === 1) return Response.json({ code: "EVENT_WORK_UNAVAILABLE", message: "Unavailable", status: 503 }, { status: 503 })
      return Response.json({ requestID: body.requestID, expectedRevision: body.expectedRevision, action: body.action, replayed: true,
        root: { ...root, controlState: "cancelled", revision: 2 } })
    }
    return Response.json({}, { status: 404 })
  } })
  return { server, requests, commands }
}

test("original TUI event DAG cancel retains unknown custody and only explicit exact retry submits again", async () => {
  const directory = await mkdtemp("/tmp/dac-event-ui-tui-")
  const api = await serve()
  const opens: string[] = []
  const ui = await mountIM(directory, api.server.url.origin, () => <ProjectProvider>
    <DialogEventWork sessionID="ordinary-source" onOpenSession={(id) => opens.push(id)} />
  </ProjectProvider>, 120)
  try {
    await ui.frame("original-rule")
    Array.from({ length: 2 }, () => ui.app.mockInput.pressArrow("down"))
    ui.app.mockInput.pressEnter()
    await ui.frame("original-root")
    await until(() => api.requests.filter((request) => request.path.endsWith("/roots")).length === 2, "current rule roots read")
    await Bun.sleep(20)
    await ui.app.renderOnce()
    await [0, 1, 2].reduce(async (previous) => {
      await previous
      ui.app.mockInput.pressArrow("down")
      await ui.app.renderOnce()
      await Bun.sleep(10)
    }, Promise.resolve())
    ui.app.mockInput.pressEnter()
    await ui.frame("Cancel this run")
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressEnter()
    await ui.frame("Confirm reviewed control")
    expect(api.commands).toHaveLength(0)
    ui.app.mockInput.pressEnter()
    await until(() => api.commands.length === 1, "original root cancel HTTP")
    await ui.frame("Retry original command explicitly")
    await until(() => api.commands.length === 1, "original command result observed")
    await Bun.sleep(20)
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressEnter()
    await until(() => api.commands.length === 2, "exact original root cancel retry")
    expect(api.commands[1]).toEqual(api.commands[0])
    expect(api.commands[0]).toMatchObject({ sourceSessionID: "ordinary-source", rootID: root.rootID,
      action: "cancel", expectedRevision: 1 })
    expect(api.requests.every((request) => request.body.sourceSessionID === "ordinary-source")).toBe(true)
    expect(opens).toEqual([])
  } finally { ui.app.renderer.destroy(); api.server.stop(true); await rm(directory, { recursive: true, force: true }) }
}, 15_000)

test("original TUI event management unavailable read has explicit failure and no command or session request", async () => {
  const directory = await mkdtemp("/tmp/dac-event-ui-tui-denied-")
  const api = await serve(true)
  const ui = await mountIM(directory, api.server.url.origin, () => <ProjectProvider>
    <DialogEventWork sessionID="ordinary-source" />
  </ProjectProvider>, 120)
  try {
    await ui.frame("EVENT_WORK_AUTH_REQUIRED")
    expect(api.requests).toHaveLength(2)
    expect(api.commands).toEqual([])
    expect(api.requests.every((request) => /\/(rules|candidates)$/.test(request.path))).toBe(true)
  } finally { ui.app.renderer.destroy(); api.server.stop(true); await rm(directory, { recursive: true, force: true }) }
}, 15_000)

test("original TUI uses a qualified child directory while its pointer reads keep the parent source scope", async () => {
  const directory = await mkdtemp("/tmp/dac-event-ui-tui-child-")
  const child = directory + "/derived-worktree"
  const defaults = createFetch()
  const pointer = { version: 1, rootID: root.rootID, nodeID: "read", workID: "original-work", sessionID: "child-session",
    inputID: "original-input", rootRevision: 1, controlRevision: 1, bindingHash: "b".repeat(64),
    placement: { directory: child, workspaceID: null, projectID: "child-project", securityNamespaceID: "namespace", namespaceBindingHash: "c".repeat(64) }, expiresAt: Date.now() + 600_000 }
  const calls: { path: string; directory: string | null; body?: Record<string, unknown> }[] = []
  const opens: string[] = []
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/session/child-session") {
      calls.push({ path: url.pathname, directory: url.searchParams.get("directory") })
      return Response.json({ id: pointer.sessionID, directory: child, workspaceID: null, projectID: "child-project" })
    }
    if (!url.pathname.startsWith("/api/v1/event-work/")) return defaults.fetch(request)
    const body = await request.json() as Record<string, unknown>
    calls.push({ path: url.pathname, directory: url.searchParams.get("directory"), body })
    if (url.pathname.endsWith("/candidates")) return Response.json([candidate])
    if (url.pathname.endsWith("/rules")) return Response.json({ items: [rule], nextCursor: null })
    if (url.pathname.endsWith("/roots")) return Response.json({ items: [{ ...root, nodes: [{ ...root.nodes[0], sessionID: pointer.sessionID, sessionAvailable: true }] }], nextCursor: null })
    if (url.pathname.endsWith("/session")) return Response.json(pointer)
    return Response.json({}, { status: 404 })
  } })
  const ui = await mountIM(directory, api.url.origin, () => <ProjectProvider>
    <DialogEventWork sessionID="ordinary-source" onOpenSession={(id) => opens.push(id)} />
  </ProjectProvider>, 120)
  try {
    await ui.frame("original-rule")
    await [0, 1].reduce(async (previous) => {
      await previous
      ui.app.mockInput.pressArrow("down")
      await ui.app.renderOnce()
      await Bun.sleep(10)
    }, Promise.resolve())
    ui.app.mockInput.pressEnter()
    await ui.frame("original-root")
    await until(() => calls.some((entry) => entry.path.endsWith("/roots")), "current root list")
    await Bun.sleep(20)
    await ui.app.renderOnce()
    await [0, 1, 2].reduce(async (previous) => {
      await previous
      ui.app.mockInput.pressArrow("down")
      await ui.app.renderOnce()
      await Bun.sleep(10)
    }, Promise.resolve())
    ui.app.mockInput.pressEnter()
    await ui.frame("Open original task session")
    await [0, 1].reduce(async (previous) => {
      await previous
      ui.app.mockInput.pressArrow("down")
      await ui.app.renderOnce()
      await Bun.sleep(10)
    }, Promise.resolve())
    ui.app.mockInput.pressEnter()
    await until(() => opens.length === 1, "qualified child original Session open")
    expect(opens).toEqual([pointer.sessionID])
    expect(calls.slice(-3).map((entry) => entry.path)).toEqual(["/api/v1/event-work/session", "/session/child-session", "/api/v1/event-work/session"])
    expect(calls.filter((entry) => entry.path === "/api/v1/event-work/session").every((entry) => entry.directory === directory && entry.body?.sourceSessionID === "ordinary-source")).toBe(true)
    expect(calls.find((entry) => entry.path === "/session/child-session")?.directory).toBe(child)
    expect(calls.some((entry) => entry.path.endsWith("/control"))).toBe(false)
  } finally { ui.app.renderer.destroy(); api.stop(true); await rm(directory, { recursive: true, force: true }) }
}, 15_000)
