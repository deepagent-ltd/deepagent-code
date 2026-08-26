import { describe, expect, test } from "bun:test"
import { pruneNotifications, type Notification } from "./notification-state"

describe("pruneNotifications", () => {
  test("drops legacy filesystem-root notifications", () => {
    const time = Date.now()
    const notifications: Notification[] = [
      { type: "turn-complete", directory: "/", session: "root", time, viewed: true },
      { type: "turn-complete", directory: "C:\\", session: "drive", time, viewed: true },
      { type: "turn-complete", directory: "/project", session: "safe", time, viewed: true },
    ]

    expect(pruneNotifications(notifications)).toEqual([notifications[2]])
  })
})
