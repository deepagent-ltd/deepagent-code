import { describe, expect, test } from "bun:test"
import { subscribeSessionNotifications } from "./v2-notification-subscription"

// §16.5 API-APP-PACKAGE P3 — the per-session durable notification subscription contract: one
// cursor per session, journal events mapped through toNotificationEvent, close releases every
// subscription. A fake cursor client keeps the test deterministic (no EventSource).

describe("v2 notification subscription", () => {
  test("subscribes each session and routes idle/error through the mapping", () => {
    const feeds: Record<string, (event: { type?: string; data?: Record<string, unknown> }) => void> = {}
    const closed: string[] = []
    const idle: string[] = []
    const errors: string[] = []

    const unsubscribe = subscribeSessionNotifications(
      {
        session: {
          sessionEventCursor: (sessionId, input) => {
            feeds[sessionId] = input.onEvent
            return { close: () => closed.push(sessionId), url: `/api/session/${sessionId}/events` }
          },
        },
      },
      ["ses-1", "ses-2"],
      {
        onIdle: (sessionID) => idle.push(sessionID),
        onError: (sessionID) => errors.push(sessionID),
      },
    )

    feeds["ses-1"]?.({ type: "session.execution.succeeded", data: { sessionID: "ses-1" } })
    feeds["ses-2"]?.({ type: "session.execution.failed", data: { sessionID: "ses-2", error: { type: "unknown", message: "boom" } } })
    feeds["ses-1"]?.({ type: "session.next.text.delta", data: { sessionID: "ses-1" } })

    expect(idle).toEqual(["ses-1"])
    expect(errors).toEqual(["ses-2"])

    unsubscribe()
    expect(closed.sort()).toEqual(["ses-1", "ses-2"])
  })

  test("surfaces a resync without fabricating a notification", () => {
    const resynced: string[] = []
    let feed: ((event: { type?: string; data?: Record<string, unknown> }) => void) | undefined
    let onResync: (() => void) | undefined

    subscribeSessionNotifications(
      {
        session: {
          sessionEventCursor: (_sessionId, input) => {
            feed = input.onEvent
            onResync = input.onResync
            return { close: () => {}, url: "/x" }
          },
        },
      },
      ["ses-1"],
      {
        onIdle: () => {},
        onError: () => {},
        onResync: (sessionID) => resynced.push(sessionID),
      },
    )

    onResync?.()
    feed?.({ type: "session.execution.started", data: { sessionID: "ses-1" } })
    expect(resynced).toEqual(["ses-1"])
  })
})
