import { describe, expect, test } from "bun:test"
import { toNotificationEvent } from "./v2-notification-mapping"

// §16.5 API-APP-PACKAGE P3 — mapping contract between the V2 durable journal and the app
// notification semantics.

describe("v2 notification mapping", () => {
  test("maps settled executions to session.idle", () => {
    expect(toNotificationEvent("session.execution.succeeded", { sessionID: "ses-1" })).toEqual({
      type: "session.idle",
      sessionID: "ses-1",
    })
    expect(toNotificationEvent("session.execution.interrupted", { sessionID: "ses-1", reason: "user" })).toEqual({
      type: "session.idle",
      sessionID: "ses-1",
    })
  })

  test("maps failed executions to session.error with a fallback message", () => {
    expect(
      toNotificationEvent("session.execution.failed", { sessionID: "ses-1", error: { type: "unknown", message: "boom" } }),
    ).toEqual({ type: "session.error", sessionID: "ses-1", error: { type: "unknown", message: "boom" } })
    expect(toNotificationEvent("session.execution.failed", { sessionID: "ses-1" })).toEqual({
      type: "session.error",
      sessionID: "ses-1",
      error: { type: "unknown", message: "Session execution failed" },
    })
  })

  test("ignores journal events that carry no notification semantics", () => {
    expect(toNotificationEvent("session.next.text.delta", { sessionID: "ses-1", text: "hi" })).toBeUndefined()
    expect(toNotificationEvent("session.execution.started", { sessionID: "ses-1" })).toBeUndefined()
  })
})
