import { describe, expect, test } from "bun:test"
import { createNotificationJournalSubscription } from "./notification-journal"

// §16.5 API-APP-PACKAGE P5 — the notification feed replacement: the durable per-session
// journals of the active directory drive idle/error notifications with a stable directory
// mapping; cursors anchor at the session watermark (first subscribe) or the last seen seq
// (rebuild) so nothing re-replays history; resync forces a rebuild past the set-equality
// guard; dispose closes every cursor.

const fakeClient = () => {
  const events = new Map<string,(event: { type?: string; seq?: number; data?: Record<string, unknown> }) => void>()
  const resyncs = new Map<string, () => void>()
  const errorHandlers = new Map<string, (error: unknown) => void>()
  const subscriptions: { sessionId: string; after?: string }[] = []
  const closed: string[] = []
  const watermarks = new Map<string, number | undefined>()
  const client = {
    session: {
      sessionEventCursor: (sessionId: string, input: {
        readonly after?: string
        readonly onEvent: (event: { type?: string; seq?: number; data?: Record<string, unknown> }) => void
        readonly onResync?: () => void
        readonly onError?: (error: unknown) => void
      }) => {
        subscriptions.push({ sessionId, after: input.after })
        events.set(sessionId, input.onEvent)
        if (input.onResync) resyncs.set(sessionId, input.onResync)
        if (input.onError) errorHandlers.set(sessionId, input.onError)
        return { close: () => closed.push(sessionId), url: "" }
      },
      sessionEventWatermark: async (sessionId: string) => watermarks.get(sessionId)
    },
  }
  return { client, events, resyncs, errorHandlers, subscriptions, closed, watermarks }
}

describe("notification journal subscription", async () => {
  test("subscribes the active directory sessions anchored at the watermark and routes idle/error", async () => {
    const fake = fakeClient()
    fake.watermarks.set("ses-1", 7)
    fake.watermarks.set("ses-2", 9)
    const idle: string[] = []
    const errors: string[] = []
    const journal = createNotificationJournalSubscription({
      client: fake.client,
      currentDirectory: () => "/workspace",
      sessionsOf: (directory) => (directory === "/workspace" ? ["ses-1", "ses-2"] : []),
      handlers: {
        onIdle: (directory, sessionID, time) => idle.push(`${directory}:${sessionID}:${time}`),
        onError: (directory, sessionID, error, time) =>
          errors.push(`${directory}:${sessionID}:${(error as { message: string }).message}`),
      },
    })

    journal.refresh()
    await Bun.sleep(5)
    expect(fake.subscriptions.map((item) => item.after)).toEqual(["7", "9"])
    fake.events.get("ses-1")?.({ type: "session.execution.succeeded", seq: 8, data: { sessionID: "ses-1" } })
    fake.events.get("ses-2")?.({
      type: "session.execution.failed",
      seq: 10,
      data: { sessionID: "ses-2", error: { type: "unknown", message: "boom" } },
    })

    expect(idle).toHaveLength(1)
    expect(idle[0]?.startsWith("/workspace:ses-1")).toBe(true)
    expect(errors).toEqual(["/workspace:ses-2:boom"])
    journal.dispose()
    expect(fake.closed.sort()).toEqual(["ses-1", "ses-2"])
  })

  test("rebuild anchors at the last seen seq instead of re-replaying history", async () => {
    const fake = fakeClient()
    fake.watermarks.set("ses-1", 7)
    let sessions: string[] = ["ses-1"]
    const journal = createNotificationJournalSubscription({
      client: fake.client,
      currentDirectory: () => "/workspace",
      sessionsOf: () => sessions,
      handlers: { onIdle: () => {}, onError: () => {} },
    })

    journal.refresh()
    await Bun.sleep(5)
    expect(fake.subscriptions).toEqual([{ sessionId: "ses-1", after: "7" }])
    fake.events.get("ses-1")?.({ type: "session.execution.started", seq: 8, data: { sessionID: "ses-1" } })

    sessions = ["ses-1", "ses-2"]
    fake.watermarks.set("ses-2", 0)
    journal.refresh()
    await Bun.sleep(5)
    expect(fake.subscriptions).toEqual([
      { sessionId: "ses-1", after: "7" },
      { sessionId: "ses-1", after: "8" },
      { sessionId: "ses-2", after: "0" },
    ])
    expect(fake.closed).toEqual(["ses-1"])
    journal.dispose()
  })

  test("a seq gap forces a rebuild past the set-equality guard", async () => {
    const fake = fakeClient()
    fake.watermarks.set("ses-1", 7)
    const journal = createNotificationJournalSubscription({
      client: fake.client,
      currentDirectory: () => "/workspace",
      sessionsOf: () => ["ses-1"],
      handlers: { onIdle: () => {}, onError: () => {} },
    })

    journal.refresh()
    await Bun.sleep(5)
    journal.refresh()
    expect(fake.subscriptions).toHaveLength(1)

    // Simulate the cursor signalling a gap: the rebuild must re-anchor at the last seq.
    fake.events.get("ses-1")?.({ type: "session.execution.started", seq: 9, data: { sessionID: "ses-1" } })
    fake.resyncs.get("ses-1")?.()
    await Bun.sleep(5)
    expect(fake.subscriptions).toHaveLength(2)
    expect(fake.subscriptions[1]?.after).toBe("9")
    journal.dispose()
  })

  test("drops the subscription when the directory becomes unknown", async () => {
    const fake = fakeClient()
    let directory: string | undefined = "/workspace"
    const journal = createNotificationJournalSubscription({
      client: fake.client,
      currentDirectory: () => directory,
      sessionsOf: () => ["ses-1"],
      handlers: { onIdle: () => {}, onError: () => {} },
    })

    journal.refresh()
    await Bun.sleep(5)
    expect(fake.subscriptions).toHaveLength(1)
    directory = undefined
    journal.refresh()
    expect(fake.closed).toEqual(["ses-1"])
    journal.dispose()
  })

  test("routes cursor errors through the onErrorEvent surface", async () => {
    const fake = fakeClient()
    const seen: unknown[] = []
    const journal = createNotificationJournalSubscription({
      client: fake.client,
      currentDirectory: () => "/workspace",
      sessionsOf: () => ["ses-1"],
      handlers: { onIdle: () => {}, onError: () => {}, onErrorEvent: (error) => seen.push(error) },
    })

    journal.refresh()
    await Bun.sleep(5)
    fake.errorHandlers.get("ses-1")?.(new Error("boom"))
    expect(seen).toEqual([new Error("boom")])
    journal.dispose()
  })
})