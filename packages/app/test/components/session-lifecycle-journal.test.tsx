import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { createServer } from "node:http"
import { setImmediate } from "node:timers/promises"
import { createDeepAgentCodeClient, type DeepAgentCodeClient, type SessionStatus } from "@deepagent-code/sdk"
import { SessionLifecycle } from "@/recovery/session-lifecycle"
import { subscribeSessionNotifications } from "@/context/v2-notification-subscription"
import { createNotificationJournalSubscription } from "@/context/notification-journal"

type Hint = { name: string; details: { properties: { sessionID: string } } }
const runtime = vi.hoisted(() => ({
  client: undefined as DeepAgentCodeClient | undefined,
  scope: "original-owner",
  directory: "/private/ui-journal",
  statuses: {} as Record<string, SessionStatus>,
  setStatus: (_sessionID: string, _status: SessionStatus) => {},
  listeners: new Set<(event: Hint) => void>(),
}))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    get client() {
      return runtime.client!
    },
    get scope() {
      return runtime.scope
    },
    get directory() {
      return runtime.directory
    },
    event: {
      listen: (callback: (event: Hint) => void) => {
        runtime.listeners.add(callback)
        return () => {
          runtime.listeners.delete(callback)
        }
      },
    },
  }),
}))
vi.mock("@/context/server-sync", () => ({ useServerSync: () => ({ child: () => [{ session: [{ id: "ses-ui" }] }] }) }))
vi.mock("@/context/sync", () => ({
  useSync: () => ({
    get data() {
      return { session_status: runtime.statuses }
    },
    set: (_field: string, sessionID: string, status: SessionStatus) => runtime.setStatus(sessionID, status),
    session: { sync: async () => {} },
  }),
}))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] })
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
  runtime.listeners.clear()
  runtime.scope = "original-owner"
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (document as { visibilityState?: string }).visibilityState
})
async function flush(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await setImmediate()
  expect(check()).toBe(true)
  for (let i = 0; i < 5; i++) await setImmediate()
}
function hint(type = "session.execution.interrupted", sessionID = "ses-ui") {
  for (const listener of runtime.listeners) listener({ name: type, details: { properties: { sessionID } } })
}
function visibility(value: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value })
  document.dispatchEvent(new Event("visibilitychange"))
}
function mount() {
  const history = createMemoryHistory()
  history.set({ value: "/ses-ui", scroll: false })
  return render(() => (
    <MemoryRouter history={history}>
      <Route
        path="/:id"
        component={() => {
          const [statuses, setStatuses] = createStore<Record<string, SessionStatus>>({})
          runtime.statuses = statuses
          runtime.setStatus = (sessionID, status) => setStatuses(sessionID, status)
          return (
            <SessionLifecycle>
              <span data-testid="status">{statuses["ses-ui"]?.type ?? "unconfirmed"}</span>
            </SessionLifecycle>
          )
        }}
      />
    </MemoryRouter>
  ))
}
async function serve() {
  const state = {
    rows: [] as { id: string; seq: number; type: string; data: { sessionID: string; timestamp: number } }[],
    projection: { type: "idle" } as SessionStatus,
    statusGate: undefined as Promise<void> | undefined,
    eventGate: undefined as Promise<void> | undefined,
    calls: [] as { path: string; after: string | null }[],
    active: 0,
    maximum: 0,
    aborted: 0,
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1")
    response.setHeader("Content-Type", "application/json")
    response.setHeader("Access-Control-Allow-Origin", "*")
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Headers", request.headers["access-control-request-headers"] ?? "*")
      response.end()
      return
    }
    state.calls.push({ path: url.pathname, after: url.searchParams.get("after") })
    if (url.pathname === "/session/status") {
      const projection = state.projection
      await state.statusGate
      response.end(JSON.stringify({ "ses-ui": projection }))
      return
    }
    if (url.pathname === "/context/eventsCursor") {
      response.end(JSON.stringify({ watermark: 0, floor: 0, cursor: 0 }))
      return
    }
    if (url.pathname === "/context/events") {
      state.active++
      state.maximum = Math.max(state.maximum, state.active)
      response.on("close", () => {
        if (!response.writableEnded) state.aborted++
      })
      const rows = state.rows.filter((row) => row.seq > Number(url.searchParams.get("after") ?? 0))
      await state.eventGate
      state.active--
      response.end(JSON.stringify({ events: rows, nextCursor: rows.at(-1)?.seq ?? 0, floor: 0 }))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No private listener")
  const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  runtime.client = client
  return {
    state,
    client,
    count: (path: string) => state.calls.filter((call) => call.path === path).length,
    async close() {
      cleanup()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

it("an interrupted journal refreshes the authoritative recovery state instead of guessing idle", async () => {
  const peer = await serve()
  try {
    mount()
    await vi.advanceTimersByTimeAsync(0)
    await flush(() => screen.getByTestId("status").textContent === "idle" && peer.count("/context/events") === 1)
    peer.state.projection = { type: "recovery_required", message: "Unresolved durable read admission" }
    peer.state.rows.push({
      id: "interrupt",
      seq: 1,
      type: "session.execution.interrupted.1",
      data: { sessionID: "ses-ui", timestamp: 1 },
    })
    hint()
    await vi.advanceTimersByTimeAsync(1000)
    await flush(() => screen.getByTestId("status").textContent === "recovery_required")
    expect(peer.count("/context/eventsCursor")).toBe(1)
    expect(peer.state.calls.every((call) => call.path === "/session/status" || call.path.startsWith("/context/"))).toBe(
      true,
    )
  } finally {
    await peer.close()
  }
})

it("a later Started hint and durable row fence an older status response", async () => {
  const peer = await serve()
  const held = Promise.withResolvers<void>()
  try {
    mount()
    await vi.advanceTimersByTimeAsync(0)
    await flush(() => screen.getByTestId("status").textContent === "idle")
    peer.state.statusGate = held.promise
    peer.state.rows.push({
      id: "interrupt",
      seq: 1,
      type: "session.execution.interrupted.1",
      data: { sessionID: "ses-ui", timestamp: 1 },
    })
    hint()
    await vi.advanceTimersByTimeAsync(1000)
    await flush(() => peer.count("/session/status") === 2)
    peer.state.rows.push({
      id: "start",
      seq: 2,
      type: "session.execution.started.1",
      data: { sessionID: "ses-ui", timestamp: 2 },
    })
    hint("session.execution.started")
    await vi.advanceTimersByTimeAsync(1000)
    await flush(() => screen.getByTestId("status").textContent === "busy")
    held.resolve()
    await flush(() => peer.count("/context/events") === 3)
    expect(screen.getByTestId("status").textContent).toBe("busy")
  } finally {
    held.resolve()
    await peer.close()
  }
})

it("hidden work merges into one foreground drain and disposed owners remove listeners and late reads", async () => {
  const peer = await serve()
  const held = Promise.withResolvers<void>()
  try {
    const view = mount()
    await vi.advanceTimersByTimeAsync(0)
    await flush(() => peer.count("/context/events") === 1)
    visibility("hidden")
    for (let i = 0; i < 80; i++) hint()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(peer.count("/context/events")).toBe(1)
    visibility("visible")
    await vi.advanceTimersByTimeAsync(0)
    await flush(() => peer.count("/context/events") === 2)
    peer.state.eventGate = held.promise
    hint()
    await vi.advanceTimersByTimeAsync(1000)
    await flush(() => peer.count("/context/events") === 3)
    view.unmount()
    expect(runtime.listeners.size).toBe(0)
    held.resolve()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(peer.count("/context/events")).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    held.resolve()
    await peer.close()
  }
})

it("notification drains anchor once, back off empty polls, and consume hinted backlog with a bounded successor", async () => {
  const peer = await serve()
  const held = Promise.withResolvers<void>()
  const notifications: string[] = []
  let kick: ((sessionID?: string) => void) | undefined
  const close = subscribeSessionNotifications(
    peer.client,
    ["ses-ui"],
    {
      onIdle: (sessionID) => notifications.push(sessionID),
      onError: () => {},
    },
    {
      subscribeHint: (callback) => {
        kick = callback
        return () => {
          kick = undefined
        }
      },
    },
  )
  try {
    await vi.advanceTimersByTimeAsync(0)
    await flush(() => peer.count("/context/events") === 1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(peer.count("/context/events")).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush(() => peer.count("/context/events") === 2)
    peer.state.eventGate = held.promise
    kick?.("ses-ui")
    await vi.advanceTimersByTimeAsync(1000)
    await flush(() => peer.count("/context/events") === 3)
    peer.state.rows.push({
      id: "success",
      seq: 1,
      type: "session.execution.succeeded.1",
      data: { sessionID: "ses-ui", timestamp: 1 },
    })
    for (let i = 0; i < 80; i++) kick?.("ses-ui")
    peer.state.eventGate = undefined
    held.resolve()
    await flush(() => peer.state.active === 0)
    await vi.advanceTimersByTimeAsync(1000)
    await flush(() => notifications.length === 1)
    expect(peer.state.maximum).toBe(1)
    expect(peer.count("/context/events")).toBe(4)
    expect(peer.count("/context/eventsCursor")).toBe(1)
    close()
    expect(kick).toBeUndefined()
  } finally {
    close()
    held.resolve()
    await peer.close()
  }
})

it("closing a journal while its initial cursor is pending cannot install a late subscription", async () => {
  const cursor = Promise.withResolvers<{ data: { watermark: number; floor: number; cursor: number } }>()
  const events = vi.fn(async () => ({ data: { events: [], floor: 0 } }))
  const listeners = new Set<(sessionID?: string) => void>()
  const journal = createNotificationJournalSubscription({
    client: { context: { eventsCursor: () => cursor.promise, events } },
    currentDirectory: () => "/private/old-owner",
    sessionsOf: () => ["ses-ui"],
    subscribeHint: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    handlers: { onIdle: () => {}, onError: () => {} },
  })
  journal.refresh()
  journal.dispose()
  cursor.resolve({ data: { watermark: 0, floor: 0, cursor: 0 } })
  await vi.advanceTimersByTimeAsync(90_000)
  expect(events).not.toHaveBeenCalled()
  expect(listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it("a new connection owner cannot receive a disposed owner's late recovery response", async () => {
  const original = await serve()
  const held = Promise.withResolvers<void>()
  const replacement = { peer: undefined as Awaited<ReturnType<typeof serve>> | undefined }
  try {
    const oldView = mount()
    await vi.advanceTimersByTimeAsync(0)
    await flush(() => screen.getByTestId("status").textContent === "idle")
    original.state.projection = { type: "recovery_required", message: "Original owner only" }
    original.state.statusGate = held.promise
    original.state.rows.push({
      id: "interrupt",
      seq: 1,
      type: "session.execution.interrupted.1",
      data: { sessionID: "ses-ui", timestamp: 1 },
    })
    hint()
    await vi.advanceTimersByTimeAsync(1000)
    await flush(() => original.count("/session/status") === 2)
    oldView.unmount()
    expect(runtime.listeners.size).toBe(0)
    replacement.peer = await serve()
    replacement.peer.state.projection = { type: "busy" }
    runtime.scope = "replacement-owner"
    const newView = mount()
    await vi.advanceTimersByTimeAsync(0)
    await flush(() => screen.getByTestId("status").textContent === "busy")
    held.resolve()
    await flush(() => replacement.peer!.count("/session/status") === 1)
    expect(screen.getByTestId("status").textContent).toBe("busy")
    expect(runtime.listeners.size).toBe(1)
    newView.unmount()
    expect(runtime.listeners.size).toBe(0)
  } finally {
    held.resolve()
    await replacement.peer?.close()
    await original.close()
  }
})
