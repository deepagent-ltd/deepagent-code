import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { GoalStatusBar } from "@/components/deepagent/goal-status-bar"
import { GoalStartButton } from "@/components/deepagent/goal-start-button"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import type { SessionGoal } from "@/context/global-sync/types"
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
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn(), close: vi.fn() }) }))
vi.mock("@/components/deepagent/goal-plan-edit-dialog", () => ({ GoalPlanEditDialog: () => null }))
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
  cleanup()
  vi.useRealTimers()
})


for (const kind of ["start", "control"] as const) it(`${kind} admission bounds unknown original commands and exact retry releases one slot`, async () => {
  const held = [] as { f: ReturnType<typeof setup>; sdk: object; sync: object }[]
  const mount = (f: ReturnType<typeof setup>) => render(() => kind === "start" ? <GoalStartButton sessionID={f.first} /> : <GoalStatusBar sessionID={f.first} />)
  const action = () => screen.getByRole("button", { name: dict[kind === "start" ? "goal.start.button" : "composer.goal.pause"] })
  for (let i = 0; i < 32; i++) {
    const f = setup(kind === "start" ? null : snapshot())
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation((input) => input.method === "POST" ? Promise.reject(new TypeError("lost")) : original(input))
    held.push({ f, sdk: wiring.sdk, sync: wiring.sync })
    const view = mount(f)
    await waitFor(() => expect(action()).toBeTruthy())
    fireEvent.click(action())
    await screen.findByRole("button", { name: dict["goal.control.retry"] })
    expect(postCalls(f.request)).toHaveLength(1)
    view.unmount()
  }
  const blocked = setup(kind === "start" ? null : snapshot())
  const owner = { sdk: wiring.sdk, sync: wiring.sync }
  const view = mount(blocked)
  await waitFor(() => expect(action()).toBeTruthy())
  fireEvent.click(action())
  await screen.findByText(dict["eventValidation.capacity"])
  expect(postCalls(blocked.request)).toHaveLength(0)
  view.unmount()
  const first = held[0]!
  wiring.sdk = first.sdk
  wiring.sync = first.sync
  first.f.request.mockResolvedValue({ error: { code: "forbidden", message: "Later access denied" }, response: { status: 403 } })
  const denied = mount(first.f)
  fireEvent.click(await screen.findByRole("button", { name: dict["goal.control.retry"] }))
  await screen.findByText("Later access denied")
  expect(postCalls(first.f.request)).toHaveLength(2)
  expect(screen.getByRole("button", { name: dict["goal.control.retry"] })).toBeTruthy()
  denied.unmount()
  wiring.sdk = owner.sdk
  wiring.sync = owner.sync
  const stillFull = mount(blocked)
  await waitFor(() => expect(action()).toBeTruthy())
  fireEvent.click(action())
  await screen.findByText(dict["eventValidation.capacity"])
  expect(postCalls(blocked.request)).toHaveLength(0)
  stillFull.unmount()
  wiring.sdk = first.sdk
  wiring.sync = first.sync
  first.f.request.mockResolvedValue(success(snapshot({ revision: 2, phase: "paused", requestedPhase: "paused" })))
  const retry = mount(first.f)
  fireEvent.click(await screen.findByRole("button", { name: dict["goal.control.retry"] }))
  await waitFor(() => expect(first.f.set).toHaveBeenCalledTimes(1))
  expect(postCalls(first.f.request)).toHaveLength(3)
  expect(postCalls(first.f.request)[1]).toEqual(postCalls(first.f.request)[0])
  expect(postCalls(first.f.request)[2]).toEqual(postCalls(first.f.request)[0])
  retry.unmount()
  wiring.sdk = owner.sdk
  wiring.sync = owner.sync
  mount(blocked)
  await waitFor(() => expect(action()).toBeTruthy())
  fireEvent.click(action())
  await waitFor(() => expect(postCalls(blocked.request)).toHaveLength(1))
})
