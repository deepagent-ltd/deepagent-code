import { describe, expect, test } from "bun:test"
import { createRecoveryLifecycle } from "./recovery-lifecycle-state"

// C6-11 — the recovery/session dynamic lifecycle matrix (fixture): session switch preserves
// cursor + unfinished command; sleep/wake resumes idempotently; quit with an in-flight command
// discards it with a typed notice (no zombies); reconnect resumes without data loss; one
// Session's blocked/queued command never locks another.

const cmd = (id: string) => ({ commandId: id, attemptId: `att_${id}` })

describe("recovery lifecycle (switch / sleep-wake / quit / reconnect)", () => {
  test("session switch keeps the cursor and the unfinished command per session", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "session-switch", sessionID: "ses-a", cursor: 42 })
    lc.onEvent({ type: "command-started", sessionID: "ses-a", command: cmd("c1") })
    lc.onEvent({ type: "session-switch", sessionID: "ses-b", cursor: 7 })

    const snap = lc.snapshot()
    expect(snap.sessions.get("ses-a")?.cursor).toBe(42)
    expect(snap.sessions.get("ses-a")?.inflight?.commandId).toBe("c1")
    expect(snap.sessions.get("ses-a")?.queue).toEqual([])
    expect(snap.sessions.get("ses-b")?.cursor).toBe(7)
    expect(snap.sessions.get("ses-b")?.inflight).toBeUndefined()
  })

  test("serial queue: a command started while one is in flight is queued, never dropped", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "session-switch", sessionID: "ses-a", cursor: 0 })
    lc.onEvent({ type: "command-started", sessionID: "ses-a", command: cmd("c1") })
    lc.onEvent({ type: "command-started", sessionID: "ses-a", command: cmd("c2") })
    const snap = lc.snapshot()
    expect(snap.sessions.get("ses-a")?.inflight?.commandId).toBe("c1")
    expect(snap.sessions.get("ses-a")?.queue.map((c) => c.commandId)).toEqual(["c2"])

    lc.onEvent({
      type: "command-completed",
      sessionID: "ses-a",
      commandId: "c1",
      result: { command_id: "c1", descriptor: {} as never },
    })
    // c2 advanced to in-flight — the completion of c1 is never lost.
    const after = lc.snapshot()
    expect(after.sessions.get("ses-a")?.inflight?.commandId).toBe("c2")
    expect(after.sessions.get("ses-a")?.lastResult?.commandId).toBe("c1")
  })

  test("sleep/wake: wake resumes from the preserved cursor — no duplicate result", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "session-switch", sessionID: "ses-a", cursor: 42 })
    lc.onEvent({ type: "command-completed", sessionID: "ses-a", commandId: "c1", result: { command_id: "c1", descriptor: {} as never } })
    lc.onEvent({ type: "sleep" })
    expect(lc.snapshot().suspended).toBe(true)
    lc.onEvent({ type: "wake" })
    const snap = lc.snapshot()
    expect(snap.suspended).toBe(false)
    expect(snap.sessions.get("ses-a")?.cursor).toBe(42) // unchanged → re-drain cannot re-deliver
    expect(snap.sessions.get("ses-a")?.lastResult?.commandId).toBe("c1")
  })

  test("quit with an in-flight command discards it with a typed notice (no zombies)", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "session-switch", sessionID: "ses-a", cursor: 5 })
    lc.onEvent({ type: "command-started", sessionID: "ses-a", command: cmd("c1") })
    lc.onEvent({ type: "command-started", sessionID: "ses-a", command: cmd("c2") })
    lc.onEvent({ type: "quit" })
    const snap = lc.snapshot()
    expect(snap.sessions.get("ses-a")?.abandonedOnQuit).toEqual({ commandId: "c1" })
    expect(snap.sessions.get("ses-a")?.inflight).toBeUndefined()
    expect(snap.sessions.get("ses-a")?.queue).toEqual([])
  })

  test("reconnect: paused → resume from the last cursor (no data loss, no feedback loop)", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "session-switch", sessionID: "ses-a", cursor: 9 })
    lc.onEvent({ type: "disconnect" })
    expect(lc.snapshot().disconnected).toBe(true)
    lc.onEvent({ type: "reconnect" })
    const snap = lc.snapshot()
    expect(snap.disconnected).toBe(false)
    expect(snap.sessions.get("ses-a")?.cursor).toBe(9)
  })

  test("cross-session isolation: a blocked session never locks another session", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "session-switch", sessionID: "ses-blocked", cursor: 1 })
    lc.onEvent({ type: "command-started", sessionID: "ses-blocked", command: cmd("b1") })
    lc.onEvent({ type: "command-failed", sessionID: "ses-blocked", commandId: "b1", error: new Error("blocked") })

    lc.onEvent({ type: "session-switch", sessionID: "ses-free", cursor: 2 })
    lc.onEvent({ type: "command-started", sessionID: "ses-free", command: cmd("f1") })
    const snap = lc.snapshot()
    expect(snap.sessions.get("ses-blocked")?.lastError?.commandId).toBe("b1")
    expect(snap.sessions.get("ses-free")?.inflight?.commandId).toBe("f1") // unaffected
  })
})
