/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import type { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { ProjectProvider } from "../../../src/context/project"
import { DialogBrowserControl } from "../../../src/component/dialog-browser-control"
import { DialogSharedBrowser } from "../../../src/component/dialog-shared-browser"
import { useDialog } from "../../../src/ui/dialog"
import { mountIM } from "../../fixture/im-environment"

function resource(directory: string): SharedBrowserSchema.Resource {
  return {
    version: 2,
    profile: "managed-shared-browser-v1",
    inputAssurance: "shared-document-v1",
    resourceID: "shared-resource",
    requestID: "initial-create",
    requestDigest: "a".repeat(64),
    rootSessionID: "shared-session",
    scope: {
      principal: "owner",
      securityNamespaceID: "namespace",
      locationKey: "local",
      projectScopeKey: "project",
      namespaceBindingHash: "b".repeat(64),
      sessionID: "shared-session",
      projectID: "project",
      directory,
      workspaceID: null,
    },
    mainIncarnation: "main-a",
    policy: {
      origin: "https://example.com",
      approvedOrigins: ["https://example.com"],
      manualApprovedOrigins: ["https://example.com"],
      resolverPolicy: "system",
      postGrants: [],
    },
    policyHash: "c".repeat(64),
    state: "agent_owned",
    revision: 1,
    manualEpoch: 0,
    barrierOrder: 0,
    coreCutoff: -1,
    liveLeaseID: "lease-a",
    agentAccessFenced: false,
    resourceAlive: true,
    manualEnabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  }
}

test("existing browser menu opens shared creation through the generated SDK and preserves an unknown request across reopen", async () => {
  const root = await mkdtemp("/tmp/dac-tui-shared-create-")
  const calls: Array<{ path: string; body: SharedBrowserSchema.Create }> = []
  const used: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json({ resources: [] })
      const body = (await request.json()) as SharedBrowserSchema.Create
      calls.push({ path: new URL(request.url).pathname, body })
      if (calls.length === 1) return Response.json({ code: "BROWSER_UNKNOWN" }, { status: 503 })
      return Response.json({ resource: { ...resource(root), requestID: body.requestID, policy: body.policy } })
    },
  })
  const actions = { reopen: () => {} }
  const shared = () => (
    <ProjectProvider>
      <DialogSharedBrowser sessionID="shared-session" onUse={(id) => used.push(id)} />
    </ProjectProvider>
  )
  function Capture() {
    const dialog = useDialog()
    actions.reopen = () => dialog.replace(shared)
    return <box />
  }
  const ui = await mountIM(
    root,
    server.url.origin,
    () => (
      <ProjectProvider>
        <DialogBrowserControl sessionID="shared-session" onUse={() => {}} onOpenShared={() => actions.reopen()} />
      </ProjectProvider>
    ),
    100,
    () => <Capture />,
  )
  try {
    await ui.frame("Shared browser")
    await ui.choose("shared")
    await ui.frame("Create shared browser")
    await ui.choose("create")
    await ui.frame("JSON browser policy")
    await ui.type(JSON.stringify({ ...resource(root).policy, approvedOrigins: ["https://foreign.invalid"] }), true)
    ui.app.mockInput.pressEnter()
    await ui.frame("The browser policy is invalid")
    expect(calls).toHaveLength(0)
    await ui.type(JSON.stringify(resource(root).policy), true)
    ui.app.mockInput.pressEnter()
    await ui.frame("The operation is unconfirmed")
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe("/api/v1/browser/shared/resources")
    expect(calls[0].body).toMatchObject({
      version: 2,
      profile: "managed-shared-browser-v1",
      sessionID: "shared-session",
    })
    expect(calls[0].body.policy.postGrants).toEqual([])
    expect(calls[0].body.policy.filePolicy).toBeUndefined()
    expect(calls[0].body.policy.scriptGrants).toBeUndefined()
    actions.reopen()
    await ui.frame("Check original creation request")
    await ui.choose("retryCreate")
    await ui.frame("Agent is controlling")
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toEqual(calls[0].body)
    expect(used).toEqual([])
    await ui.choose("use")
    expect(used).toEqual(["shared-resource"])
  } finally {
    ui.app.renderer.destroy()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test("shared TUI reconciles takeover and close identities without exposing an acquire or synthetic input path", async () => {
  const root = await mkdtemp("/tmp/dac-tui-shared-control-")
  const current = { resource: resource(root) }
  const calls: Array<{ path: string; body: SharedBrowserSchema.Takeover }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json({ resources: [current.resource] })
      const path = new URL(request.url).pathname
      const body = (await request.json()) as SharedBrowserSchema.Takeover
      calls.push({ path, body })
      if (path.endsWith("/takeover")) {
        if (calls.filter((call) => call.path.endsWith("/takeover")).length === 1) {
          current.resource = {
            ...current.resource,
            state: "fenced_blocked",
            revision: 3,
            manualEpoch: 1,
            agentAccessFenced: true,
          }
          return Response.json({ code: "BROWSER_UNKNOWN" }, { status: 503 })
        }
        current.resource = { ...current.resource, state: "human_owned", revision: 4, manualEnabled: true }
        return Response.json({ resource: current.resource })
      }
      if (calls.filter((call) => call.path.endsWith("/close")).length === 1)
        return Response.json({ code: "BROWSER_UNKNOWN" }, { status: 503 })
      current.resource = {
        ...current.resource,
        state: "closed",
        revision: 5,
        resourceAlive: false,
        manualEnabled: false,
      }
      return Response.json({ resource: current.resource })
    },
  })
  const ui = await mountIM(root, server.url.origin, () => (
    <ProjectProvider>
      <DialogSharedBrowser sessionID="shared-session" />
    </ProjectProvider>
  ))
  try {
    await ui.frame("Agent is controlling")
    await ui.choose("takeover")
    await ui.frame("The operation is unconfirmed")
    expect(calls).toHaveLength(1)
    await ui.choose("refresh")
    await ui.frame("Handover not confirmed")
    await ui.choose("retryTakeover")
    await ui.frame("You are in control")
    expect(calls[1].body).toEqual(calls[0].body)
    expect(calls[0].body.expectedRevision).toBe(1)
    expect(ui.app.captureCharFrame()).toContain("This terminal has no trusted Desktop user-input")
    await ui.choose("close")
    await ui.frame("The operation is unconfirmed")
    await ui.choose("close")
    await ui.frame("Browser closed")
    expect(calls[3].body).toEqual(calls[2].body)
    expect(calls.every((call) => /\/(takeover|close)$/.test(call.path))).toBe(true)
    expect(calls.every((call) => !("inputStamp" in call.body))).toBe(true)
  } finally {
    ui.app.renderer.destroy()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test("shared TUI rejects another Session and does not invent cleanup requests for an observed blocked resource", async () => {
  const root = await mkdtemp("/tmp/dac-tui-shared-scope-")
  const observed = { value: { ...resource(root), rootSessionID: "another-session" } }
  const calls: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls.push(request.method)
      return Response.json({ resources: [observed.value] })
    },
  })
  const ui = await mountIM(root, server.url.origin, () => (
    <ProjectProvider>
      <DialogSharedBrowser sessionID="shared-session" />
    </ProjectProvider>
  ))
  try {
    await ui.frame("The original server, chat or workspace changed")
    observed.value = { ...resource(root), state: "fenced_blocked" }
    await ui.choose("refresh")
    await ui.frame("Handover not confirmed")
    const frame = await ui.frame("The original takeover request is unavailable")
    expect(frame).not.toContain("Retry original takeover cleanup")
    observed.value = { ...resource(root), state: "closing", revision: 2 }
    await ui.choose("refresh")
    const closing = await ui.frame("The original close request is unavailable")
    expect(closing).not.toContain("Close shared browser")
    expect(calls.every((method) => method === "GET")).toBe(true)
    await ui.choose("back")
  } finally {
    ui.app.renderer.destroy()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test("the original browser menu reaches shared controls by End without a nonfunctional search or side effects", async () => {
  const root = await mkdtemp("/tmp/dac-tui-shared-entry-")
  const counts = { posts: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method !== "GET") counts.posts++
      return Response.json({ resources: [] })
    },
  })
  const actions = { open: () => {} }
  function Capture() {
    const dialog = useDialog()
    actions.open = () =>
      dialog.replace(() => (
        <ProjectProvider>
          <DialogSharedBrowser sessionID="shared-session" />
        </ProjectProvider>
      ))
    return <box />
  }
  const ui = await mountIM(
    root,
    server.url.origin,
    () => (
      <ProjectProvider>
        <DialogBrowserControl sessionID="shared-session" onUse={() => {}} onOpenShared={() => actions.open()} />
      </ProjectProvider>
    ),
    100,
    () => <Capture />,
  )
  try {
    await ui.frame("Shared browser")
    expect(ui.app.captureCharFrame()).not.toContain("Search")
    ui.app.mockInput.pressKey("END")
    await ui.app.renderOnce()
    ui.app.mockInput.pressEnter()
    const shared = await ui.frame("Create shared browser")
    expect(shared).toContain("Back to chat")
    expect(shared).not.toContain("Search")
    expect(counts.posts).toBe(0)
  } finally {
    ui.app.renderer.destroy()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)
