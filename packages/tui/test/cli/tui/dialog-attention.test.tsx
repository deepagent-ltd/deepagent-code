/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { AttentionItem, SessionV2Info } from "@deepagent-code/sdk"
import { Schema } from "effect"
import { TaskHumanControlSchema } from "@deepagent-code/core/session/task-human-control.schema"
import { DialogAttention, attentionCommand } from "../../../src/component/dialog-attention"
import { CommandPaletteDialog } from "../../../src/component/command-palette"
import { useDialog } from "../../../src/ui/dialog"
import { useTuiI18n } from "../../../src/context/i18n"
import { useBindings, useCommandSlashes } from "../../../src/keymap"
import { tmpdir } from "../../fixture/fixture"
import { mountIM, until } from "../../fixture/im-environment"

function fixture(directory: string) {
  const target = `${directory}/project A`
  const item: AttentionItem = {
    id: "execution:session-a",
    revision: "revision-1",
    kind: "execution_recovery",
    state: "recovery_required",
    reasonCode: "recovery_required",
    occurredAt: 1,
    observedAt: 2,
    seen: false,
    seenAt: 0,
    session: {
      id: "session-a",
      title: "Project A recovery",
      projectID: "project-a",
      directory: target,
      workspaceID: null,
    },
    source: {},
  }
  const session: SessionV2Info = {
    id: "session-a",
    projectID: "project-a",
    title: "Project A history",
    location: { directory: target },
    permissions: [],
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  const state = {
    item,
    session,
    enabled: true,
    failure: false,
    stale: false,
    repeatCursor: false,
    delay: undefined as Promise<void> | undefined,
    text: "Target project message body",
    controlOutcome: "ok" as "ok" | "unknown" | "wrong",
    controlHold: undefined as Promise<void> | undefined,
    parentHold: undefined as Promise<void> | undefined,
    requiredAuth: undefined as string | undefined,
    calls: [] as {
      method: string
      path: string
      query: URLSearchParams
      body: unknown
      directory: string | null
      auth: string | null
      origin: string | null
    }[],
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      url.pathname = decodeURIComponent(url.pathname)
      const body: unknown = request.method === "GET" ? undefined : await request.json()
      state.calls.push({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body,
        directory: request.headers.get("x-deepagent-code-directory"),
        auth: request.headers.get("authorization"),
        origin: request.headers.get("origin"),
      })
      if (state.requiredAuth && request.headers.get("authorization") !== state.requiredAuth)
        return Response.json({}, { status: 401 })
      if (state.failure)
        return Response.json({ _tag: "ServiceUnavailableError", message: "secret diagnostic" }, { status: 503 })
      if (url.pathname === "/api/attention/capability")
        return Response.json({
          enabled: state.enabled,
          scope: "implicit-local",
          actor: "server",
          reason: state.enabled ? "enabled" : "profile_disabled",
        })
      if (url.pathname === "/api/attention") {
        const cursor = url.searchParams.get("cursor")
        const rows = cursor
          ? [{ ...state.item, id: "second", session: { ...state.item.session, title: "Second page result" } }]
          : [state.item]
        return Response.json({
          data: rows.filter(
            (item) =>
              (url.searchParams.get("view") !== "unseen" || !item.seen) &&
              (!url.searchParams.get("kind") || item.kind === url.searchParams.get("kind")),
          ),
          nextCursor: !cursor || state.repeatCursor ? "page-2" : undefined,
          unseenCount: Number(!state.item.seen),
          asOf: 2,
          scope: "implicit-local",
        })
      }
      if (url.pathname === `/api/attention/${state.item.id}`) return Response.json({ data: state.item })
      if (url.pathname === "/api/attention/second")
        return Response.json({
          data: { ...state.item, id: "second", session: { ...state.item.session, title: "Second page result" } },
        })
      if (url.pathname === `/api/attention/${state.item.id}/seen`) {
        await state.delay
        if (state.stale) return Response.json({ _tag: "ConflictError", message: "secret conflict" }, { status: 409 })
        state.item = { ...state.item, seen: true, seenAt: 3 }
        return Response.json({ data: state.item })
      }
      if (url.pathname === `/api/session/${state.session.id}`) return Response.json({ data: state.session })
      if (url.pathname === "/api/session/actual-parent") {
        await state.parentHold
        return Response.json({ data: { ...state.session, id: "actual-parent", title: "Actual parent history" } })
      }
      if (url.pathname === "/api/attention/task/control") {
        const original = Schema.decodeUnknownSync(TaskHumanControlSchema.Input)(body)
        await state.controlHold
        if (state.controlOutcome === "unknown") return Response.json({}, { status: 503 })
        return Response.json({
          replayed: false,
          receipt: {
            contract: "task-human-control-v1",
            receiptID: "controlled-receipt",
            requestHash: "d".repeat(64),
            request: state.controlOutcome === "wrong" ? { ...original, requestID: "foreign-request" } : original,
            authority: {
              scope: "implicit-local",
              principal: "operator",
              directory: target,
              projectID: state.session.projectID,
              permissionEpoch: 1,
            },
            recordedChildSessionID: "recorded-child",
            version: 4,
            state: "recovery_required",
            controlState: "close_requested",
            terminalReceiptID: null,
            affectedRuns: 1,
            time: 2,
          },
        })
      }
      const goal = {
        goalId: "goal-controls",
        planDocId: "plan-controls",
        phase: "paused",
        running: false,
        revision: 7,
        requestedPhase: "paused",
        preparation: "ready",
        inFlight: false,
        recoveryRequired: false,
        wakeState: "none",
        replayed: false,
      }
      if (url.pathname === "/deepagent/goal/status") return Response.json({ goal })
      if (["/deepagent/goal/pause", "/deepagent/goal/resume", "/deepagent/goal/stop"].includes(url.pathname)) {
        if (!body || typeof body !== "object" || !("sessionID" in body) || !("requestID" in body))
          throw new Error("Missing original body")
        await state.controlHold
        if (state.controlOutcome === "unknown") return Response.json({}, { status: 503 })
        const action = url.pathname.split("/").at(-1)
        return Response.json({
          ...goal,
          revision: 8,
          inFlight: true,
          requestedPhase: action === "pause" ? "paused" : action === "resume" ? "running" : "stopped",
          receiptID:
            state.controlOutcome === "wrong"
              ? "goalcmd_foreign"
              : `goalcmd_${new Bun.CryptoHasher("sha256")
                  .update(JSON.stringify([body.sessionID, body.requestID]))
                  .digest("hex")}`,
        })
      }
      if (
        url.pathname === `/api/session/${state.session.id}/message` ||
        url.pathname === "/api/session/actual-parent/message"
      ) {
        if (url.searchParams.get("directory") !== target || url.searchParams.get("location[directory]") !== target)
          return Response.json({ _tag: "InvalidRequestError", message: "Wrong target placement" }, { status: 400 })
        const next = url.searchParams.get("cursor") === "messages-2"
        return Response.json({
          data: [
            {
              id: next ? "message-2" : "message-1",
              type: "user",
              text: next ? "Target older page" : state.text,
              time: { created: 1 },
            },
          ],
          cursor: next ? { previous: "messages-1" } : { next: "messages-2" },
        })
      }
      return Response.json({ _tag: "InvalidRequestError", message: "Unexpected write or endpoint" }, { status: 400 })
    },
  })
  return {
    state,
    target,
    url: server.url.toString(),
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

test("Attention renderer reads only, explicitly marks the observed revision, preserves recovery, and guards pending input", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("Project A recovery")
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
  await ui.select("Project A recovery")
  await ui.frame("Mark viewed")
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
  let release = () => {}
  api.state.delay = new Promise<void>((resolve) => {
    release = resolve
  })
  await ui.select("Mark viewed")
  ui.app.mockInput.pressEnter()
  await until(() => api.state.calls.some((call) => call.method === "PUT"))
  expect(api.state.calls.filter((call) => call.method === "PUT")).toHaveLength(1)
  expect(api.state.calls.find((call) => call.method === "PUT")?.body).toEqual({ revision: "revision-1" })
  release()
  await ui.frame("Viewed")
  expect(ui.app.captureCharFrame()).toContain("Recovery required")
  expect(ui.app.captureCharFrame()).not.toContain("Mark viewed")
  expect(api.state.item.state).toBe("recovery_required")
  expect(api.state.calls.every((call) => call.auth === "Bearer fixture-token")).toBe(true)
})

test("Attention uses generated paths, keyboard pagination, server filters, and stale revision refresh", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("Project A recovery")
  await ui.select("Next page")
  await ui.frame("Second page result")
  expect(api.state.calls.at(-1)?.query.get("cursor")).toBe("page-2")
  await ui.select("Previous page")
  await ui.frame("Project A recovery")
  await ui.select("View: Unviewed")
  await ui.frame("View: All")
  expect(api.state.calls.at(-1)?.query.get("view")).toBe("all")
  await ui.select("Type: All types")
  await ui.frame("No attention items match")
  expect(api.state.calls.at(-1)?.query.get("kind")).toBe("activity_failed")
  await ui.select("Type: Failed activity")
  await ui.frame("Project A recovery")
  expect(api.state.calls.at(-1)?.query.get("kind")).toBe("execution_recovery")
  await ui.select("Project A recovery")
  await ui.frame("Mark viewed")
  api.state.stale = true
  await ui.select("Mark viewed")
  await ui.frame("This item changed")
  expect(ui.app.captureCharFrame()).not.toContain("secret conflict")
  expect(ui.app.captureCharFrame()).not.toContain("Read session history")
  expect(api.state.calls.filter((call) => call.method === "PUT")).toHaveLength(1)
  api.state.failure = true
  await ui.select("Refresh")
  await ui.frame("Request failed")
  await ui.type("", true)
  await ui.app.renderOnce()
  expect(ui.app.captureCharFrame()).not.toContain("Mark viewed")
  api.state.failure = false
  api.state.stale = false
  api.state.item.revision = "revision-2"
  await ui.select("Refresh")
  await ui.frame("Mark viewed")
  await ui.select("Mark viewed")
  await ui.frame("Viewed")
  expect(api.state.calls.filter((call) => call.method === "PUT").at(-1)?.body).toEqual({ revision: "revision-2" })
})

test("cross-project history resolves server placement, retains auth, and leaves current SDK directory unchanged", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("Project A recovery")
  await ui.select("Project A recovery")
  await ui.frame("Read session history")
  await ui.select("Read session history")
  await ui.frame("Target project message body")
  expect(ui.app.captureCharFrame().replace(/\s+/g, " ")).toContain("Cross-project editing is unavailable")
  const get = api.state.calls.find((call) => call.path === "/api/session/session-a")!
  const messages = api.state.calls.find((call) => call.path === "/api/session/session-a/message")!
  expect(get.query.get("directory")).toBe(tmp.path)
  expect(messages.query.get("directory")).toBe(api.target)
  expect(messages.query.get("location[directory]")).toBe(api.target)
  expect(messages.auth).toBe("Bearer fixture-token")
  expect(messages.directory).toBeNull()
  await ui.select("Next page")
  await ui.frame("Target older page")
  expect(api.state.calls.at(-1)?.query.get("cursor")).toBe("messages-2")
  await ui.select("Target older page")
  await ui.frame("Target older page")
  await ui.select("Back")
  await ui.frame("Read session history")
  await ui.select("Back")
  await ui.frame("Mark viewed")
  await ui.select("Back")
  await ui.frame("Project A recovery")
  expect(api.state.calls.at(-1)?.query.get("directory")).toBe(tmp.path)
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})

test("disabled and failed capability are explicit and cannot mutate; refresh can recover", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  api.state.enabled = false
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("disabled in this host profile")
  expect(api.state.calls.map((call) => call.path)).toEqual(["/api/attention/capability"])
  api.state.failure = true
  await ui.select("Refresh")
  await ui.frame("Request failed")
  expect(ui.app.captureCharFrame()).not.toContain("secret diagnostic")
  api.state.failure = false
  api.state.enabled = true
  await ui.select("Refresh")
  await ui.frame("Project A recovery")
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})

test("changed placement refuses history and repeated list cursor fails without losing the current page", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("Project A recovery")
  api.state.repeatCursor = true
  await ui.select("Next page")
  await ui.frame("Request failed")
  api.state.repeatCursor = false
  await ui.select("Refresh")
  await ui.frame("Project A recovery")
  await ui.select("Project A recovery")
  await ui.frame("Read session history")
  api.state.session.location.directory = `${tmp.path}/wrong-project`
  await ui.select("Read session history")
  await ui.frame("This item changed")
  expect(api.state.calls.some((call) => call.path.endsWith("/message"))).toBe(false)
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})

test("Attention is reachable from the real command palette and slash-command registry", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  let slash: (() => void) | undefined
  function Register() {
    const dialog = useDialog()
    const i18n = useTuiI18n()
    useBindings(() => ({ commands: [{ ...attentionCommand(dialog, i18n), namespace: "palette" }] }))
    const entries = useCommandSlashes()
    return (
      <box>
        <text>
          {(() => {
            const entry = entries().find((value) => value.display === "/attention")
            slash = entry?.onSelect
            return entry?.display ?? "missing slash"
          })()}
        </text>
      </box>
    )
  }
  using ui = await mountIM(tmp.path, api.url, () => <CommandPaletteDialog />, 100, Register)
  await ui.frame("Needs attention")
  expect(api.state.calls).toHaveLength(0)
  expect(slash).toBeFunction()
  await ui.select("Needs attention")
  await ui.frame("Project A recovery")
  const before = api.state.calls.length
  slash!()
  await until(() => api.state.calls.length > before)
  await ui.frame("Project A recovery")
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})

test("read-only message detail scrolls with the keyboard without calling a write endpoint", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  api.state.text = Array.from({ length: 30 }, (_, i) => `history-line-${String(i).padStart(2, "0")}`).join("\n")
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />)
  await ui.frame("Project A recovery")
  await ui.select("Project A recovery")
  await ui.frame("Read session history")
  await ui.select("Read session history")
  await ui.frame("history-line-00")
  await ui.select("history-line-00")
  await ui.frame("Ctrl+D / Ctrl+U")
  expect(ui.app.captureCharFrame()).not.toContain("history-line-29")
  for (let i = 0; i < 5; i++) {
    ui.app.mockInput.pressKey("d", { ctrl: true })
    await ui.app.renderOnce()
  }
  await ui.frame("history-line-29")
  for (let i = 0; i < 5; i++) {
    ui.app.mockInput.pressKey("u", { ctrl: true })
    await ui.app.renderOnce()
  }
  await ui.frame("history-line-00")
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})

test("Task source uses actual child and parent placements, preserves rank page on return, and viewed never closes unknown effects", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  api.state.item = {
    ...api.state.item,
    id: "task:one",
    kind: "task",
    state: "recovery_required",
    reasonCode: "task_recovery",
    allowedActions: [],
    session: { ...api.state.item.session, title: "Task with unknown effects", parentID: "actual-parent" },
    source: {
      task: {
        runID: "internal-run",
        parentSessionID: "actual-parent",
        childSessionID: "session-a",
        recordedChildSessionID: "recorded-child",
        generation: 1,
        version: 2,
        state: "recovery_required",
        controlState: "close_requested",
        terminalReceiptID: null,
        pendingProviders: 1,
        pendingProviderAttempts: 1,
        pendingToolEffects: 1,
        hasExecutionClaim: false,
      },
    },
  }
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />, 80)
  ui.app.renderer.resize(80, 24)
  await ui.frame("Task with unknown effects")
  await ui.select("Type: All types")
  await ui.frame("Type: Failed activity")
  await ui.select("Type: Failed activity")
  await ui.frame("Type: Execution recovery")
  await ui.select("Type: Execution recovery")
  await ui.frame("Type: Progress needs review")
  await ui.select("Type: Progress needs review")
  await ui.frame("Task with unknown effects")
  expect(api.state.calls.at(-1)?.query.get("kind")).toBe("task")
  await ui.select("Task with unknown effects")
  await ui.frame("Open parent session")
  expect(ui.app.captureCharFrame()).not.toContain("internal-run")
  expect(ui.app.captureCharFrame()).not.toContain("Continue once")
  await ui.select("Open parent session")
  await ui.frame("Actual parent history")
  await ui.select("Target project message body")
  await ui.frame("Target project message body")
  await ui.select("Back")
  expect(api.state.calls.some((call) => call.path === "/api/session/actual-parent")).toBe(true)
  expect(
    api.state.calls.some(
      (call) => call.path === "/api/session/recorded-child" || call.path === "/api/session/internal-run",
    ),
  ).toBe(false)
  await ui.select("Back")
  await ui.frame("Mark viewed")
  await ui.select("Mark viewed")
  await ui.frame("Viewed")
  expect(api.state.item.state).toBe("recovery_required")
  expect(api.state.item.source.task?.pendingToolEffects).toBe(1)
  expect(api.state.item.source.task?.controlState).toBe("close_requested")
  expect(api.state.calls.filter((call) => call.method === "PUT")).toHaveLength(1)
  expect(api.state.calls.filter((call) => call.method === "POST")).toHaveLength(0)
  await ui.select("Back")
  await ui.frame("Type: Task results")
  await ui.select("View: Unviewed")
  await ui.frame("Task with unknown effects")
  await ui.select("Next page")
  await ui.frame("Second page result")
  await ui.select("Second page result")
  await ui.frame("Read session history")
  await ui.select("Back")
  await ui.frame("Second page result")
  expect(api.state.calls.at(-1)?.query.get("cursor")).toBe("page-2")
  expect(api.state.calls.at(-1)?.query.get("kind")).toBe("task")
})

test("Goal filter renders pending rebase and unknown steps at 80 columns without inferred controls", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  api.state.item = {
    ...api.state.item,
    id: "goal:one",
    kind: "goal",
    state: "recovery_required",
    reasonCode: "goal_recovery",
    allowedActions: [],
    session: { ...api.state.item.session, title: "Goal with pending rebase" },
    source: {
      goal: {
        goalID: "goal-one",
        controlRevision: 2,
        planRevision: 3,
        nextSeq: 4,
        planDocID: "plan-one",
        phase: "paused",
        preparation: "ready",
        pendingRebase: true,
        pendingPermits: 1,
        unknownPermits: 1,
        checkpointState: null,
        checkpointHash: null,
      },
    },
  }
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />, 80)
  ui.app.renderer.resize(80, 24)
  await ui.frame("Goal with pending rebase")
  for (const [label, kind] of [
    ["All types", "activity_failed"],
    ["Failed activity", "execution_recovery"],
    ["Execution recovery", "no_progress"],
    ["Progress needs review", "task"],
    ["Task results", "goal"],
  ]) {
    await ui.select(`Type: ${label}`)
    await until(() => api.state.calls.at(-1)?.query.get("kind") === kind)
    await ui.type("", true)
  }
  await ui.frame("Goal with pending rebase")
  expect(api.state.calls.at(-1)?.query.get("kind")).toBe("goal")
  await ui.select("Goal with pending rebase")
  await ui.frame("Read session history")
  for (let step = 0; step < 8 && !ui.app.captureCharFrame().includes("Plan change pending: Yes"); step++) {
    ui.app.mockInput.pressKey("d", { ctrl: true })
    await ui.app.renderOnce()
  }
  await ui.frame("Plan change pending: Yes")
  expect(ui.app.captureCharFrame()).not.toContain("Continue once")
  expect(ui.app.captureCharFrame()).not.toContain("Stop activity")
  expect(api.state.calls.every((call) => call.method === "GET")).toBe(true)
})

function taskControls(item: AttentionItem): AttentionItem {
  return {
    ...item,
    id: "task:controls",
    revision: "a".repeat(64),
    kind: "task",
    state: "recovery_required",
    reasonCode: "task_recovery",
    session: { ...item.session, title: "Task controls" },
    allowedActions: ["task_request_close", "task_resolve_failed", "task_resolve_closed"],
    source: {
      task: {
        runID: "run-controls",
        parentSessionID: "actual-parent",
        childSessionID: null,
        recordedChildSessionID: "recorded-child",
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
function goalControls(item: AttentionItem): AttentionItem {
  return {
    ...item,
    id: "goal:controls",
    revision: "b".repeat(64),
    kind: "goal",
    state: "paused",
    reasonCode: "goal_paused",
    session: { ...item.session, title: "Goal controls" },
    allowedActions: ["goal_pause", "goal_resume", "goal_stop", "goal_edit"],
    source: {
      goal: {
        goalID: "goal-controls",
        controlRevision: 7,
        planRevision: 2,
        nextSeq: 1,
        planDocID: "plan-controls",
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
}
const controlHeaders = {
  Authorization: `Basic ${Buffer.from("operator:private-attention").toString("base64")}`,
  Origin: "oc://renderer",
}

// Actual renderer + formal SDK + HTTP with controlled receipts; this does not mint
// operator authority or synthesize a Task/Goal execution outcome.
test("Basic HTTP Task controls at 80x24 keep unknown custody and exact retry, preserve nullable child and original reasons", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  api.state.item = taskControls(api.state.item)
  api.state.requiredAuth = controlHeaders.Authorization
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />, 80, undefined, { headers: controlHeaders })
  ui.app.renderer.resize(80, 24)
  await ui.frame("Task controls")
  await ui.select("Task controls")
  await ui.select("Request task closure")
  await ui.frame("Reason for this task decision")
  await ui.type("  Preserve unknown custody 中  ", true)
  ui.app.mockInput.pressEnter()
  await ui.frame("Confirm this decision")
  expect(api.state.calls.filter((call) => call.method === "POST")).toHaveLength(0)
  api.state.controlOutcome = "unknown"
  await ui.select("Confirm this decision")
  await ui.frame("Retry the exact decision")
  const first = api.state.calls.find((call) => call.method === "POST")!
  expect(first.query.get("directory")).toBe(api.target)
  expect(first.body).toEqual(
    expect.objectContaining({
      runID: "run-controls",
      parentSessionID: "actual-parent",
      childSessionID: null,
      generation: 2,
      expectedVersion: 3,
      itemID: "task:controls",
      itemRevision: "a".repeat(64),
      action: "request_close",
      reason: "  Preserve unknown custody 中  ",
    }),
  )
  await ui.select("Refresh")
  await ui.frame("Retry the exact decision")
  expect(api.state.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  api.state.controlOutcome = "ok"
  await ui.select("Retry the exact decision")
  await ui.frame("Decision submitted")
  expect(api.state.calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
    first.body,
    first.body,
  ])
  expect(api.state.item.state).toBe("recovery_required")
  expect(api.state.item.source.task?.pendingToolEffects).toBe(1)
  for (const action of ["Record task as failed", "Record task as closed"]) {
    await ui.select(action)
    await ui.frame("Reason for this task decision")
    await ui.type(action, true)
    ui.app.mockInput.pressEnter()
    await ui.frame("Confirm this decision")
    await ui.select("Confirm this decision")
    await ui.frame("Decision submitted")
  }
  const posts = api.state.calls.filter((call) => call.method === "POST")
  expect(posts.map((call) => Schema.decodeUnknownSync(TaskHumanControlSchema.Input)(call.body).action)).toEqual([
    "request_close",
    "request_close",
    "resolve_failed",
    "resolve_closed",
  ])
  expect(
    api.state.calls.every((call) => call.auth === controlHeaders.Authorization && call.origin === "oc://renderer"),
  ).toBe(true)
  expect(api.state.calls.some((call) => /wake|prompt|permission/.test(call.path))).toBe(false)
})

for (const action of ["pause", "resume", "stop"] as const) {
  test(`Basic HTTP Goal ${action} validates original status, exact receipt and explicit retry at 80x24`, async () => {
    await using tmp = await tmpdir()
    using api = fixture(tmp.path)
    api.state.item = goalControls(api.state.item)
    api.state.requiredAuth = controlHeaders.Authorization
    using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />, 80, undefined, { headers: controlHeaders })
    ui.app.renderer.resize(80, 24)
    await ui.frame("Goal controls")
    await ui.select("Goal controls")
    await ui.select(({ pause: "Pause goal", resume: "Resume goal", stop: "Stop goal" } as const)[action])
    await ui.frame("Confirm this decision")
    api.state.controlOutcome = "wrong"
    await ui.select("Confirm this decision")
    await ui.frame("Retry the exact decision")
    const first = api.state.calls.find((call) => call.method === "POST")!
    expect(first.path).toBe(`/deepagent/goal/${action}`)
    expect(first.query.get("directory")).toBe(api.target)
    expect(first.body).toEqual({
      sessionID: "session-a",
      goalId: "goal-controls",
      expectedRevision: 7,
      requestID: expect.any(String),
    })
    expect(api.state.calls.find((call) => call.path === "/deepagent/goal/status")?.query.get("directory")).toBe(
      api.target,
    )
    await ui.select("Refresh")
    await ui.frame("Retry the exact decision")
    expect(api.state.calls.filter((call) => call.method === "POST")).toHaveLength(1)
    api.state.controlOutcome = "ok"
    await ui.select("Retry the exact decision")
    await ui.frame("Decision submitted")
    expect(api.state.calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
      first.body,
      first.body,
    ])
    expect(api.state.item.state).toBe("paused")
    expect(api.state.calls.every((call) => call.auth === controlHeaders.Authorization)).toBe(true)
  })
}

test("an advertised stopped Goal opens the original plan dialog and returns with a new view under its original SDK owner", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  const goal = goalControls(api.state.item)
  api.state.item = {
    ...goal,
    state: "stopped",
    allowedActions: ["goal_edit"],
    source: { goal: { ...goal.source.goal!, phase: "stopped" } },
  }
  api.state.requiredAuth = controlHeaders.Authorization
  using ui = await mountIM(tmp.path, api.url, () => <DialogAttention />, 80, undefined, { headers: controlHeaders })
  ui.app.renderer.resize(80, 24)
  await ui.frame("Goal controls")
  await ui.select("Goal controls")
  await ui.select("Edit goal plan")
  await ui.frame("Confirm this decision")
  await ui.select("Confirm this decision")
  await ui.frame("Prepare edit")
  expect(api.state.calls.filter((call) => call.method === "POST")).toHaveLength(0)
  ui.app.mockInput.pressArrow("down")
  ui.app.mockInput.pressEnter()
  await ui.frame("Goal controls")
  await ui.select("Goal controls")
  await ui.frame("Edit goal plan")
  expect(ui.app.captureCharFrame()).not.toContain("Resume goal")
  expect(api.state.calls.filter((call) => call.path === "/api/attention/capability").length).toBeGreaterThanOrEqual(2)
  expect(api.state.calls.filter((call) => call.method === "POST")).toHaveLength(0)
})

test("fresh Task revision rejects before dispatch and disposed Basic owner cannot change a new owner's reason view", async () => {
  await using tmp = await tmpdir()
  using api = fixture(tmp.path)
  api.state.item = taskControls(api.state.item)
  api.state.requiredAuth = controlHeaders.Authorization
  const first = await mountIM(tmp.path, api.url, () => <DialogAttention />, 80, undefined, { headers: controlHeaders })
  const release = Promise.withResolvers<void>()
  try {
    first.app.renderer.resize(80, 24)
    await first.frame("Task controls")
    await first.select("Task controls")
    await first.select("Request task closure")
    await first.frame("Reason for this task decision")
    await first.type("Review original", true)
    first.app.mockInput.pressEnter()
    await first.frame("Confirm this decision")
    api.state.item = { ...api.state.item, revision: "c".repeat(64) }
    await first.select("Confirm this decision")
    await first.frame("The source or authority changed")
    expect(api.state.calls.filter((call) => call.method === "POST")).toHaveLength(0)
    await first.select("Back")
    await first.select("Refresh")
    await first.frame("Request task closure")
    await first.select("Request task closure")
    await first.frame("Reason for this task decision")
    await first.type("Pending original owner", true)
    first.app.mockInput.pressEnter()
    await first.frame("Confirm this decision")
    api.state.controlHold = release.promise
    await first.select("Confirm this decision")
    await until(() => api.state.calls.some((call) => call.method === "POST"), "actual admitted command")
    first.app.renderer.destroy()
    using second = await mountIM(tmp.path, api.url, () => <DialogAttention />, 80, undefined, {
      headers: controlHeaders,
    })
    second.app.renderer.resize(80, 24)
    await second.frame("Task controls")
    await second.select("Task controls")
    await second.select("Request task closure")
    await second.frame("Reason for this task decision")
    await second.type("New owner reason", true)
    release.resolve()
    await second.app.renderOnce()
    expect(second.app.captureCharFrame()).toContain("New owner reason")
    expect(second.app.captureCharFrame()).not.toContain("Decision submitted")
    expect(api.state.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  } finally {
    release.resolve()
    if (!first.app.renderer.isDestroyed) first.app.renderer.destroy()
  }
})
