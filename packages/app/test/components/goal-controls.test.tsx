import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { GoalStatusBar } from "@/components/deepagent/goal-status-bar"
import { GoalStartButton } from "@/components/deepagent/goal-start-button"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import { sessionGoalFromStatus, type SessionGoal } from "@/context/global-sync/types"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({ sdk: {} as object, sync: {} as object, toast: vi.fn() }))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/server-sync", () => ({ useServerSync: () => wiring.sync }))
vi.mock("@/context/local", () => ({ useLocal: () => ({ agent: { current: () => ({ name: "loop" }) } }) }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))
let goalDialog: ReturnType<typeof render> | undefined
vi.mock("@deepagent-code/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (content: () => unknown) => {
      goalDialog?.unmount()
      goalDialog = render(content as () => import("solid-js").JSX.Element)
    },
    close: () => {
      goalDialog?.unmount()
      goalDialog = undefined
    },
  }),
}))
vi.mock("@deepagent-code/ui/v2/dialog-v2", () => ({
  Dialog: (props: { children: import("solid-js").JSX.Element }) => <section>{props.children}</section>,
  DialogFooter: (props: { children: import("solid-js").JSX.Element }) => <footer>{props.children}</footer>,
}))
vi.mock("@/components/deepagent/goal-plan-edit-dialog", () => ({
  GoalPlanEditDialog: (props: { onClose: () => void }) => (
    <button aria-label="close-goal-plan-editor" onClick={props.onClose}>
      Close
    </button>
  ),
}))
vi.mock("@/utils/toast", () => ({ showToast: (...args: unknown[]) => wiring.toast(...args) }))

const snapshot = (patch: Partial<GoalClient.Snapshot> = {}): GoalClient.Snapshot => ({
  goalId: "goal-a",
  planDocId: "plan-a",
  phase: "running",
  running: true,
  revision: 1,
  requestedPhase: "running",
  preparation: "ready",
  inFlight: false,
  recoveryRequired: false,
  wakeState: "published",
  replayed: false,
  ...patch,
})
const record = (control: GoalClient.Snapshot): SessionGoal => ({
  goalId: control.goalId,
  planDocId: control.planDocId,
  phase: control.phase,
  control,
  ledger: { ticks: 2, tokens: 30, cost: 0, wallclockMs: 10 },
  stallCount: 0,
  gaps: [],
})
const success = (data: unknown) => ({ data, response: { status: 200 } })
let sequence = 0
function setup(initial: GoalClient.Snapshot | null = snapshot()) {
  const [target, setTarget] = createStore({
    sessionID: `session-${++sequence}`,
    server: "http://server-a",
    serverScope: "connection-a",
    directory: "/project-a",
  })
  const first = target.sessionID
  const [data, setData] = createStore<{
    session_goal: Record<string, SessionGoal | undefined>
    session_plan: Record<string, { steps: [] }>
  }>({
    session_goal: initial ? { [first]: record(initial) } : {},
    session_plan: {},
  })
  const request = vi.fn().mockImplementation((input: { method: string; url: string }) => {
    if (input.url === "/global/capabilities") return Promise.resolve(success({ features: { goalLoop: true } }))
    if (input.url.startsWith("/deepagent/goal/startable")) return Promise.resolve(success({ startable: true }))
    return Promise.resolve(success(snapshot()))
  })
  const client = { client: { request } }
  const sync = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn((sid: string, value?: SessionGoal) => setData("session_goal", sid, value))
  wiring.sdk = {
    get client() {
      return client
    },
    get scope() {
      return target.serverScope
    },
    get url() {
      return target.server
    },
    get directory() {
      return target.directory
    },
  }
  wiring.sync = { data, goal: { sync, set } }
  return { target, setTarget, data, setData, client, request, sync, set, first }
}
const postCalls = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls.map(([value]) => value).filter((value) => value.method === "POST")
beforeEach(() => wiring.toast.mockReset())
afterEach(() => {
  goalDialog?.unmount()
  goalDialog = undefined
  cleanup()
  vi.useRealTimers()
})

it("stop acknowledgement with inFlight stays explicitly unconfirmed and never exposes dismiss/resume", async () => {
  const f = setup()
  f.request.mockResolvedValue(
    success(snapshot({ revision: 2, phase: "stopped", requestedPhase: "stopped", inFlight: true })),
  )
  render(() => <GoalStatusBar sessionID={f.target.sessionID} />)
  fireEvent.click(screen.getByRole("button", { name: dict["composer.goal.stop"] }))
  await screen.findByText(dict["goal.control.stopRequested"])
  const body = postCalls(f.request)[0].body
  expect(body).toMatchObject({ sessionID: f.first, goalId: "goal-a", expectedRevision: 1 })
  expect(body.requestID).toBeTruthy()
  expect(screen.queryByRole("button", { name: dict["composer.goal.dismiss"] })).toBeNull()
  expect(screen.queryByRole("button", { name: dict["composer.goal.editPlan"] })).toBeNull()
  expect(screen.queryByRole("button", { name: dict["composer.goal.resume"] })).toBeNull()
})

it("paused recovery is explicitly unconfirmed and revision-zero controls remain read-only", async () => {
  const f = setup(
    snapshot({
      revision: 0,
      phase: "paused",
      requestedPhase: "paused",
      recoveryRequired: true,
      preparation: "recovery_required",
    }),
  )
  render(() => <GoalStatusBar sessionID={f.first} />)
  expect(screen.getByText(dict["goal.control.pausedUnconfirmed"])).toBeTruthy()
  expect(screen.queryByText(dict["goal.control.recovery"])).toBeNull()
  expect(screen.queryByRole("button", { name: dict["composer.goal.resume"] })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["goal.control.refresh"] }))
  await waitFor(() => expect(f.sync).toHaveBeenCalled())
  expect(postCalls(f.request)).toHaveLength(0)
  f.setData("session_goal", f.first, record(snapshot({ requestedPhase: "running", recoveryRequired: true })))
  expect(screen.getByText(dict["goal.control.recovery"])).toBeTruthy()
  expect(screen.queryByText(dict["goal.control.pausedUnconfirmed"])).toBeNull()
})

it("old control acknowledgement cannot change a new session/server/directory target", async () => {
  const f = setup()
  const response = Promise.withResolvers<ReturnType<typeof success>>()
  f.request.mockReturnValue(response.promise)
  render(() => <GoalStatusBar sessionID={f.target.sessionID} />)
  fireEvent.click(screen.getByRole("button", { name: dict["composer.goal.pause"] }))
  f.setData("session_goal", "session-new", record(snapshot({ goalId: "goal-new", revision: 8 })))
  f.setTarget({ sessionID: "session-new", server: "http://server-b", directory: "/project-b" })
  response.resolve(success(snapshot({ revision: 2, phase: "paused", requestedPhase: "paused" })))
  await waitFor(() =>
    expect(screen.getByRole("button", { name: dict["composer.goal.pause"] }).hasAttribute("disabled")).toBe(false),
  )
  expect(f.data.session_goal["session-new"]?.control?.revision).toBe(8)
  expect(f.set).not.toHaveBeenCalled()
})

it("newer same-Goal status cannot regress when an old successful command returns", async () => {
  const f = setup()
  const response = Promise.withResolvers<ReturnType<typeof success>>()
  f.request.mockReturnValue(response.promise)
  render(() => <GoalStatusBar sessionID={f.first} />)
  fireEvent.click(screen.getByRole("button", { name: dict["composer.goal.pause"] }))
  f.setData(
    "session_goal",
    f.first,
    record(snapshot({ revision: 4, phase: "stopped", requestedPhase: "stopped", inFlight: true })),
  )
  response.resolve(success(snapshot({ revision: 2, phase: "paused", requestedPhase: "paused" })))
  await screen.findByText(dict["goal.control.stopRequested"])
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.data.session_goal[f.first]?.control?.revision).toBe(4)
  expect(f.set).not.toHaveBeenCalled()
})

it("409 refreshes only and never reapplies the action to a newer Goal", async () => {
  const f = setup()
  const response = Promise.withResolvers<object>()
  f.request.mockReturnValue(response.promise)
  render(() => <GoalStatusBar sessionID={f.first} />)
  fireEvent.click(screen.getByRole("button", { name: dict["composer.goal.pause"] }))
  f.sync.mockImplementation(() => {
    f.setData("session_goal", f.first, record(snapshot({ goalId: "new-goal", revision: 7 })))
    return Promise.resolve()
  })
  response.resolve({ error: { code: "revision_conflict", message: "Revision conflict" }, response: { status: 409 } })
  await waitFor(() => expect(f.data.session_goal[f.first]?.goalId).toBe("new-goal"))
  expect(postCalls(f.request)).toHaveLength(1)
  expect(screen.queryByRole("button", { name: dict["goal.control.retry"] })).toBeNull()
})

it("unknown acknowledgement only retries the original request after an explicit click, including remount", async () => {
  const f = setup()
  f.request
    .mockRejectedValueOnce(new TypeError("network dropped"))
    .mockResolvedValue(success(snapshot({ revision: 2, phase: "paused", requestedPhase: "paused" })))
  const first = render(() => <GoalStatusBar sessionID={f.first} />)
  fireEvent.click(screen.getByRole("button", { name: dict["composer.goal.pause"] }))
  await screen.findByRole("button", { name: dict["goal.control.retry"] })
  expect(postCalls(f.request)).toHaveLength(1)
  first.unmount()
  render(() => <GoalStatusBar sessionID={f.first} />)
  fireEvent.click(await screen.findByRole("button", { name: dict["goal.control.retry"] }))
  await screen.findByRole("button", { name: dict["composer.goal.resume"] })
  expect(postCalls(f.request)).toHaveLength(2)
  expect(postCalls(f.request)[1]).toEqual(postCalls(f.request)[0])
})

it("unmounted control callback never writes or refreshes the disposed UI", async () => {
  const f = setup()
  const response = Promise.withResolvers<ReturnType<typeof success>>()
  f.request.mockReturnValue(response.promise)
  const view = render(() => <GoalStatusBar sessionID={f.first} />)
  fireEvent.click(screen.getByRole("button", { name: dict["composer.goal.pause"] }))
  view.unmount()
  response.resolve(success(snapshot({ revision: 2 })))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.set).not.toHaveBeenCalled()
  expect(f.sync).toHaveBeenCalledTimes(1)
})

it("start unknown has an explicit same-request retry and retains its exact target", async () => {
  const f = setup(null)
  const original = f.request.getMockImplementation()!
  let posts = 0
  f.request.mockImplementation((input) =>
    input.method !== "POST"
      ? original(input)
      : ++posts === 1
        ? Promise.reject(new Error("lost"))
        : Promise.resolve(success(snapshot())),
  )
  render(() => <GoalStartButton sessionID={f.first} />)
  fireEvent.click(await screen.findByRole("button", { name: dict["goal.start.button"] }))
  fireEvent.click(screen.getAllByRole("button", { name: dict["goal.start.button"] }).at(-1)!)
  fireEvent.click(await screen.findByRole("button", { name: dict["goal.control.retry"] }))
  await waitFor(() => expect(f.set).toHaveBeenCalledTimes(1))
  expect(postCalls(f.request)).toHaveLength(2)
  expect(postCalls(f.request)[1]).toEqual(postCalls(f.request)[0])
  expect(postCalls(f.request)[0].body.requestID).toBeTruthy()
})

it("old start callback does not install its Goal or success toast in a new target", async () => {
  const f = setup(null)
  const original = f.request.getMockImplementation()!
  const response = Promise.withResolvers<ReturnType<typeof success>>()
  f.request.mockImplementation((input) => (input.method !== "POST" ? original(input) : response.promise))
  render(() => <GoalStartButton sessionID={f.target.sessionID} />)
  fireEvent.click(await screen.findByRole("button", { name: dict["goal.start.button"] }))
  fireEvent.click(screen.getAllByRole("button", { name: dict["goal.start.button"] }).at(-1)!)
  f.setTarget({ sessionID: "other-session", server: "http://other-server", directory: "/other-directory" })
  response.resolve(success(snapshot()))
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: dict["goal.start.button"] })[0].hasAttribute("disabled")).toBe(false),
  )
  expect(f.set).not.toHaveBeenCalled()
  expect(wiring.toast).not.toHaveBeenCalled()
})

it("switching connection identity at the same URL fences the old callback", async () => {
  const f = setup()
  const response = Promise.withResolvers<ReturnType<typeof success>>()
  f.request.mockReturnValue(response.promise)
  render(() => <GoalStatusBar sessionID={f.first} />)
  fireEvent.click(screen.getByRole("button", { name: dict["composer.goal.pause"] }))
  f.setTarget("serverScope", "different-connection")
  response.resolve(success(snapshot({ revision: 2, phase: "paused", requestedPhase: "paused" })))
  await waitFor(() =>
    expect(screen.getByRole("button", { name: dict["composer.goal.pause"] }).hasAttribute("disabled")).toBe(false),
  )
  expect(f.set).not.toHaveBeenCalled()
})

it("an initial failed status read is retried read-only, then an authoritative null stops observation", async () => {
  vi.useFakeTimers()
  const f = setup(null)
  f.sync.mockRejectedValueOnce(new Error("temporarily offline"))
  const view = render(() => <GoalStatusBar sessionID={f.first} />)
  await vi.advanceTimersByTimeAsync(5000)
  expect(f.sync).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(15000)
  expect(f.sync).toHaveBeenCalledTimes(2)
  expect(postCalls(f.request)).toHaveLength(0)
  view.unmount()
})

it("start form captures only selected acceptance criteria and owned code references", async () => {
  const f = setup(null)
  render(() => <GoalStartButton sessionID={f.first} />)
  fireEvent.click(await screen.findByRole("button", { name: dict["goal.start.button"] }))
  fireEvent.change(screen.getByRole("combobox", { name: dict["goal.start.form.source"] }), {
    target: { value: "workspace-file" },
  })
  fireEvent.change(screen.getByRole("combobox", { name: dict["goal.start.form.criteria"] }), {
    target: { value: "custom" },
  })
  fireEvent.input(screen.getByRole("textbox", { name: dict["goal.start.form.commands"] }), {
    target: { value: "bun test affected.test.ts" },
  })
  fireEvent.input(screen.getByRole("textbox", { name: dict["goal.start.form.codeRefs"] }), {
    target: { value: "src/affected.ts:12" },
  })
  expect(postCalls(f.request)).toHaveLength(0)
  fireEvent.click(screen.getAllByRole("button", { name: dict["goal.start.button"] }).at(-1)!)
  await waitFor(() => expect(postCalls(f.request)).toHaveLength(1))
  expect(postCalls(f.request)[0].body).toMatchObject({
    planSource: "workspace-file",
    codeRefs: ["src/affected.ts:12"],
    criteria: [{ kind: "plan_complete" }, { kind: "tests_pass", commands: ["bun test affected.test.ts"] }],
  })
})

it("a Goal form never carries another conversation's acceptance draft into a new target", async () => {
  const f = setup(null)
  render(() => <GoalStartButton sessionID={f.target.sessionID} />)
  fireEvent.click(await screen.findByRole("button", { name: dict["goal.start.button"] }))
  fireEvent.change(screen.getByRole("combobox", { name: dict["goal.start.form.source"] }), {
    target: { value: "workspace-file" },
  })
  fireEvent.change(screen.getByRole("combobox", { name: dict["goal.start.form.criteria"] }), {
    target: { value: "custom" },
  })
  fireEvent.input(screen.getByRole("textbox", { name: dict["goal.start.form.commands"] }), {
    target: { value: "bun test project-a.test.ts" },
  })
  fireEvent.input(screen.getByRole("textbox", { name: dict["goal.start.form.codeRefs"] }), {
    target: { value: "src/project-a.ts:12" },
  })
  f.setTarget({ sessionID: "draft-new-session", server: "http://server-b", directory: "/project-b" })
  // The old dialog can only close, never start against the replacement placement.
  fireEvent.click(screen.getAllByRole("button", { name: dict["goal.start.button"] }).at(-1)!)
  expect(postCalls(f.request)).toHaveLength(0)
  fireEvent.click(await screen.findByRole("button", { name: dict["goal.start.button"] }))
  expect((screen.getByRole("combobox", { name: dict["goal.start.form.source"] }) as HTMLSelectElement).value).toBe(
    "session",
  )
  expect((screen.getByRole("combobox", { name: dict["goal.start.form.criteria"] }) as HTMLSelectElement).value).toBe(
    "default",
  )
  expect((screen.getByRole("textbox", { name: dict["goal.start.form.codeRefs"] }) as HTMLTextAreaElement).value).toBe("")
  expect(screen.queryByRole("textbox", { name: dict["goal.start.form.commands"] })).toBeNull()
  fireEvent.click(screen.getAllByRole("button", { name: dict["goal.start.button"] }).at(-1)!)
  await waitFor(() => expect(postCalls(f.request)).toHaveLength(1))
  expect(postCalls(f.request)[0].body).toMatchObject({ sessionID: "draft-new-session", codeRefs: [] })
  expect(postCalls(f.request)[0].body.criteria).toBeUndefined()
  expect(postCalls(f.request)[0].body.planSource).toBeUndefined()
})

it("closing plan edit refreshes a terminal Goal to paused without automatically resuming", async () => {
  const f = setup(
    snapshot({
      phase: "needs_human",
      requestedPhase: "needs_human",
      running: false,
    }),
  )
  render(() => <GoalStatusBar sessionID={f.first} />)
  await waitFor(() => expect(f.sync).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole("button", { name: dict["composer.goal.resume"] })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["composer.goal.editPlan"] }))
  f.sync.mockImplementation((directory: string, sessionID: string) => {
    expect(directory).toBe("/project-a")
    expect(sessionID).toBe(f.first)
    f.setData(
      "session_goal",
      f.first,
      record(
        snapshot({
          phase: "paused",
          requestedPhase: "paused",
          revision: 3,
          running: false,
        }),
      ),
    )
    return Promise.resolve()
  })
  fireEvent.click(screen.getByRole("button", { name: "close-goal-plan-editor" }))
  await screen.findByRole("button", { name: dict["composer.goal.resume"] })
  expect(f.sync).toHaveBeenCalledTimes(2)
  expect(postCalls(f.request)).toHaveLength(0)
})

it("closing an old plan editor never refreshes a replacement placement or Goal", async () => {
  const f = setup(
    snapshot({
      phase: "needs_human",
      requestedPhase: "needs_human",
      running: false,
    }),
  )
  render(() => <GoalStatusBar sessionID={f.target.sessionID} />)
  await waitFor(() => expect(f.sync).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole("button", { name: dict["composer.goal.editPlan"] }))
  f.setData("session_goal", "plan-edit-new-session", record(snapshot({ goalId: "goal-new", revision: 8 })))
  f.setTarget({
    sessionID: "plan-edit-new-session",
    server: "http://server-b",
    directory: "/project-b",
  })
  await waitFor(() => expect(f.sync).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByRole("button", { name: "close-goal-plan-editor" }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.sync).toHaveBeenCalledTimes(2)
  expect(f.data.session_goal["plan-edit-new-session"]?.control?.revision).toBe(8)
  expect(postCalls(f.request)).toHaveLength(0)
})

it("cold Goal progress restores durable statistics without manufacturing unsupported zero counters", () => {
  const progress = {
    ledger: { ticks: 1, tokens: 16483, cost: 0.125, wallclockMs: 14257 },
    stallCount: 2,
    gaps: ["confirmed historical gap"],
  }
  const loaded = sessionGoalFromStatus(undefined, snapshot({ progress }), 0)
  expect(loaded.ledger).toEqual(progress.ledger)
  expect(loaded.stallCount).toBe(2)
  expect(loaded.gaps).toEqual(progress.gaps)
  expect(loaded.control?.requestedPhase).toBe("running")
  const unsupported = sessionGoalFromStatus(undefined, snapshot(), 0)
  expect(unsupported.ledger).toBeUndefined()
  expect(unsupported.gaps).toEqual([])
  expect(unsupported.control).toEqual(snapshot())
})

it("a delayed Goal status keeps newer live counters and same-tick gaps without granting control", () => {
  const current = {
    ...record(snapshot()),
    ledger: { ticks: 3, tokens: 300, cost: 0.25, wallclockMs: 40 },
    stallCount: 3,
    gaps: ["new live gap"],
    eventHint: 2,
  }
  const progress = {
    ledger: { ticks: 2, tokens: 200, cost: 0.125, wallclockMs: 30 },
    stallCount: 1,
    gaps: ["old read gap"],
  }
  const slow = snapshot({ phase: "paused", requestedPhase: "paused", revision: 2, progress })
  expect(sessionGoalFromStatus(current, slow, 1)).toMatchObject({
    ledger: current.ledger,
    stallCount: 3,
    gaps: current.gaps,
    phase: "paused",
    control: slow,
  })
  const sameTick = snapshot({ progress: { ...progress, ledger: { ...progress.ledger, ticks: 3 } } })
  expect(sessionGoalFromStatus(current, sameTick, 1).gaps).toEqual(current.gaps)
  expect(sessionGoalFromStatus(current, sameTick, 2).gaps).toEqual(progress.gaps)
  expect(sessionGoalFromStatus(current, snapshot({ goalId: "goal-other" }), 1).ledger).toBeUndefined()
})

it("unknown Goal progress hides numeric counters while retaining the original control actions", async () => {
  const f = setup()
  f.setData("session_goal", f.first, sessionGoalFromStatus(undefined, snapshot(), 0))
  render(() => <GoalStatusBar sessionID={f.first} />)
  expect(document.querySelector('[data-component="goal-status-bar"]')?.textContent).not.toContain("tokens")
  expect(screen.getByRole("button", { name: dict["composer.goal.pause"] })).toBeTruthy()
  expect(postCalls(f.request)).toHaveLength(0)
  f.setData(
    "session_goal",
    f.first,
    sessionGoalFromStatus(
      undefined,
      snapshot({
        progress: { ledger: { ticks: 1, tokens: 16483, cost: 0, wallclockMs: 14257 }, stallCount: 0, gaps: [] },
      }),
      0,
    ),
  )
  await waitFor(() => expect(screen.getByText("1 tick \u00b7 16,483 tokens")).toBeTruthy())
  expect(postCalls(f.request)).toHaveLength(0)
})
