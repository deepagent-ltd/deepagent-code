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
        { id: "e2", seq: 10, type: "session.execution.failed", data: { sessionID: "ses-2", error: { type: "unknown", message: "boom" } } },
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
    const fake = fakeDrain({ "ses-1": [{ id: "e1", seq: 2, type: "session.execution.started", data: { sessionID: "ses-1" } }] })
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
