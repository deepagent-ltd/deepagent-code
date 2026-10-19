import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { TaskProgressDetails, TaskProgressPopover } from "@/pages/session/task-progress"
import { dict } from "@/i18n/en"
import type { SessionPlan } from "@/context/global-sync/types"

const runtime = vi.hoisted(() => ({
  client: { session: { taskSummary: vi.fn() } },
  select: vi.fn(),
  open: vi.fn(),
  hide: vi.fn(),
  sessionID: (): string | undefined => "parent",
  scope: (): string => "local",
  serverSync: (): unknown => ({ data: { session_plan: {} } }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? key }) }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    client: runtime.client,
    get scope() {
      return runtime.scope()
    },
    directory: "/owned",
  }),
}))
vi.mock("@/context/server-sync", () => ({ useServerSync: () => runtime.serverSync() }))
vi.mock("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: {
      get id() {
        return runtime.sessionID()
      },
    },
    view: () => ({
      workPanel: { taskID: () => "child", selectTask: runtime.select, open: runtime.open, hide: runtime.hide },
    }),
  }),
}))

const item = {
  childSessionID: "child",
  title: "Readonly task",
  agent: "worker",
  state: "unknown",
  runID: null,
  generation: null,
  controlState: null,
  createdAt: 1,
  updatedAt: 2,
  settledAt: null,
  progress: { messageID: "visible", text: "Visible progress", tool: null },
  result: { state: "available", text: "Visible result", messageID: "result", truncated: false },
  notification: { state: "not_established", updatedAt: null, deliveredAt: null },
}
beforeEach(() => {
  vi.clearAllMocks()
  runtime.sessionID = () => "parent"
  runtime.scope = () => "local"
  runtime.serverSync = () => ({ data: { session_plan: {} } })
  runtime.client.session.taskSummary.mockResolvedValue({
    data: { parentSessionID: "parent", observedAt: 3, items: [item], hasMore: true, nextCursor: "next" },
  })
})
afterEach(cleanup)

it("does not display a task trigger or read tasks before a Session exists", () => {
  runtime.sessionID = () => undefined
  render(() => <TaskProgressPopover />)
  expect(screen.queryByRole("button", { name: dict["workPanel.tasks"] })).toBeNull()
  expect(runtime.client.session.taskSummary).not.toHaveBeenCalled()
})

it("opens the task summary on demand and selects readonly details without a child Session navigation", async () => {
  render(() => <TaskProgressPopover />)
  expect(runtime.client.session.taskSummary).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: dict["workPanel.tasks"] }))
  await screen.findByText("Readonly task")
  expect(screen.getByText(`${dict["workPanel.result"]}: ${dict["workPanel.resultState.available"]}`)).toBeTruthy()
  expect(screen.queryByText(dict["workPanel.taskState.completed"])).toBeNull()
  expect(screen.getByText(dict["workPanel.tasksPartial"])).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: /Readonly task/ }))
  expect(runtime.select).toHaveBeenCalledWith("child")
  expect(runtime.open).toHaveBeenCalledWith("subagents")
  expect(screen.queryByText("Readonly task")).toBeNull()
})

it("keeps result availability, task state and notification separate and exposes no task mutation", async () => {
  render(() => <TaskProgressDetails />)
  await screen.findByText("Visible result")
  expect(screen.getByText("Visible progress")).toBeTruthy()
  expect(screen.getByText(dict["workPanel.taskState.unknown"])).toBeTruthy()
  expect(
    screen.getByText(`${dict["workPanel.notification"]}: ${dict["workPanel.notificationState.not_established"]}`),
  ).toBeTruthy()
  expect(screen.queryByRole("button", { name: /stop|cancel|rollback|resume|takeover/i })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["workPanel.returnMain"] }))
  expect(runtime.hide).toHaveBeenCalledTimes(1)
})

it("rejects a response for a different parent rather than displaying another task", async () => {
  runtime.client.session.taskSummary.mockResolvedValue({
    data: { parentSessionID: "other-parent", observedAt: 3, items: [item], hasMore: false, nextCursor: null },
  })
  render(() => <TaskProgressDetails />)
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe(dict["common.requestFailed"]))
  expect(screen.queryByText("Visible result")).toBeNull()
})

it("shares one readonly observer across the popover and details until the last view leaves", async () => {
  const intervals = vi.spyOn(globalThis, "setInterval")
  const details = render(() => <TaskProgressDetails />)
  await screen.findByText("Visible result")
  const popover = render(() => <TaskProgressPopover />)
  fireEvent.click(screen.getByRole("button", { name: dict["workPanel.tasks"] }))
  await waitFor(() => expect(screen.getAllByText("Readonly task")).toHaveLength(3))
  expect(runtime.client.session.taskSummary).toHaveBeenCalledTimes(1)
  expect(intervals.mock.calls.filter((call) => call[1] === 5_000)).toHaveLength(1)
  const signal = runtime.client.session.taskSummary.mock.calls[0][1].signal as AbortSignal
  popover.unmount()
  expect(signal.aborted).toBe(false)
  details.unmount()
  expect(signal.aborted).toBe(true)
  const fresh = render(() => <TaskProgressDetails />)
  await screen.findByText("Visible result")
  expect(runtime.client.session.taskSummary).toHaveBeenCalledTimes(2)
  fresh.unmount()
  intervals.mockRestore()
})

it("has not read tasks while hidden, then shows empty only after a current successful read", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  runtime.client.session.taskSummary.mockResolvedValue({
    data: { parentSessionID: "parent", observedAt: 3, items: [], hasMore: false, nextCursor: null },
  })
  render(() => <TaskProgressPopover />)
  fireEvent.click(screen.getByRole("button", { name: dict["workPanel.tasks"] }))
  expect(screen.getByText(dict["workPanel.tasksPending" as keyof typeof dict] ?? "workPanel.tasksPending")).toBeTruthy()
  expect(screen.queryByText(dict["workPanel.tasksEmpty"])).toBeNull()
  expect(runtime.client.session.taskSummary).not.toHaveBeenCalled()
  visibility.mockReturnValue("visible")
  document.dispatchEvent(new Event("visibilitychange"))
  await screen.findByText(dict["workPanel.tasksEmpty"])
  expect(runtime.client.session.taskSummary).toHaveBeenCalledTimes(1)
  expect(screen.queryByText(dict["workPanel.tasksPending" as keyof typeof dict] ?? "workPanel.tasksPending")).toBeNull()
  visibility.mockRestore()
})

it("shows a final result once when the last progress text is the same result", async () => {
  runtime.client.session.taskSummary.mockResolvedValue({
    data: {
      parentSessionID: "parent",
      observedAt: 3,
      items: [{ ...item, progress: { ...item.progress, text: item.result.text } }],
      hasMore: false,
      nextCursor: null,
    },
  })
  render(() => <TaskProgressDetails />)
  await screen.findByText("Visible result")
  expect(screen.getAllByText("Visible result")).toHaveLength(1)
  const details = screen.getByText("Visible result").closest("section")
  if (!details) throw new Error("The readonly task result section did not render")
  expect(within(details).getByText(`${dict["workPanel.result"]}: ${dict["workPanel.resultState.available"]}`)).toBeTruthy()
})

it("separates the current plan from subtasks and leaves no old plan after close or scope change", async () => {
  const [current, setCurrent] = createStore<{ sessionID: string; scope: string; plans: Record<string, SessionPlan> }>({
    sessionID: "parent",
    scope: "local",
    plans: {
      parent: {
        plan_id: "original-plan",
        plan_version: 1,
        goal: "Review own code and deliver",
        assumptions: [],
        active_step_id: "3",
        steps: ["Inspect", "Design", "Implement", "Verify", "Deliver"].map((title, index) => ({
          step_id: String(index + 1),
          title,
          status: index < 2 ? "done" : index === 2 ? "active" : "pending",
        })),
        done: 2,
        total: 5,
      },
    },
  })
  runtime.sessionID = () => current.sessionID
  runtime.scope = () => current.scope
  runtime.serverSync = () => ({
    data: {
      get session_plan() {
        return current.plans
      },
    },
  })
  runtime.client.session.taskSummary.mockImplementation(async ({ sessionID }: { sessionID: string }) => ({
    data: { parentSessionID: sessionID, observedAt: 3, items: [], hasMore: false, nextCursor: null },
  }))
  const intervals = vi.spyOn(globalThis, "setInterval")
  const result = render(() => <TaskProgressPopover />)
  expect(runtime.client.session.taskSummary).not.toHaveBeenCalled()
  const trigger = screen.getByRole("button", { name: dict["workPanel.tasks"] })
  expect(trigger.classList.contains("size-6")).toBe(true)
  expect(trigger.classList.contains("rounded-md")).toBe(true)
  expect(trigger.classList.contains("titlebar-icon")).toBe(false)
  expect(trigger.classList.contains("hidden")).toBe(false)
  fireEvent.click(trigger)
  await screen.findByText(dict["workPanel.tasksEmpty"])
  const plan = screen.getByRole("region", { name: dict["workPanel.currentPlan"] })
  const subtasks = screen.getByRole("region", { name: dict["workPanel.subtasks"] })
  expect(within(plan).getByText("2/5")).toBeDefined()
  expect(within(plan).getByText("Review own code and deliver")).toBeDefined()
  expect(within(plan).getAllByRole("listitem")).toHaveLength(5)
  expect(within(plan).getAllByText(dict["workPanel.taskState.completed"])).toHaveLength(2)
  expect(within(subtasks).getByText("0")).toBeDefined()
  expect(within(subtasks).getByText(dict["workPanel.tasksEmpty"])).toBeDefined()
  expect(within(plan).queryByRole("button")).toBeNull()
  expect(intervals.mock.calls.filter((call) => call[1] === 5_000)).toHaveLength(1)
  const originalSignal = runtime.client.session.taskSummary.mock.calls[0][1].signal as AbortSignal
  fireEvent.click(trigger)
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"))
  expect(originalSignal.aborted).toBe(true)
  fireEvent.click(trigger)
  await screen.findByText("Review own code and deliver")
  setCurrent("sessionID", "other-session")
  await screen.findByText(dict["workPanel.planEmpty"])
  await waitFor(() =>
    expect(runtime.client.session.taskSummary).toHaveBeenLastCalledWith(
      { sessionID: "other-session" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  )
  expect(screen.queryByText("Inspect")).toBeNull()
  expect(screen.queryByText("2/5")).toBeNull()
  batch(() => {
    setCurrent("scope", "other-server")
    setCurrent("sessionID", "parent")
    setCurrent("plans", reconcile({}))
  })
  await screen.findByText(dict["workPanel.planEmpty"])
  expect(screen.queryByText("Review own code and deliver")).toBeNull()
  result.unmount()
  expect(runtime.client.session.taskSummary.mock.calls.every((call) => call[1].signal.aborted)).toBe(true)
  intervals.mockRestore()
})
