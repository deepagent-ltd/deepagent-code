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

describe("recovery lifecycle (session.execution.* track)", () => {
  test("started → succeeded closes the slot with a typed record", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "execution-started", sessionID: "ses-a", timestamp: 10 })
    let state = lc.snapshot().sessions.get("ses-a")!
    expect(state.execution?.ref).toEqual({ commandId: "execution:1", attemptId: "ses-a:execution:1" })
    expect(state.execution?.startedAt).toBe(10)

    lc.onEvent({ type: "execution-succeeded", sessionID: "ses-a", timestamp: 20 })
    state = lc.snapshot().sessions.get("ses-a")!
    expect(state.execution).toBeUndefined()
    expect(state.lastExecution?.state).toBe("succeeded")
    expect(state.lastExecution?.ref.commandId).toBe("execution:1")
    expect(state.lastExecution?.at).toBe(20)
  })

  test("failed records the structured error; interrupted records its reason", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "execution-started", sessionID: "ses-a", timestamp: 10 })
    lc.onEvent({ type: "execution-failed", sessionID: "ses-a", timestamp: 11, error: { type: "unknown", message: "boom" } })
    let state = lc.snapshot().sessions.get("ses-a")!
    expect(state.lastExecution?.state).toBe("failed")
    expect((state.lastExecution?.error as { message: string }).message).toBe("boom")

    lc.onEvent({ type: "execution-started", sessionID: "ses-a", timestamp: 12 })
    lc.onEvent({ type: "execution-interrupted", sessionID: "ses-a", timestamp: 13, reason: "user" })
    state = lc.snapshot().sessions.get("ses-a")!
    expect(state.lastExecution?.state).toBe("interrupted")
    expect(state.lastExecution?.reason).toBe("user")
    expect(state.execution).toBeUndefined()
  })

  test("a started without a terminal event is closed as superseded by the next started (no zombie)", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "execution-started", sessionID: "ses-a", timestamp: 10 })
    lc.onEvent({ type: "execution-started", sessionID: "ses-a", timestamp: 11 })
    const state = lc.snapshot().sessions.get("ses-a")!
    expect(state.execution?.ref.commandId).toBe("execution:2")
    expect(state.lastExecution?.state).toBe("interrupted")
    expect(state.lastExecution?.reason).toBe("superseded")
    expect(state.lastExecution?.ref.commandId).toBe("execution:1")
  })

  test("terminal events without a start are tolerated (stream gap: no state is fabricated)", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "execution-succeeded", sessionID: "ses-gap", timestamp: 5 })
    lc.onEvent({ type: "execution-failed", sessionID: "ses-gap", timestamp: 6, error: new Error("x") })
    lc.onEvent({ type: "execution-interrupted", sessionID: "ses-gap", timestamp: 7, reason: "shutdown" })
    const state = lc.snapshot().sessions.get("ses-gap")!
    expect(state.execution).toBeUndefined()
    expect(state.lastExecution).toBeUndefined()
  })

  test("quit discards a running execution slot (no zombie), command notices unchanged", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "execution-started", sessionID: "ses-a", timestamp: 10 })
    lc.onEvent({ type: "execution-started", sessionID: "ses-a", timestamp: 12 })
    lc.onEvent({ type: "command-started", sessionID: "ses-a", command: cmd("c1") })
    lc.onEvent({ type: "quit" })
    const state = lc.snapshot().sessions.get("ses-a")!
    expect(state.execution).toBeUndefined()
    expect(state.abandonedOnQuit).toEqual({ commandId: "c1" })
  })

  test("execution track is per-session: one session's turn never leaks into another", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "execution-started", sessionID: "ses-a", timestamp: 10 })
    lc.onEvent({ type: "execution-started", sessionID: "ses-b", timestamp: 11 })
    const snap = lc.snapshot()
    expect(snap.sessions.get("ses-a")?.execution?.ref.commandId).toBe("execution:1")
    expect(snap.sessions.get("ses-b")?.execution?.ref.commandId).toBe("execution:1")
    lc.onEvent({ type: "execution-succeeded", sessionID: "ses-b", timestamp: 12 })
    expect(snap.sessions.get("ses-a")?.execution?.ref.commandId).toBe("execution:1") // unaffected
  })
})
