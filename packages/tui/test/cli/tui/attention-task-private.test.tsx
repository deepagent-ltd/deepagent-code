/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Schema } from "effect"
import type { AttentionItem, SessionV2Info } from "@deepagent-code/sdk"
import { TaskHumanControlSchema } from "@deepagent-code/core/session/task-human-control.schema"
import { createTaskControlBridge } from "../../../../deepagent-code/src/cli/tui/task-control-bridge"
import { DialogAttention } from "../../../src/component/dialog-attention"
import { useDialog } from "../../../src/ui/dialog"
import { mountIM } from "../../fixture/im-environment"
import { tmpdir } from "../../fixture/fixture"

const Snapshot = Schema.Struct({
  reads: Schema.Int,
  controls: Schema.Array(TaskHumanControlSchema.Input),
  pending: Schema.Int,
})

function task(directory: string): AttentionItem {
  return {
    id: "task:private",
    revision: "a".repeat(64),
    kind: "task",
    state: "recovery_required",
    reasonCode: "task_recovery",
    occurredAt: 1,
    observedAt: 2,
    seen: false,
    seenAt: null,
    session: {
      id: "private-parent",
      title: "Private Task decision",
      projectID: "project-private",
      directory,
      workspaceID: null,
    },
    allowedActions: ["task_request_close", "task_resolve_failed", "task_resolve_closed"],
    source: {
      task: {
        runID: "run-private",
        parentSessionID: "private-parent",
        childSessionID: null,
        recordedChildSessionID: "recorded-private-child",
        generation: 2,
        version: 3,
        state: "recovery_required",
        controlState: "open",
        terminalReceiptID: null,
        pendingProviders: 1,
        pendingProviderAttempts: 1,
        pendingToolEffects: 1,
        hasExecutionClaim: false,
      },
    },
  }
}

// Real HTTP and parentPort + the production bridge are exercised here. The peer
// supplies controlled observations/receipts; Host fileDB tests prove authority.
async function fixture(directory: string) {
  const state = {
    item: task(directory),
    calls: [] as { method: string; path: string; body: unknown }[],
  }
  const session: SessionV2Info = {
    id: "private-parent",
    projectID: "project-private",
    title: "Private parent",
    location: { directory },
    permissions: [],
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const route = decodeURIComponent(url.pathname)
      const body: unknown = request.method === "GET" ? undefined : await request.json()
      state.calls.push({ method: request.method, path: route, body })
      if (route === "/api/attention/capability")
        return Response.json({ enabled: true, scope: "implicit-local", actor: "server", reason: "enabled" })
      const publicItem = state.item.kind === "task" ? { ...state.item, allowedActions: [] } : state.item
      if (route === "/api/attention")
        return Response.json({ data: [publicItem], unseenCount: 1, asOf: 2, scope: "implicit-local" })
      if (route === `/api/attention/${state.item.id}`) return Response.json({ data: publicItem })
      if (route === "/api/session/private-parent") return Response.json({ data: session })
      if (route === "/deepagent/goal/status")
        return Response.json({
          goal: {
            goalId: "goal-private",
            planDocId: "plan-private",
            phase: "paused",
            revision: 7,
            running: false,
            requestedPhase: "paused",
            preparation: "ready",
            inFlight: false,
            recoveryRequired: false,
            wakeState: "none",
            replayed: false,
          },
        })
      if (route === "/deepagent/goal/pause") {
        if (!body || typeof body !== "object" || !("sessionID" in body) || !("requestID" in body))
          throw new Error("Missing original Goal command")
        return Response.json({
          goalId: "goal-private",
          planDocId: "plan-private",
          phase: "paused",
          revision: 8,
          running: false,
          requestedPhase: "paused",
          preparation: "ready",
          inFlight: true,
          recoveryRequired: false,
          wakeState: "none",
          replayed: false,
          receiptID: `goalcmd_${new Bun.CryptoHasher("sha256").update(JSON.stringify([body.sessionID, body.requestID])).digest("hex")}`,
        })
      }
      return Response.json({}, { status: 405 })
    },
  })
  const worker = new Worker(new URL("../../fixture/task-human-bridge-worker.ts", import.meta.url))
  let sequence = 0
  function probe(action: string, input: Record<string, unknown> = {}) {
    return new Promise<typeof Snapshot.Type>((resolve, reject) => {
      const id = sequence++
      const timeout = setTimeout(() => {
        worker.removeEventListener("message", receive)
        reject(new Error("Controlled worker fixture timeout"))
      }, 3000)
      function receive(event: MessageEvent<unknown>) {
        const value = event.data
        if (
          !value ||
          typeof value !== "object" ||
          !("fixtureResult" in value) ||
          !("id" in value) ||
          value.id !== id ||
          !("data" in value)
        )
          return
        worker.removeEventListener("message", receive)
        clearTimeout(timeout)
        resolve(Schema.decodeUnknownSync(Snapshot)(value.data))
      }
      worker.addEventListener("message", receive)
      worker.postMessage({ fixture: action, id, ...input })
    })
  }
  const pending = createTaskControlBridge(worker, directory)
  await probe("init", { item: state.item, directory })
  const bridge = await pending
  return {
    state,
    url: server.url.toString(),
    bridge,
    probe,
    async [Symbol.asyncDispose]() {
      await probe("release")
      bridge.close()
      await bridge.transport.whenSettled()
      worker.terminate()
      server.stop(true)
    },
  }
}

async function confirmation(ui: Awaited<ReturnType<typeof mountIM>>, reason: string) {
  await ui.select("Request task closure")
  await ui.frame("Reason for this task decision")
  await ui.type(reason, true)
  ui.app.mockInput.pressEnter()
  await ui.frame("Confirm this decision")
}

test("private fresh Task observation advertises actions over public actions[] and keeps the original reviewed tuple at80x24", async () => {
  await using tmp = await tmpdir()
  await using peer = await fixture(tmp.path)
  using ui = await mountIM(tmp.path, peer.url, () => <DialogAttention />, 80, undefined, {
    taskControl: peer.bridge.transport,
  })
  ui.app.renderer.resize(80, 24)
  await ui.frame("Private Task decision")
  await ui.select("Private Task decision")
  await ui.frame("Request task closure")
  expect((await peer.probe("snapshot")).reads).toBe(1)
  await confirmation(ui, "  Preserve original reason 中  ")
  expect((await peer.probe("snapshot")).controls).toHaveLength(0)
  expect(peer.state.calls.every((entry) => entry.method === "GET")).toBe(true)
  await ui.select("Confirm this decision")
  await ui.frame("Decision submitted")
  const actual = await peer.probe("snapshot")
  expect(actual.controls).toHaveLength(1)
  expect(actual.controls[0]).toEqual({
    runID: "run-private",
    parentSessionID: "private-parent",
    childSessionID: null,
    generation: 2,
    expectedVersion: 3,
    itemID: "task:private",
    itemRevision: "a".repeat(64),
    requestID: expect.any(String),
    action: "request_close",
    reason: "  Preserve original reason 中  ",
  })
  expect(peer.state.calls.every((entry) => entry.method === "GET")).toBe(true)
})

test("private unknown decision survives read-only refresh and dialog reopening and retries only the same command explicitly", async () => {
  await using tmp = await tmpdir()
  await using peer = await fixture(tmp.path)
  const view = { reopen: () => {} }
  const setup = () => {
    const dialog = useDialog()
    view.reopen = () => dialog.replace(() => <DialogAttention />)
    return <box />
  }
  using ui = await mountIM(tmp.path, peer.url, () => <DialogAttention />, 80, setup, {
    taskControl: peer.bridge.transport,
  })
  ui.app.renderer.resize(80, 24)
  await ui.frame("Private Task decision")
  await ui.select("Private Task decision")
  await peer.probe("mode", { mode: "unknown" })
  await confirmation(ui, "Keep the exact unknown decision")
  await ui.select("Confirm this decision")
  await ui.frame("Retry the exact decision")
  const original = await peer.probe("snapshot")
  await peer.bridge.transport.whenSettled()
  expect(original.controls).toHaveLength(1)
  expect(original.pending).toBe(0)
  await ui.select("Refresh")
  await ui.frame("Retry the exact decision")
  view.reopen()
  await ui.frame("Private Task decision")
  await ui.select("Private Task decision")
  await ui.frame("Retry the exact decision")
  expect((await peer.probe("snapshot")).controls).toEqual(original.controls)
  await peer.probe("mode", { mode: "ok" })
  await ui.select("Retry the exact decision")
  await ui.frame("Decision submitted")
  await peer.bridge.transport.whenSettled()
  const settled = await peer.probe("snapshot")
  expect(settled.pending).toBe(0)
  expect(settled.controls).toEqual([original.controls[0]!, original.controls[0]!])
  expect(peer.state.calls.every((entry) => entry.method === "GET")).toBe(true)
})

test("a retired private Task owner cannot apply its late receipt to the new owner's reason", async () => {
  await using tmp = await tmpdir()
  await using peer = await fixture(tmp.path)
  const first = await mountIM(tmp.path, peer.url, () => <DialogAttention />, 80, undefined, {
    taskControl: peer.bridge.transport,
  })
  try {
    first.app.renderer.resize(80, 24)
    await first.frame("Private Task decision")
    await first.select("Private Task decision")
    await confirmation(first, "Old owner decision")
    await peer.probe("hold")
    await first.select("Confirm this decision")
    expect((await peer.probe("snapshot")).controls).toHaveLength(1)
    first.app.renderer.destroy()
    using second = await mountIM(tmp.path, peer.url, () => <DialogAttention />, 80, undefined, {
      taskControl: peer.bridge.transport,
    })
    second.app.renderer.resize(80, 24)
    await second.frame("Private Task decision")
    await second.select("Private Task decision")
    await second.select("Request task closure")
    await second.frame("Reason for this task decision")
    await second.type("New owner draft", true)
    await peer.probe("release")
    await peer.bridge.transport.whenSettled()
    await second.app.renderOnce()
    expect(second.app.captureCharFrame()).toContain("New owner draft")
    expect(second.app.captureCharFrame()).not.toContain("Decision submitted")
    expect((await peer.probe("snapshot")).controls).toHaveLength(1)
    expect(peer.state.calls.every((entry) => entry.method === "GET")).toBe(true)
  } finally {
    if (!first.app.renderer.isDestroyed) first.app.renderer.destroy()
  }
})

test("private Task rejection never falls back to the public mutation endpoint", async () => {
  await using tmp = await tmpdir()
  await using peer = await fixture(tmp.path)
  using ui = await mountIM(tmp.path, peer.url, () => <DialogAttention />, 80, undefined, {
    taskControl: peer.bridge.transport,
  })
  ui.app.renderer.resize(80, 24)
  await ui.frame("Private Task decision")
  await ui.select("Private Task decision")
  await confirmation(ui, "Explicit original refusal")
  await peer.probe("mode", { mode: "denied" })
  await ui.select("Confirm this decision")
  await ui.frame("The server rejected this decision")
  expect((await peer.probe("snapshot")).controls).toHaveLength(1)
  expect(peer.state.calls.every((entry) => entry.method === "GET")).toBe(true)
  expect(ui.app.captureCharFrame()).not.toContain("Retry the exact decision")
})

test("Goal controls remain on their original HTTP source and never borrow the private Task channel", async () => {
  await using tmp = await tmpdir()
  await using peer = await fixture(tmp.path)
  peer.state.item = {
    ...peer.state.item,
    id: "goal:private",
    revision: "b".repeat(64),
    kind: "goal",
    state: "paused",
    reasonCode: "goal_paused",
    allowedActions: ["goal_pause"],
    session: { ...peer.state.item.session, title: "Original Goal decision" },
    source: {
      goal: {
        goalID: "goal-private",
        controlRevision: 7,
        planRevision: 2,
        nextSeq: 1,
        planDocID: "plan-private",
        phase: "paused",
        preparation: "ready",
        pendingRebase: false,
        pendingPermits: 0,
        unknownPermits: 0,
        checkpointState: null,
        checkpointHash: null,
      },
    },
  }
  using ui = await mountIM(tmp.path, peer.url, () => <DialogAttention />, 80, undefined, {
    taskControl: peer.bridge.transport,
  })
  ui.app.renderer.resize(80, 24)
  await ui.frame("Original Goal decision")
  await ui.select("Original Goal decision")
  await ui.select("Pause goal")
  await ui.frame("Confirm this decision")
  expect((await peer.probe("snapshot")).reads).toBe(0)
  expect(peer.state.calls.every((entry) => entry.method === "GET")).toBe(true)
  await ui.select("Confirm this decision")
  await ui.frame("Decision submitted")
  const actual = await peer.probe("snapshot")
  expect(actual.reads).toBe(0)
  expect(actual.controls).toHaveLength(0)
  expect(peer.state.calls.filter((entry) => entry.method === "POST")).toEqual([
    {
      method: "POST",
      path: "/deepagent/goal/pause",
      body: {
        sessionID: "private-parent",
        goalId: "goal-private",
        expectedRevision: 7,
        requestID: expect.any(String),
      },
    },
  ])
})
