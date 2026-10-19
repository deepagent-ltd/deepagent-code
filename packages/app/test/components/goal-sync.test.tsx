import { afterEach, expect, it, vi } from "vitest"
import { createRoot } from "solid-js"
import { createServerSyncContextInner } from "@/context/server-sync"
import type { ServerSDK } from "@/context/server-sdk"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
// Isolate unrelated bootstrap traffic, not the production Goal state writer or request logic.
vi.mock("@tanstack/solid-query", () => ({
  queryOptions: (value: unknown) => value,
  useQueries: () => [{}, {}, {}],
  useQuery: () => ({}),
  useMutation: () => ({}),
  useQueryClient: () => ({}),
}))
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
const record = (control: GoalClient.Snapshot) => ({
  goalId: control.goalId,
  planDocId: control.planDocId,
  phase: control.phase,
  control,
  ledger: { ticks: 1, tokens: 10, cost: 0, wallclockMs: 20 },
  stallCount: 0,
  gaps: [],
})
const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})
function context(server = "server-a") {
  const requests = vi.fn().mockResolvedValue({ data: { goal: snapshot() } })
  const clients: string[] = []
  const sdk = {
    scope: server,
    client: {},
    event: { listen: () => () => {}, start: async () => {} },
    createClient: ({ directory }: { directory: string }) => {
      clients.push(directory)
      return { client: { request: requests } }
    },
  } as unknown as ServerSDK
  const sync = createRoot((dispose) => {
    disposers.push(dispose)
    return createServerSyncContextInner(sdk)
  })
  return { sync, requests, clients }
}

it("production app state preserves status authority when a legacy terminal or different-Goal hint arrives", () => {
  const f = context()
  const value = record(snapshot({ revision: 5, inFlight: true, requestedPhase: "stopped", phase: "stopped" }))
  f.sync.goal.set("session", value, { source: "status" })
  f.sync.goal.set(
    "session",
    { ...value, control: undefined, phase: "unknown", ledger: { ...value.ledger, tokens: 88 } },
    { source: "event" },
  )
  expect(f.sync.data.session_goal.session.control?.revision).toBe(5)
  expect(f.sync.data.session_goal.session.control?.inFlight).toBe(true)
  expect(f.sync.data.session_goal.session.ledger?.tokens).toBe(88)
  f.sync.goal.set("session", { ...value, goalId: "other", control: undefined }, { source: "event" })
  expect(f.sync.data.session_goal.session.goalId).toBe("goal-a")
  expect(f.requests).not.toHaveBeenCalled()
})

it("actual scoped GETs coalesce to one active and one queued read", async () => {
  const f = context()
  const response = Promise.withResolvers<{ data: { goal: GoalClient.Snapshot } }>()
  f.requests.mockReturnValueOnce(response.promise)
  const pending = f.sync.goal.sync("/project-a", "session")
  for (let i = 0; i < 20; i++) expect(f.sync.goal.sync("/project-a", "session")).toBe(pending)
  expect(f.requests).toHaveBeenCalledTimes(1)
  response.resolve({ data: { goal: snapshot() } })
  await pending
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.requests).toHaveBeenCalledTimes(2)
  expect(f.clients).toEqual(["/project-a"])
  expect(f.sync.data.session_goal.session.control?.revision).toBe(1)
})

it("a late GET cannot erase a newer control write or replace its Goal", async () => {
  const f = context()
  f.sync.goal.set("session", record(snapshot()), { source: "status" })
  const response = Promise.withResolvers<{ data: { goal: null } }>()
  f.requests.mockReturnValueOnce(response.promise)
  const pending = f.sync.goal.sync("/project-a", "session")
  f.sync.goal.set("session", record(snapshot({ goalId: "successor" })), { source: "status" })
  response.resolve({ data: { goal: null } })
  await pending
  expect(f.sync.data.session_goal.session.goalId).toBe("successor")
})

it("different server contexts stay isolated and disposed reads cannot repopulate state", async () => {
  const a = context("server-a")
  const b = context("server-b")
  a.requests.mockResolvedValue({ data: { goal: snapshot({ goalId: "from-a" }) } })
  b.requests.mockResolvedValue({ data: { goal: snapshot({ goalId: "from-b" }) } })
  await Promise.all([
    a.sync.goal.sync("/directory-a", "same-session"),
    b.sync.goal.sync("/directory-b", "same-session"),
  ])
  expect(a.sync.data.session_goal["same-session"].goalId).toBe("from-a")
  expect(b.sync.data.session_goal["same-session"].goalId).toBe("from-b")
  const response = Promise.withResolvers<{ data: { goal: GoalClient.Snapshot } }>()
  a.requests.mockReturnValueOnce(response.promise)
  const pending = a.sync.goal.sync("/directory-a", "same-session")
  disposers[0]()
  response.resolve({ data: { goal: snapshot({ goalId: "late" }) } })
  await pending
  expect(a.sync.data.session_goal["same-session"].goalId).toBe("from-a")
})
