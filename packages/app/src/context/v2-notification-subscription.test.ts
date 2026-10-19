import { describe, expect, test } from "bun:test"
import { subscribeSessionNotifications } from "./v2-notification-subscription"

// C6-07 — the per-session durable notification subscription contract: one bounded poll
// loop per session over the REST drain (context.eventsCursor/events), journal events
// mapped through toNotificationEvent, seq-dedupe absorption, 410 bounded resync, and
// close stops every loop. A fake drain client keeps the test deterministic.

type EventRow = { id: string; seq: number; type: string; data?: Record<string, unknown> }

const gapError = { name: "ApiGone", data: { code: "cursor_gap_exceeded", httpStatus: 410 } }

const fakeDrain = (initial: Record<string, EventRow[]>) => {
  const watermarks = new Map<string, number>()
  const drainCount = new Map<string, number>()
  let errorResponse: unknown = undefined
  let closed = false
  const client = {
    context: {
      eventsCursor: async ({ session_id }: { session_id: string }) => ({
        data: { watermark: watermarks.get(session_id) ?? 0, cursor: 0, floor: 0 },
        error: undefined,
        response: undefined,
      }),
      events: async ({ session_id, after }: { session_id: string; after: string }) => {
        if (closed) throw new Error("closed")
        const rows = initial[session_id] ?? []
        drainCount.set(session_id, (drainCount.get(session_id) ?? 0) + 1)
        if (errorResponse !== undefined) return { data: undefined, error: errorResponse, response: undefined }
        const events = rows.filter((row) => row.seq > Number(after))
        return {
          data: { events, nextCursor: events.at(-1)?.seq ?? Number(after), floor: 0 },
          error: undefined,
          response: undefined,
        }
      },
    },
  }
  return {
    client,
    watermarks,
    errors: { set: (value: unknown) => (errorResponse = value) },
    drainCount,
    close: () => (closed = true),
  }
}

describe("v2 notification subscription (durable drain)", () => {
  test("subscribes each session and routes idle/error through the mapping", async () => {
    const fake = fakeDrain({
      "ses-1": [{ id: "e1", seq: 8, type: "session.execution.succeeded", data: { sessionID: "ses-1" } }],
      "ses-2": [
        {
          id: "e2",
          seq: 10,
          type: "session.execution.failed",
          data: { sessionID: "ses-2", error: { type: "unknown", message: "boom" } },
        },
      ],
    })
    fake.watermarks.set("ses-1", 7)
    fake.watermarks.set("ses-2", 9)
    const idle: string[] = []
    const errors: string[] = []
    const unsubscribe = subscribeSessionNotifications(
      fake.client,
      ["ses-1", "ses-2"],
      {
        onIdle: (sessionID) => idle.push(sessionID),
        onError: (sessionID) => errors.push(sessionID),
      },
      undefined,
      5,
    )
    await Bun.sleep(30)
    expect(idle).toEqual(["ses-1"])
    expect(errors).toEqual(["ses-2"])

    fake.close()
    unsubscribe()
  })

  test("a typed 410 (cursor_gap_exceeded) surfaces a bounded resync without fabricating a notification", async () => {
    const fake = fakeDrain({
      "ses-1": [{ id: "e1", seq: 2, type: "session.execution.started", data: { sessionID: "ses-1" } }],
    })
    const originalEvents = fake.client.context.events
    let first = true
    fake.client.context.events = async (parameters: { session_id: string; after: string }) => {
      if (first) {
        first = false
        fake.errors.set(gapError)
      }
      const result = await originalEvents(parameters)
      fake.errors.set(undefined) // one-shot gap: subsequent ticks drain normally
      return result
    }
    const resynced: string[] = []
    const idle: string[] = []
    const unsubscribe = subscribeSessionNotifications(
      fake.client,
      ["ses-1"],
      {
        onIdle: (sessionID) => idle.push(sessionID),
        onError: () => {},
        onResync: (sessionID) => resynced.push(sessionID),
      },
      undefined,
      5,
    )
    await Bun.sleep(30)
    expect(resynced).toEqual(["ses-1"])
    expect(idle).toEqual([]) // the resync must not fabricate a notification

    fake.close()
    unsubscribe()
  })

  test("duplicates are absorbed by seq (order-preserving) and close stops delivery", async () => {
    const fake = fakeDrain({
      "ses-1": [
        { id: "e1", seq: 5, type: "session.execution.started", data: { sessionID: "ses-1" } },
        { id: "e2", seq: 6, type: "session.execution.succeeded", data: { sessionID: "ses-1" } },
        { id: "e3", seq: 6, type: "session.execution.succeeded", data: { sessionID: "ses-1" } },
      ],
    })
    const idle: string[] = []
    const unsubscribe = subscribeSessionNotifications(
      fake.client,
      ["ses-1"],
      {
        onIdle: (sessionID) => idle.push(sessionID),
        onError: () => {},
        onJournalEvent: () => {},
      },
      { after: () => "5" },
      5,
    )
    await Bun.sleep(30)
    expect(idle).toEqual(["ses-1"]) // seq 6 delivered once (dedupe); started is not an idle

    fake.close()
    unsubscribe()
    fake.client.context.events = async () => {
      throw new Error("delivery after close")
    }
    await Bun.sleep(20) // no unhandled rejection — the loop is stopped
  })
})

test("real REST interruption rows advance the cursor across duplicate drains and resumed subscriptions", async () => {
  const { createOpencodeClient } = await import("@deepagent-code/sdk")
  const { createServer } = await import("node:http")
  const rows: EventRow[] = [
    ...["user", "shutdown", "superseded"].map((reason, index) => ({
      id: `interrupt-${reason}`,
      seq: index + 1,
      type: "session.execution.interrupted.1",
      data: { sessionID: "ses-1", reason },
    })),
    { id: "success", seq: 4, type: "session.execution.succeeded.1", data: { sessionID: "ses-1" } },
    {
      id: "failure",
      seq: 5,
      type: "session.execution.failed.1",
      data: { sessionID: "ses-1", error: { type: "unknown", message: "provider failure" } },
    },
    {
      id: "duplicate-failure",
      seq: 5,
      type: "session.execution.failed.1",
      data: { sessionID: "ses-1", error: { type: "unknown", message: "duplicate" } },
    },
    { id: "next-start", seq: 6, type: "session.execution.started.1", data: { sessionID: "ses-1" } },
  ]
  const requests: string[] = []
  const consumed: number[] = []
  const idle: string[] = []
  const failures: string[] = []
  const duplicateDrain = Promise.withResolvers<void>()
  const resumedDrain = Promise.withResolvers<void>()
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1")
    response.setHeader("Content-Type", "application/json")
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "*")
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET")
      response.setHeader(
        "Access-Control-Allow-Headers",
        request.headers["access-control-request-headers"] ?? "content-type",
      )
      response.writeHead(204).end()
      return
    }
    if (url.pathname === "/context/eventsCursor") {
      response.end(JSON.stringify({ watermark: 0, cursor: 0, floor: 0 }))
      return
    }
    if (url.pathname !== "/context/events") {
      response.writeHead(404).end()
      return
    }
    requests.push(url.searchParams.get("after") ?? "")
    const afterTerminal = requests.filter((after) => after === "6").length
    if (afterTerminal === 2) duplicateDrain.resolve()
    if (afterTerminal === 4) resumedDrain.resolve()
    // Repeated pages deliberately include earlier terminal rows; only seq authority
    // decides whether they can notify again, including after rebuilding a subscriber.
    response.end(JSON.stringify({ events: rows, nextCursor: 6, floor: 0 }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture listener address")
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  const handlers = {
    onIdle: (sessionID: string) => idle.push(sessionID),
    onError: (_sessionID: string, error: { message: string }) => failures.push(error.message),
    onJournalEvent: (_sessionID: string, event: { seq: number }) => consumed.push(event.seq),
  }
  let close = subscribeSessionNotifications(client, ["ses-1"], handlers, { after: () => "0" }, 1)
  try {
    await duplicateDrain.promise
    expect(consumed).toEqual([1, 2, 3, 4, 5, 6])
    expect(idle).toEqual(["ses-1"])
    expect(failures).toEqual(["provider failure"])
    expect(requests.slice(0, 3)).toEqual(["0", "6", "6"])
    close()
    close = subscribeSessionNotifications(client, ["ses-1"], handlers, { after: () => String(consumed.at(-1)) }, 1)
    await resumedDrain.promise
    expect(consumed).toEqual([1, 2, 3, 4, 5, 6])
    expect(idle).toEqual(["ses-1"])
    expect(failures).toEqual(["provider failure"])
  } finally {
    close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("the existing REST consumer delivers a hidden session's terminal rows once before focus returns", async () => {
  const { createOpencodeClient } = await import("@deepagent-code/sdk")
  const { createServer } = await import("node:http")
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState")
  const visibility = { state: "visible" }
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility.state })
  const rows: EventRow[] = [
    { id: "start", seq: 1, type: "session.execution.started.1", data: { sessionID: "ses-hidden" } },
  ]
  const requests: string[] = []
  const consumed: number[] = []
  const idle: string[] = []
  const errors: string[] = []
  const anchored = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<void>()
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1")
    response.setHeader("Content-Type", "application/json")
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "*")
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET")
      response.setHeader(
        "Access-Control-Allow-Headers",
        request.headers["access-control-request-headers"] ?? "content-type",
      )
      response.writeHead(204).end()
      return
    }
    if (url.pathname === "/context/eventsCursor") {
      response.end(JSON.stringify({ watermark: 0, cursor: 0, floor: 0 }))
      return
    }
    if (url.pathname !== "/context/events") {
      response.writeHead(404).end()
      return
    }
    requests.push(url.searchParams.get("after") ?? "")
    response.end(JSON.stringify({ events: rows, nextCursor: rows.at(-1)?.seq ?? 0, floor: 0 }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing hidden-session listener address")
  const close = subscribeSessionNotifications(
    createOpencodeClient({ baseUrl: `http://127.0.0.1:${address.port}` }),
    ["ses-hidden"],
    {
      onIdle: (sessionID) => idle.push(sessionID),
      onError: (_sessionID, error) => {
        errors.push(error.message)
        completed.resolve()
      },
      onJournalEvent: (_sessionID, event) => {
        consumed.push(event.seq)
        if (event.seq === 1) anchored.resolve()
      },
    },
    undefined,
    5,
  )
  try {
    expect(await Promise.race([anchored.promise.then(() => true), Bun.sleep(1000).then(() => false)])).toBe(true)
    visibility.state = "hidden"
    document.dispatchEvent(new Event("visibilitychange"))
    rows.push(
      { id: "success", seq: 2, type: "session.execution.succeeded.1", data: { sessionID: "ses-hidden" } },
      {
        id: "failure",
        seq: 3,
        type: "session.execution.failed.1",
        data: { sessionID: "ses-hidden", error: { type: "unknown", message: "hidden provider failure" } },
      },
      { id: "duplicate", seq: 3, type: "session.execution.succeeded.1", data: { sessionID: "ses-hidden" } },
    )
    expect(await Promise.race([completed.promise.then(() => true), Bun.sleep(500).then(() => false)])).toBe(true)
    expect(idle).toEqual(["ses-hidden"])
    expect(errors).toEqual(["hidden provider failure"])
    expect(consumed).toEqual([1, 2, 3])
    expect(document.visibilityState).toBe("hidden")

    visibility.state = "visible"
    document.dispatchEvent(new Event("visibilitychange"))
    await Bun.sleep(30)
    expect(requests.filter((after) => after === "3").length).toBeGreaterThan(0)
    expect(idle).toEqual(["ses-hidden"])
    expect(errors).toEqual(["hidden provider failure"])
    expect(consumed).toEqual([1, 2, 3])
  } finally {
    close()
    if (original) Object.defineProperty(document, "visibilityState", original)
    if (!original) Reflect.deleteProperty(document, "visibilityState")
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
