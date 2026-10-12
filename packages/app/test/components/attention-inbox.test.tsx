import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { DialogProvider } from "@deepagent-code/ui/context/dialog"
import { createOpencodeClient, type DeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { TaskHumanControlSchema } from "@deepagent-code/core/session/task-human-control.schema"
import type { GoalPlanClient } from "@deepagent-code/core/deepagent/goal-plan-client"
import type { Window } from "happy-dom"
import type { AttentionItem, AttentionList } from "@deepagent-code/sdk/client"
import { DialogAttention } from "@/components/dialog-attention"
import { dict } from "@/i18n/en"

const api = vi.hoisted(() => ({ capability: vi.fn(), list: vi.fn(), get: vi.fn(), seen: vi.fn(), sessionGet: vi.fn() }))
const connection = vi.hoisted(() => ({
  key: (): string => "server-a",
  client: undefined as DeepAgentCodeClient | undefined,
  scope: "server-a",
  url: "http://fixture-a",
}))
const planStore = vi.hoisted(() => ({ directory: "" }))
vi.mock("@/utils/goal-plan-draft", async () => {
  const sibling = "../../../tui/src/util/goal-plan-draft"
  const { createGoalPlanDraftStore } = (await import(/* @vite-ignore */ sibling)) as {
    createGoalPlanDraftStore(directory: string): GoalPlanClient.Store
  }
  return { createGoalPlanDraftStore: () => createGoalPlanDraftStore(planStore.directory) }
})
vi.mock("@/context/server-sdk", () => ({
  useServerSDK: () => {
    const client = { v2: { attention: api, session: { get: api.sessionGet } } }
    return {
      get client() {
        return connection.client ?? client
      },
      get scope() {
        return connection.scope
      },
      get url() {
        return connection.url
      },
    }
  },
}))
vi.mock("@/context/server", () => ({
  useServer: () => ({
    get key() {
      return connection.key()
    },
  }),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    intl: () => "en",
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))
vi.mock("@deepagent-code/ui/context/i18n", () => ({ useI18n: () => ({ t: () => "Close" }) }))

const item = (id = "recovery-1", patch: Partial<AttentionItem> = {}): AttentionItem => ({
  id,
  revision: "revision-1",
  kind: "execution_recovery",
  state: "recovery_required",
  reasonCode: "recovery_required",
  occurredAt: null,
  observedAt: 2000,
  session: {
    id: "session-remote",
    title: "Other project session",
    projectID: "project-remote",
    directory: "/projects/other",
    workspaceID: null,
  },
  source: { activityID: "activity-1" },
  seen: false,
  seenAt: null,
  ...patch,
})
const page = (data = [item()], nextCursor?: string): AttentionList => ({
  data,
  nextCursor,
  asOf: 2000,
  scope: "implicit-local",
  unseenCount: data.filter((entry) => !entry.seen).length,
})
const success = <T,>(data: T) => ({ data, response: { status: 200 } })
const open = (onOpenSession = vi.fn()) =>
  render(() => (
    <DialogProvider>
      <Dialog open>
        <DialogAttention onOpenSession={onOpenSession} />
      </Dialog>
    </DialogProvider>
  ))
const refresh = () => fireEvent.click(screen.getByRole("button", { name: dict["attention.refresh"] }))

beforeEach(() => {
  Object.values(api).forEach((method) => method.mockReset())
  connection.key = () => "server-a"
  connection.client = undefined
  connection.scope = "server-a"
  connection.url = "http://fixture-a"
  api.capability.mockResolvedValue(
    success({ enabled: true, scope: "implicit-local", actor: "server", reason: "enabled" }),
  )
  api.list.mockResolvedValue(success(page()))
  api.get.mockResolvedValue(success({ data: item() }))
  api.seen.mockResolvedValue(success({ data: item("recovery-1", { seen: true, seenAt: 3000 }) }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("renders real dialog controls and opens the server-provided cross-project session without marking viewed", async () => {
  const navigate = vi.fn()
  open(navigate)
  expect(await screen.findByRole("dialog", { name: dict["attention.title"] })).toBeTruthy()
  await screen.findByText("Other project session")
  expect(screen.getByText(dict["attention.timeUnknown"])).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: dict["attention.details"] }))
  await screen.findByText(dict["attention.reason.recovery_required"])
  expect(api.seen).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: dict["attention.openSession"] }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(item().session))
  expect(api.get).toHaveBeenCalledWith(
    { itemID: "recovery-1" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
  expect(api.seen).not.toHaveBeenCalled()
})

it("marks only the explicit observed revision and keeps recovery visible after viewing", async () => {
  open()
  await screen.findByText("Other project session")
  api.list.mockResolvedValue(success(page([item("recovery-1", { seen: true, seenAt: 3000 })])))
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  await screen.findByText(dict["attention.seen"])
  expect(api.seen).toHaveBeenCalledExactlyOnceWith(
    { itemID: "recovery-1", revision: "revision-1" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
  expect(screen.getByText(dict["attention.state.recovery_required"])).toBeTruthy()
  expect(screen.getByRole("button", { name: dict["attention.markSeen"] }).hasAttribute("disabled")).toBe(true)
})

it.each(["profile_disabled", "unsupported_host"])(
  "shows disabled capability %s without fetching the list",
  async (reason) => {
    api.capability.mockResolvedValue(success({ enabled: false, scope: "implicit-local", actor: "server", reason }))
    open()
    await screen.findByText(
      dict[reason === "profile_disabled" ? "attention.disabled.profile" : "attention.disabled.host"],
    )
    expect(api.list).not.toHaveBeenCalled()
    expect(api.seen).not.toHaveBeenCalled()
  },
)

it("treats an older server's missing capability as unsupported", async () => {
  api.capability.mockResolvedValue({ error: {}, response: { status: 404 } })
  open()
  await screen.findByText(dict["attention.disabled.host"])
  expect(api.list).not.toHaveBeenCalled()
})

it("offers retry on initial failure and preserves stale results after a later failure", async () => {
  api.list.mockRejectedValueOnce(new Error("network"))
  open()
  await screen.findByText(dict["attention.loadError"])
  expect(screen.queryByText(dict["attention.empty"])).toBeNull()
  refresh()
  await screen.findByText("Other project session")
  api.list.mockRejectedValueOnce(new Error("network"))
  refresh()
  await screen.findByText(dict["attention.stale"])
  expect(screen.getByText("Other project session")).toBeTruthy()
})

it("sends type and viewed filters to the backend and ignores the older filter response", async () => {
  open()
  await screen.findByText("Other project session")
  const older = Promise.withResolvers<ReturnType<typeof success<AttentionList>>>()
  api.list.mockReturnValueOnce(older.promise)
  fireEvent.change(screen.getByRole("combobox", { name: dict["attention.filter.kind"] }), {
    target: { value: "activity_failed" },
  })
  api.list.mockResolvedValueOnce(success(page([])))
  fireEvent.change(screen.getByRole("combobox", { name: dict["attention.filter.view"] }), {
    target: { value: "unseen" },
  })
  await screen.findByText(dict["attention.empty"])
  expect(api.list).toHaveBeenLastCalledWith(
    { kind: "activity_failed", view: "unseen", cursor: undefined, limit: "30" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
  older.resolve(success(page([item("old-result")])))
  await Promise.resolve()
  expect(screen.queryByText("Other project session")).toBeNull()
})

it("loads another page and refreshes the loaded pages without collapsing the list", async () => {
  const second = item("recovery-2", { session: { ...item().session, title: "Second page session" } })
  api.list.mockImplementation((query) =>
    Promise.resolve(success(query.cursor ? page([second]) : page([item()], "cursor-2"))),
  )
  open()
  fireEvent.click(await screen.findByRole("button", { name: dict["attention.more"] }))
  await screen.findByText("Second page session")
  expect(screen.getAllByRole("listitem")).toHaveLength(2)
  refresh()
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(4))
  expect(screen.getAllByRole("listitem")).toHaveLength(2)
  expect(api.list).toHaveBeenLastCalledWith(
    { kind: undefined, view: "all", cursor: "cursor-2", limit: "30" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
})

it("clears a previous cursor when a refreshed server response omits pagination", async () => {
  api.list.mockResolvedValueOnce(success(page([item()], "cursor-2")))
  open()
  await screen.findByRole("button", { name: dict["attention.more"] })
  const final = page()
  Reflect.deleteProperty(final, "nextCursor")
  api.list.mockResolvedValueOnce(success(final))
  refresh()
  await waitFor(() => expect(screen.queryByRole("button", { name: dict["attention.more"] })).toBeNull())
  expect(screen.getAllByRole("listitem")).toHaveLength(1)
})

it("refetches a conflicting receipt and requires another explicit mark for the new revision", async () => {
  open()
  await screen.findByText("Other project session")
  fireEvent.click(screen.getByRole("button", { name: dict["attention.details"] }))
  await screen.findByText(dict["attention.reason.recovery_required"])
  const newer = item("recovery-1", {
    revision: "revision-2",
    state: "authority_conflict",
    reasonCode: "authority_conflict",
  })
  api.seen.mockResolvedValueOnce({ error: {}, response: { status: 409 } })
  api.get.mockResolvedValue(success({ data: newer }))
  api.list.mockResolvedValue(success(page([newer])))
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  await screen.findByText(dict["attention.changed"])
  await screen.findByText(dict["attention.reason.authority_conflict"])
  expect(api.seen).toHaveBeenCalledTimes(1)
  expect(api.get).toHaveBeenCalledTimes(2)
  expect(screen.queryByText(dict["attention.seen"])).toBeNull()
})

it("clears data on server change and rejects late detail, list and receipt responses", async () => {
  const [key, setKey] = createSignal("server-a")
  connection.key = key
  const navigate = vi.fn()
  open(navigate)
  await screen.findByText("Other project session")
  const lateList = Promise.withResolvers<ReturnType<typeof success<AttentionList>>>()
  const lateDetail = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  const lateSeen = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  api.list.mockReturnValueOnce(lateList.promise)
  api.get.mockReturnValueOnce(lateDetail.promise)
  api.seen.mockReturnValueOnce(lateSeen.promise)
  refresh()
  fireEvent.click(screen.getByRole("button", { name: dict["attention.openSession"] }))
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  setKey("server-b")
  await screen.findByText(dict["attention.serverChanged"])
  lateList.resolve(success(page()))
  lateDetail.resolve(success({ data: item() }))
  lateSeen.resolve(success({ data: item("recovery-1", { seen: true }) }))
  await Promise.all([lateList.promise, lateDetail.promise, lateSeen.promise])
  expect(screen.queryByText("Other project session")).toBeNull()
  expect(navigate).not.toHaveBeenCalled()
  expect(api.capability).toHaveBeenCalledTimes(1)
})

it("polls only while mounted, retains details, and clears the five-second interval on close", async () => {
  const interval = vi.spyOn(globalThis, "setInterval")
  const clear = vi.spyOn(globalThis, "clearInterval")
  const rendered = open()
  await screen.findByText("Other project session")
  fireEvent.click(screen.getByRole("button", { name: dict["attention.details"] }))
  await screen.findByText(dict["attention.reason.recovery_required"])
  const focus = screen.getByRole("button", { name: dict["attention.openSession"] })
  focus.focus()
  const newer = item("recovery-1", {
    revision: "revision-2",
    state: "authority_conflict",
    reasonCode: "authority_conflict",
  })
  api.list.mockResolvedValue(success(page([newer])))
  const index = interval.mock.calls.findIndex((entry) => entry[1] === 5000)
  expect(index).toBeGreaterThanOrEqual(0)
  const tick = interval.mock.calls[index][0]
  if (typeof tick !== "function") throw new Error("Expected interval callback")
  tick()
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
  await screen.findByText(dict["attention.reason.authority_conflict"])
  expect(within(screen.getByRole("listitem")).getByText(dict["attention.state.authority_conflict"])).toBeTruthy()
  expect(document.activeElement).toBe(focus)
  expect(api.seen).not.toHaveBeenCalled()
  rendered.unmount()
  expect(clear).toHaveBeenCalledWith(interval.mock.results[index].value)
})

it("removes a successfully viewed item from the unseen filter even if the follow-up refresh fails", async () => {
  open()
  await screen.findByText("Other project session")
  fireEvent.change(screen.getByRole("combobox", { name: dict["attention.filter.view"] }), {
    target: { value: "unseen" },
  })
  await screen.findByText("Other project session")
  api.list.mockRejectedValueOnce(new Error("network"))
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  await screen.findByText(dict["attention.stale"])
  expect(screen.queryByText("Other project session")).toBeNull()
  expect(screen.getByText(/0 not viewed/)).toBeTruthy()
  expect(api.seen).toHaveBeenCalledTimes(1)
})

it("does not navigate a vanished item and refetches after its 404", async () => {
  const navigate = vi.fn()
  open(navigate)
  await screen.findByText("Other project session")
  api.get.mockResolvedValueOnce({ error: {}, response: { status: 404 } })
  api.list.mockResolvedValue(success(page([])))
  fireEvent.click(screen.getByRole("button", { name: dict["attention.openSession"] }))
  await screen.findByText(dict["attention.changed"])
  await screen.findByText(dict["attention.empty"])
  expect(navigate).not.toHaveBeenCalled()
  expect(api.seen).not.toHaveBeenCalled()
})

it("does not reduce another filter's count when an older viewed receipt arrives after switching type", async () => {
  open()
  await screen.findByText("Other project session")
  const pending = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  api.seen.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  const failed = item("failed-1", {
    kind: "activity_failed",
    state: "failed",
    reasonCode: "activity_failed",
    session: { ...item().session, title: "Failed execution" },
  })
  api.list.mockResolvedValueOnce(success(page([failed])))
  fireEvent.change(screen.getByRole("combobox", { name: dict["attention.filter.kind"] }), {
    target: { value: "activity_failed" },
  })
  await screen.findByText("Failed execution")
  api.list.mockRejectedValueOnce(new Error("network"))
  pending.resolve(success({ data: item("recovery-1", { seen: true, seenAt: 3000 }) }))
  await screen.findByText(dict["attention.stale"])
  expect(screen.getByText(/1 not viewed/)).toBeTruthy()
  expect(screen.getByText("Failed execution")).toBeTruthy()
  expect(screen.queryByText("Other project session")).toBeNull()
})

it("keeps a newer source revision unseen when an older viewed receipt arrives after a refresh", async () => {
  open()
  await screen.findByText("Other project session")
  const pending = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  api.seen.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  const newer = item("recovery-1", {
    revision: "revision-2",
    state: "authority_conflict",
    reasonCode: "authority_conflict",
  })
  api.list.mockResolvedValueOnce(success(page([newer])))
  refresh()
  await screen.findByText(dict["attention.state.authority_conflict"])
  api.list.mockRejectedValueOnce(new Error("network"))
  pending.resolve(success({ data: item("recovery-1", { seen: true, seenAt: 3000 }) }))
  await screen.findByText(dict["attention.stale"])
  expect(screen.getByText(/1 not viewed/)).toBeTruthy()
  expect(screen.getByText(dict["attention.state.authority_conflict"])).toBeTruthy()
  expect(screen.queryByText(dict["attention.seen"])).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  expect(api.seen).toHaveBeenLastCalledWith(
    { itemID: "recovery-1", revision: "revision-2" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
})

it("does not subtract an already-observed receipt twice when a refresh wins the race", async () => {
  const other = item("recovery-2", { session: { ...item().session, title: "Another unviewed item" } })
  api.list.mockResolvedValue(success(page([item(), other])))
  open()
  await screen.findByText("Other project session")
  const pending = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  api.seen.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getAllByRole("button", { name: dict["attention.markSeen"] })[0])
  api.list.mockResolvedValueOnce(success(page([item("recovery-1", { seen: true, seenAt: 3000 }), other])))
  refresh()
  await screen.findByText(dict["attention.seen"])
  api.list.mockRejectedValueOnce(new Error("network"))
  pending.resolve(success({ data: item("recovery-1", { seen: true, seenAt: 3000 }) }))
  await screen.findByText(dict["attention.stale"])
  expect(screen.getByText(/1 not viewed/)).toBeTruthy()
  expect(screen.getByText("Another unviewed item")).toBeTruthy()
})

it("does not restore old details when a newer source revision arrived while GET was pending", async () => {
  open()
  await screen.findByText("Other project session")
  const pending = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  api.get.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole("button", { name: dict["attention.details"] }))
  const newer = item("recovery-1", {
    revision: "revision-2",
    state: "authority_conflict",
    reasonCode: "authority_conflict",
  })
  api.list.mockResolvedValueOnce(success(page([newer])))
  refresh()
  await screen.findByText(dict["attention.state.authority_conflict"])
  pending.resolve(success({ data: item() }))
  await screen.findByText(dict["attention.reason.authority_conflict"])
  expect(screen.queryByText(dict["attention.reason.recovery_required"])).toBeNull()
  expect(api.seen).not.toHaveBeenCalled()
})

it("formal HTTP Task/Goal views preserve source targets and rank pages, restore with fresh reads, and never execute on seen", async () => {
  const child = item("task:one", {
    kind: "task",
    state: "close_requested",
    reasonCode: "task_close_requested",
    allowedActions: [],
    session: {
      id: "actual-child",
      title: "Actual task child",
      projectID: "child-project",
      directory: "/projects/child",
      workspaceID: null,
      parentID: "actual-parent",
    },
    source: {
      task: {
        runID: "internal-run",
        parentSessionID: "actual-parent",
        childSessionID: "actual-child",
        recordedChildSessionID: "recorded-child",
        generation: 1,
        version: 2,
        state: "completed",
        controlState: "close_requested",
        terminalReceiptID: "receipt-one",
        pendingProviders: 0,
        pendingProviderAttempts: 0,
        pendingToolEffects: 0,
        hasExecutionClaim: false,
      },
    },
  })
  const goal = item("goal:one", {
    kind: "goal",
    state: "recovery_required",
    reasonCode: "goal_recovery",
    allowedActions: [],
    session: {
      id: "goal-session",
      title: "Goal with pending plan change",
      projectID: "goal-project",
      directory: "/projects/goal",
      workspaceID: null,
    },
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
  })
  const state = {
    items: [
      goal,
      child,
      item("goal:two", { ...goal, id: "goal:two", session: { ...goal.session, title: "Later ranked goal" } }),
    ],
    hold: undefined as Promise<void> | undefined,
    calls: [] as { method: string; path: string; body: unknown; kind: string | null; cursor: string | null }[],
  }
  // This is a typed public-wire component oracle, not a Task/Goal execution authority.
  // Only reads and the original viewed receipt are exposed; any execution request fails.
  const server = createServer(async (request, response) => {
    const route = new URL(request.url!, "http://127.0.0.1")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    state.calls.push({
      method: request.method!,
      path: decodeURIComponent(route.pathname),
      body,
      kind: route.searchParams.get("kind"),
      cursor: route.searchParams.get("cursor"),
    })
    response.setHeader("Content-Type", "application/json")
    if (request.headers.authorization !== "Bearer private-attention") {
      response.writeHead(401).end("{}")
      return
    }
    if (route.pathname === "/api/attention/capability") {
      response.end(JSON.stringify({ enabled: true, scope: "implicit-local", actor: "server", reason: "enabled" }))
      return
    }
    if (route.pathname === "/api/attention") {
      const filtered = state.items.filter(
        (entry) =>
          (!route.searchParams.get("kind") || entry.kind === route.searchParams.get("kind")) &&
          (route.searchParams.get("view") !== "unseen" || !entry.seen),
      )
      const offset = route.searchParams.get("cursor") ? 2 : 0
      response.end(
        JSON.stringify({
          data: filtered.slice(offset, offset + 2),
          ...(filtered.length > offset + 2 ? { nextCursor: "rank-2" } : {}),
          scope: "implicit-local",
          asOf: 1,
          unseenCount: state.items.filter((entry) => !entry.seen).length,
        }),
      )
      return
    }
    const path = decodeURIComponent(route.pathname)
    const selected = state.items.find(
      (entry) => path === `/api/attention/${entry.id}` || path === `/api/attention/${entry.id}/seen`,
    )
    if (selected) {
      if (request.method === "PUT" && path.endsWith("/seen")) {
        if (!body || typeof body !== "object" || !("revision" in body) || body.revision !== selected.revision) {
          response.writeHead(409).end("{}")
          return
        }
        state.items = state.items.map((entry) =>
          entry.id === selected.id ? { ...entry, seen: true, seenAt: 2 } : entry,
        )
      }
      if (request.method === "GET") await state.hold
      response.end(JSON.stringify({ data: state.items.find((entry) => entry.id === selected.id) }))
      return
    }
    if (path === "/api/session/actual-parent") {
      response.end(
        JSON.stringify({
          data: {
            id: "actual-parent",
            projectID: "parent-project",
            title: "Actual parent",
            location: { directory: "/projects/parent" },
            permissions: [],
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
          },
        }),
      )
      return
    }
    response.writeHead(405).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing owned listener")
  const surface = window as unknown as Window
  const origin = window.location.href
  const release = Promise.withResolvers<void>()
  try {
    connection.url = `http://127.0.0.1:${address.port}`
    surface.happyDOM.setURL(connection.url)
    connection.client = createOpencodeClient({
      baseUrl: connection.url,
      headers: { Authorization: "Bearer private-attention" },
    })
    const navigate = vi.fn()
    let view = open(navigate)
    await screen.findByText("Actual task child")
    expect(screen.getAllByRole("listitem").map((row) => row.querySelector(".font-medium")?.textContent)).toEqual([
      goal.session.title,
      child.session.title,
    ])
    fireEvent.click(
      within(screen.getAllByRole("listitem")[1]!).getByRole("button", { name: dict["attention.details"] }),
    )
    await screen.findByText(dict["attention.source.closeIntent"])
    expect(screen.getAllByText("actual-child").length).toBeGreaterThan(0)
    expect(screen.queryByText("internal-run")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: dict["attention.source.openParent"] }))
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "actual-parent", directory: "/projects/parent", projectID: "parent-project" }),
      ),
    )
    expect(
      state.calls.some(
        (call) => call.path === "/api/session/recorded-child" || call.path === "/api/session/internal-run",
      ),
    ).toBe(false)
    fireEvent.click(
      within(screen.getAllByRole("listitem")[1]!).getByRole("button", { name: dict["attention.markSeen"] }),
    )
    await waitFor(() => expect(state.calls.filter((call) => call.method === "PUT")).toHaveLength(1))
    expect(state.calls.find((call) => call.method === "PUT")?.body).toEqual({ revision: child.revision })
    expect(state.items.find((entry) => entry.id === child.id)?.state).toBe("close_requested")
    fireEvent.change(screen.getByRole("combobox", { name: dict["attention.filter.kind"] }), {
      target: { value: "goal" },
    })
    await screen.findByText("Goal with pending plan change")
    fireEvent.click(screen.getAllByRole("button", { name: dict["attention.details"] })[0]!)
    await screen.findByText(dict["attention.source.pendingRebase"])
    expect(screen.queryByRole("button", { name: /Continue once|Stop activity|Resume|Pause/ })).toBeNull()
    screen.getByRole("dialog").scrollTop = 187
    view.unmount()
    view = open(navigate)
    await screen.findByText(dict["attention.source.pendingRebase"])
    await waitFor(() => expect(screen.getByRole("dialog").scrollTop).toBe(187))
    expect((screen.getByRole("combobox", { name: dict["attention.filter.kind"] }) as HTMLSelectElement).value).toBe(
      "goal",
    )
    fireEvent.change(screen.getByRole("combobox", { name: dict["attention.filter.kind"] }), {
      target: { value: "all" },
    })
    await screen.findByRole("button", { name: dict["attention.more"] })
    fireEvent.click(screen.getByRole("button", { name: dict["attention.more"] }))
    await screen.findByText("Later ranked goal")
    expect(screen.getAllByRole("listitem")).toHaveLength(3)
    state.items = state.items.map((entry) =>
      entry.id === child.id
        ? { ...entry, revision: "changed-source", source: { task: { ...entry.source.task!, childSessionID: null } } }
        : entry,
    )
    navigate.mockClear()
    fireEvent.click(
      within(screen.getAllByRole("listitem")[1]!).getByRole("button", { name: dict["attention.openSession"] }),
    )
    await screen.findByText(dict["attention.changed"])
    expect(navigate).not.toHaveBeenCalled()
    state.hold = release.promise
    fireEvent.click(screen.getAllByRole("button", { name: dict["attention.details"] })[0]!)
    await waitFor(() => expect(state.calls.at(-1)?.path).toBe(`/api/attention/${goal.id}`))
    view.unmount()
    const before = state.calls.length
    release.resolve()
    await Promise.resolve()
    expect(state.calls).toHaveLength(before)
    expect(state.calls.filter((call) => call.method !== "GET" && call.method !== "PUT")).toHaveLength(0)
  } finally {
    release.resolve()
    cleanup()
    surface.happyDOM.setURL(origin)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

// Exercise the generated wire and rendered controls. This peer supplies controlled receipts;
// the separate Host authority tests prove authorization and durable reduction.
async function controlsWire() {
  const task = item("task:controls", {
    revision: "a".repeat(64),
    kind: "task",
    state: "recovery_required",
    reasonCode: "task_recovery",
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
  })
  const goal = item("goal:controls", {
    revision: "b".repeat(64),
    kind: "goal",
    state: "paused",
    reasonCode: "goal_paused",
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
  })
  const state = {
    item: task,
    items: undefined as AttentionItem[] | undefined,
    task,
    goal,
    outcome: "ok" as "ok" | "unknown" | "wrong",
    changed: false,
    parentHold: undefined as Promise<void> | undefined,
    postHold: undefined as Promise<void> | undefined,
    calls: [] as {
      method: string
      path: string
      body: unknown
      directory: string | null
      auth?: string
      origin?: string
    }[],
  }
  const auth = `Basic ${Buffer.from("operator:private-attention").toString("base64")}`
  const listener = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    const route = decodeURIComponent(url.pathname)
    state.calls.push({
      method: request.method!,
      path: route,
      body,
      directory: url.searchParams.get("directory"),
      auth: request.headers.authorization,
      origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
    })
    response.setHeader("Content-Type", "application/json")
    if (request.headers.authorization !== auth) {
      response.writeHead(401).end("{}")
      return
    }
    if (route === "/api/attention/capability") {
      response.end(JSON.stringify({ enabled: true, scope: "implicit-local", actor: "server", reason: "enabled" }))
      return
    }
    if (route === "/api/attention") {
      response.end(JSON.stringify(page(state.items ?? [state.item])))
      return
    }
    const detail = state.items?.find((entry) => route === `/api/attention/${entry.id}`)
    if (detail) {
      response.end(JSON.stringify({ data: detail }))
      return
    }
    if (route === `/api/attention/${state.item.id}`) {
      response.end(JSON.stringify({ data: state.changed ? { ...state.item, revision: "c".repeat(64) } : state.item }))
      return
    }
    if (route === "/api/session/actual-parent") {
      await state.parentHold
      response.end(
        JSON.stringify({
          data: {
            id: "actual-parent",
            projectID: "actual-parent-project",
            title: "Actual parent",
            location: { directory: "/projects/actual-parent" },
            permissions: [],
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
          },
        }),
      )
      return
    }
    const snapshot = {
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
    if (route === "/deepagent/goal/status") {
      response.end(JSON.stringify({ goal: snapshot }))
      return
    }
    if (route === "/api/attention/task/control") {
      const original = Schema.decodeUnknownSync(TaskHumanControlSchema.Input)(body)
      await state.postHold
      if (state.outcome === "unknown") {
        response.writeHead(503).end("{}")
        return
      }
      response.end(
        JSON.stringify({
          replayed: false,
          receipt: {
            contract: "task-human-control-v1",
            receiptID: "controlled-receipt",
            requestHash: "d".repeat(64),
            request: state.outcome === "wrong" ? { ...original, requestID: "foreign-request" } : original,
            authority: {
              scope: "implicit-local",
              principal: "operator",
              directory: "/projects/actual-parent",
              projectID: "actual-parent-project",
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
        }),
      )
      return
    }
    if (["/deepagent/goal/pause", "/deepagent/goal/resume", "/deepagent/goal/stop"].includes(route)) {
      if (!body || typeof body !== "object" || !("sessionID" in body) || !("requestID" in body))
        throw new Error("Invalid original body")
      await state.postHold
      if (state.outcome === "unknown") {
        response.writeHead(503).end("{}")
        return
      }
      const action = route.split("/").at(-1)
      response.end(
        JSON.stringify({
          ...snapshot,
          revision: 8,
          inFlight: true,
          requestedPhase: action === "pause" ? "paused" : action === "resume" ? "running" : "stopped",
          receiptID:
            state.outcome === "wrong"
              ? "goalcmd_foreign"
              : `goalcmd_${createHash("sha256")
                  .update(JSON.stringify([body.sessionID, body.requestID]))
                  .digest("hex")}`,
        }),
      )
      return
    }
    response.writeHead(405).end("{}")
  })
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Missing private listener")
  const previous = window.location.href
  const surface = window as unknown as Window
  connection.url = `http://127.0.0.1:${address.port}`
  surface.happyDOM.setURL(connection.url)
  connection.client = createOpencodeClient({
    baseUrl: connection.url,
    headers: { Authorization: auth, Origin: "oc://renderer" },
  })
  return {
    state,
    auth,
    async close() {
      cleanup()
      surface.happyDOM.setURL(previous)
      listener.closeAllConnections()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    },
  }
}

async function confirmControl(action: string, reason = "") {
  if (reason) {
    const input = await screen.findByRole("textbox", { name: dict["attention.control.reason"] })
    await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false))
    fireEvent.input(input, {
      target: { value: reason },
    })
  }
  const button = await screen.findByRole("button", { name: dict[`attention.action.${action}` as keyof typeof dict] })
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
  fireEvent.click(button)
  fireEvent.click(await screen.findByRole("button", { name: dict["attention.control.confirm"] }))
}

it("formal HTTP Task and Goal selections do not mutate ranked source rows after reopening or refreshing", async () => {
  const peer = await controlsWire()
  try {
    peer.state.items = [
      { ...peer.state.task, session: { ...peer.state.task.session, title: "Original Task row" } },
      { ...peer.state.goal, session: { ...peer.state.goal.session, title: "Original Goal row" } },
    ]
    const original = JSON.stringify(peer.state.items)
    let view = open()
    await screen.findByText("Original Task row")
    const row = (id: string) => {
      const element = document.querySelector(`[data-attention-id="${id}"]`)
      if (!(element instanceof HTMLElement)) throw new Error("Missing original source row")
      return within(element)
    }
    fireEvent.click(row(peer.state.task.id).getByRole("button", { name: dict["attention.details"] }))
    await screen.findByRole("textbox", { name: dict["attention.control.reason"] })
    view.unmount()
    view = open()
    await screen.findByRole("textbox", { name: dict["attention.control.reason"] })
    fireEvent.click(row(peer.state.goal.id).getByRole("button", { name: dict["attention.details"] }))
    await screen.findByRole("button", { name: dict["attention.action.goal_resume"] })
    expect(row(peer.state.task.id).getByText("Original Task row")).toBeTruthy()
    expect(row(peer.state.goal.id).getByText("Original Goal row")).toBeTruthy()
    expect(row(peer.state.task.id).queryByRole("button", { name: dict["attention.action.goal_resume"] })).toBeNull()
    expect(row(peer.state.goal.id).queryByRole("textbox", { name: dict["attention.control.reason"] })).toBeNull()
    refresh()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["attention.refresh"] }).hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(row(peer.state.task.id).getByRole("button", { name: dict["attention.details"] }))
    await screen.findByRole("textbox", { name: dict["attention.control.reason"] })
    expect(row(peer.state.goal.id).getByText("Original Goal row")).toBeTruthy()
    expect(row(peer.state.task.id).getByText("Original Task row")).toBeTruthy()
    expect(row(peer.state.task.id).getByText("actual-parent")).toBeTruthy()
    expect(row(peer.state.task.id).queryByText("goal-controls")).toBeNull()
    expect(row(peer.state.task.id).queryByRole("button", { name: dict["attention.action.goal_resume"] })).toBeNull()
    expect(JSON.stringify(peer.state.items)).toBe(original)
    expect(peer.state.calls.every((call) => call.method === "GET")).toBe(true)
  } finally {
    await peer.close()
  }
})

it("formal HTTP Task controls freeze reviewed reasons and original nullable source, retry only explicitly, and use actual parent placement", async () => {
  const peer = await controlsWire()
  const gate = Promise.withResolvers<void>()
  try {
    let view = open()
    fireEvent.click(await screen.findByRole("button", { name: dict["attention.details"] }))
    await screen.findByRole("textbox", { name: dict["attention.control.reason"] })
    expect(peer.state.calls.every((call) => call.method === "GET")).toBe(true)
    peer.state.outcome = "unknown"
    peer.state.parentHold = gate.promise
    await confirmControl("task_request_close", "  Preserve unknown custody 中  ")
    await waitFor(() => expect(peer.state.calls.at(-1)?.path).toBe("/api/session/actual-parent"))
    fireEvent.input(screen.getByRole("textbox", { name: dict["attention.control.reason"] }), {
      target: { value: "late edit" },
    })
    gate.resolve()
    await screen.findByText(dict["attention.control.unknown"])
    const first = peer.state.calls.find((call) => call.method === "POST")!
    expect(first.directory).toBe("/projects/actual-parent")
    expect(first.body).toEqual(
      expect.objectContaining({
        runID: "run-controls",
        parentSessionID: "actual-parent",
        childSessionID: null,
        generation: 2,
        expectedVersion: 3,
        itemID: peer.state.task.id,
        itemRevision: peer.state.task.revision,
        action: "request_close",
        reason: "  Preserve unknown custody 中  ",
      }),
    )
    refresh()
    await waitFor(() => expect(peer.state.calls.at(-1)?.path).toBe("/api/attention"))
    expect(peer.state.calls.filter((call) => call.method === "POST")).toHaveLength(1)
    view.unmount()
    view = open()
    await screen.findByRole("button", { name: dict["attention.control.retry"] })
    peer.state.outcome = "ok"
    fireEvent.click(screen.getByRole("button", { name: dict["attention.control.retry"] }))
    await screen.findByText(dict["attention.actionSubmitted"])
    expect(peer.state.calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
      first.body,
      first.body,
    ])
    expect((await screen.findAllByText(dict["attention.state.recovery_required"])).length).toBeGreaterThan(0)
    for (const action of ["task_resolve_failed", "task_resolve_closed"]) {
      await confirmControl(action, `Review ${action}`)
      await waitFor(() =>
        expect(peer.state.calls.filter((call) => call.method === "POST").at(-1)?.body).toEqual(
          expect.objectContaining({ action: action.replace("task_", ""), reason: `Review ${action}` }),
        ),
      )
      await waitFor(() => expect(screen.queryByRole("button", { name: dict["attention.control.confirm"] })).toBeNull())
    }
    expect(peer.state.calls.every((call) => call.auth === peer.auth)).toBe(true)
    // HappyDOM's browser transport omits forbidden manually supplied Origin;
    // the independent Host socket oracle covers the actual Basic + Origin gate.
    expect(peer.state.calls.some((call) => /wake|prompt|permission/.test(call.path))).toBe(false)
  } finally {
    gate.resolve()
    await peer.close()
  }
})

it("formal HTTP changed Task source prevents dispatch and an old owner late receipt cannot clear the new owner", async () => {
  const peer = await controlsWire()
  const gate = Promise.withResolvers<void>()
  try {
    const view = open()
    fireEvent.click(await screen.findByRole("button", { name: dict["attention.details"] }))
    await screen.findByRole("textbox", { name: dict["attention.control.reason"] })
    peer.state.changed = true
    await confirmControl("task_request_close", "Review original source")
    await screen.findByText(dict["attention.control.changed"])
    expect(peer.state.calls.filter((call) => call.method === "POST")).toHaveLength(0)
    peer.state.changed = false
    peer.state.postHold = gate.promise
    await confirmControl("task_request_close", "Original owner")
    await waitFor(() => expect(peer.state.calls.filter((call) => call.method === "POST")).toHaveLength(1))
    view.unmount()
    connection.scope = "new-credential-owner"
    open()
    fireEvent.click(await screen.findByRole("button", { name: dict["attention.details"] }))
    const reason = await screen.findByRole("textbox", { name: dict["attention.control.reason"] })
    fireEvent.input(reason, { target: { value: "New owner draft" } })
    gate.resolve()
    await waitFor(() => expect((reason as HTMLTextAreaElement).value).toBe("New owner draft"))
    expect(screen.queryByText(dict["attention.actionSubmitted"])).toBeNull()
    expect(screen.queryByRole("button", { name: dict["attention.control.retry"] })).toBeNull()
    expect(peer.state.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  } finally {
    gate.resolve()
    await peer.close()
  }
})

it.each(["pause", "resume", "stop"] as const)(
  "formal HTTP Goal %s uses the fresh original goal revision and validates its exact request receipt",
  async (action) => {
    const peer = await controlsWire()
    try {
      peer.state.item = peer.state.goal
      open()
      fireEvent.click(await screen.findByRole("button", { name: dict["attention.details"] }))
      peer.state.outcome = "wrong"
      await confirmControl(`goal_${action}`)
      await screen.findByText(dict["attention.control.unknown"])
      const first = peer.state.calls.find((call) => call.method === "POST")!
      expect(first.path).toBe(`/deepagent/goal/${action}`)
      expect(first.directory).toBe(peer.state.goal.session.directory)
      expect(first.body).toEqual({
        sessionID: peer.state.goal.session.id,
        goalId: "goal-controls",
        expectedRevision: 7,
        requestID: expect.any(String),
      })
      expect(peer.state.calls.find((call) => call.path === "/deepagent/goal/status")?.directory).toBe(
        peer.state.goal.session.directory,
      )
      refresh()
      await waitFor(() => expect(peer.state.calls.at(-1)?.path).toBe("/api/attention"))
      expect(peer.state.calls.filter((call) => call.method === "POST")).toHaveLength(1)
      peer.state.outcome = "ok"
      fireEvent.click(screen.getByRole("button", { name: dict["attention.control.retry"] }))
      await screen.findByText(dict["attention.actionSubmitted"])
      expect(peer.state.calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
        first.body,
        first.body,
      ])
      expect(peer.state.item.state).toBe("paused")
    } finally {
      await peer.close()
    }
  },
)

it("an advertised terminal Goal edit opens the original editor and closes back to its live Attention owner without a control POST", async () => {
  const peer = await controlsWire()
  planStore.directory = await mkdtemp(path.join(tmpdir(), "dac-attention-plan-"))
  try {
    peer.state.item = {
      ...peer.state.goal,
      state: "stopped",
      allowedActions: ["goal_edit"],
      source: { goal: { ...peer.state.goal.source.goal!, phase: "stopped" } },
    }
    open()
    fireEvent.click(await screen.findByRole("button", { name: dict["attention.details"] }))
    await confirmControl("goal_edit")
    await screen.findByText(dict["goal.plan.beginHint"])
    fireEvent.click(screen.getByRole("button", { name: dict["goal.plan.close"] }))
    await waitFor(() => expect(screen.queryByText(dict["goal.plan.beginHint"])).toBeNull())
    expect(screen.getByRole("button", { name: dict["attention.action.goal_edit"] }).hasAttribute("disabled")).toBe(
      false,
    )
    expect(screen.queryByRole("button", { name: dict["attention.action.goal_resume"] })).toBeNull()
    expect(peer.state.calls.filter((call) => call.method === "POST")).toHaveLength(0)
  } finally {
    await peer.close()
    await rm(planStore.directory, { recursive: true, force: true })
  }
})
