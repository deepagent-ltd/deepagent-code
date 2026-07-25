import { describe, expect, test } from "bun:test"
import { startupViewReady } from "./startup-ready"

const ready = {
  pathname: "/project/session/session-1",
  serverReady: true,
  globalReady: true,
  globalError: false,
  restoreSettled: true,
  directory: "/workspace/project",
  directoryReady: true,
  sessionId: "session-1",
  hasSession: true,
  messagesReady: true,
}

describe("startup view readiness", () => {
  test("keeps the home route covered while the persisted project is restoring", () => {
    expect(
      startupViewReady({
        ...ready,
        pathname: "/",
        directory: undefined,
        sessionId: undefined,
        restoreSettled: false,
      }),
    ).toBe(false)
    expect(startupViewReady({ ...ready, pathname: "/", directory: undefined, sessionId: undefined })).toBe(true)
  })

  test("waits for global and directory synchronization", () => {
    expect(startupViewReady({ ...ready, serverReady: false })).toBe(false)
    expect(startupViewReady({ ...ready, globalReady: false })).toBe(false)
    expect(startupViewReady({ ...ready, restoreSettled: false })).toBe(false)
    expect(startupViewReady({ ...ready, directoryReady: false })).toBe(false)
  })

  test("requires restored session metadata and initial messages", () => {
    expect(startupViewReady(ready)).toBe(true)
    expect(startupViewReady({ ...ready, hasSession: false })).toBe(false)
    expect(startupViewReady({ ...ready, messagesReady: false })).toBe(false)
  })

  test("allows a synchronized new-session route and server error state", () => {
    expect(startupViewReady({ ...ready, sessionId: undefined })).toBe(true)
    expect(startupViewReady({ ...ready, globalReady: false, globalError: true })).toBe(true)
  })
})
