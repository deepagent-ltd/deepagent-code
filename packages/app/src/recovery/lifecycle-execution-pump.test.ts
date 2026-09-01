import { describe, expect, test } from "bun:test"
import { createRecoveryLifecycle } from "./recovery-lifecycle-state"
import { subscribeExecutionEvents, toLifecycleEvent, type ExecutionEventInput } from "./lifecycle-execution-pump"

// C6-11 — the real-event pump: `SessionEvent.Execution.*` wire shapes map to `LifecycleEvent`s
// and a live source subscription drives the reducer, order-preserving and type-safe.

const sse = (type: string, properties: Record<string, unknown>): ExecutionEventInput => ({
  type,
  properties: { timestamp: 1000, ...properties },
})

const drain = (type: string, data: Record<string, unknown>): ExecutionEventInput => ({
  type,
  data: { timestamp: 1000, ...data },
})

describe("toLifecycleEvent (SessionEvent.Execution.* mapping)", () => {
  test("maps session.execution.started from the SSE shape", () => {
    const mapped = toLifecycleEvent(sse("session.execution.started", { sessionID: "ses-a" }))
    expect(mapped).toEqual({ type: "execution-started", sessionID: "ses-a", timestamp: 1000 })
  })

  test("maps session.execution.succeeded from the SSE shape", () => {
    const mapped = toLifecycleEvent(sse("session.execution.succeeded", { sessionID: "ses-a" }))
    expect(mapped).toEqual({ type: "execution-succeeded", sessionID: "ses-a", timestamp: 1000 })
  })

  test("maps session.execution.failed with the structured error", () => {
    const mapped = toLifecycleEvent(
      sse("session.execution.failed", { sessionID: "ses-a", error: { type: "unknown", message: "boom" } }),
    )
    expect(mapped).toEqual({
      type: "execution-failed",
      sessionID: "ses-a",
      timestamp: 1000,
      error: { type: "unknown", message: "boom" },
    })
  })

  test("maps session.execution.interrupted with its reason", () => {
    const mapped = toLifecycleEvent(sse("session.execution.interrupted", { sessionID: "ses-a", reason: "superseded" }))
    expect(mapped).toEqual({ type: "execution-interrupted", sessionID: "ses-a", timestamp: 1000, reason: "superseded" })
  })

  test("accepts the durable drain row shape ({type, data})", () => {
    const mapped = toLifecycleEvent(drain("session.execution.started", { sessionID: "ses-b" }))
    expect(mapped).toEqual({ type: "execution-started", sessionID: "ses-b", timestamp: 1000 })
  })

  test("drops non-execution events and payloads without a sessionID", () => {
    expect(toLifecycleEvent(sse("session.status", { sessionID: "ses-a" }))).toBeUndefined()
    expect(toLifecycleEvent(sse("session.execution.started", {}))).toBeUndefined()
    expect(toLifecycleEvent({ type: "session.execution.started", properties: "nope" })).toBeUndefined()
  })

  test("unknown interrupt reason falls back to user (never crashes the reducer)", () => {
    const mapped = toLifecycleEvent(sse("session.execution.interrupted", { sessionID: "ses-a", reason: "weird" }))
    expect(mapped).toEqual({ type: "execution-interrupted", sessionID: "ses-a", timestamp: 1000, reason: "user" })
  })
})

const fakeSource = () => {
  let handler: ((event: { name: string; details: unknown }) => void) | undefined
  const source = {
    listen(next: (event: { name: string; details: unknown }) => void) {
      handler = next
      return () => {
        handler = undefined
      }
    },
    emit(event: { name: string; details: unknown }) {
      handler?.(event)
    },
  }
  return source
}

describe("subscribeExecutionEvents (pump)", () => {
  test("execution start → success updates the per-session execution track", () => {
    const lifecycle = createRecoveryLifecycle()
    const source = fakeSource()
    const stop = subscribeExecutionEvents(source, lifecycle)

    source.emit({ name: "session.execution.started", details: sse("session.execution.started", { sessionID: "ses-a" }) })
    let state = lifecycle.snapshot().sessions.get("ses-a")!
    expect(state.execution?.ref.commandId).toBe("execution:1")

    source.emit({ name: "session.execution.succeeded", details: sse("session.execution.succeeded", { sessionID: "ses-a" }) })
    state = lifecycle.snapshot().sessions.get("ses-a")!
    expect(state.execution).toBeUndefined()
    expect(state.lastExecution?.state).toBe("succeeded")
    expect(state.lastExecution?.ref.commandId).toBe("execution:1")

    stop()
  })

  test("failure records the structured error and closes the slot", () => {
    const lifecycle = createRecoveryLifecycle()
    const source = fakeSource()
    subscribeExecutionEvents(source, lifecycle)

    source.emit({ name: "session.execution.started", details: sse("session.execution.started", { sessionID: "ses-a" }) })
    source.emit({
      name: "session.execution.failed",
      details: sse("session.execution.failed", { sessionID: "ses-a", error: { type: "unknown", message: "boom" } }),
    })
    const state = lifecycle.snapshot().sessions.get("ses-a")!
    expect(state.execution).toBeUndefined()
    expect(state.lastExecution?.state).toBe("failed")
    expect((state.lastExecution?.error as { message: string }).message).toBe("boom")
  })

  test("a superseded turn closes the previous slot as interrupted (no stuck running)", () => {
    const lifecycle = createRecoveryLifecycle()
    const source = fakeSource()
    subscribeExecutionEvents(source, lifecycle)

    source.emit({ name: "session.execution.started", details: sse("session.execution.started", { sessionID: "ses-a" }) })
    source.emit({ name: "session.execution.started", details: sse("session.execution.started", { sessionID: "ses-a" }) })
    const state = lifecycle.snapshot().sessions.get("ses-a")!
    expect(state.execution?.ref.commandId).toBe("execution:2")
    expect(state.lastExecution?.state).toBe("interrupted")
    expect(state.lastExecution?.reason).toBe("superseded")
    expect(state.lastExecution?.ref.commandId).toBe("execution:1")
  })

  test("non-execution events are ignored; unsubscribe stops delivery", () => {
    const lifecycle = createRecoveryLifecycle()
    const source = fakeSource()
    const stop = subscribeExecutionEvents(source, lifecycle)

    source.emit({ name: "session.status", details: sse("session.status", { sessionID: "ses-a" }) })
    expect(lifecycle.snapshot().sessions.size).toBe(0)

    stop()
    source.emit({ name: "session.execution.started", details: sse("session.execution.started", { sessionID: "ses-a" }) })
    expect(lifecycle.snapshot().sessions.size).toBe(0)
  })

  test("onEvent callback fires once per mapped event (reactivity hook)", () => {
    const lifecycle = createRecoveryLifecycle()
    const source = fakeSource()
    let calls = 0
    subscribeExecutionEvents(source, lifecycle, () => {
      calls += 1
    })

    source.emit({ name: "session.execution.started", details: sse("session.execution.started", { sessionID: "ses-a" }) })
    source.emit({ name: "session.status", details: sse("session.status", { sessionID: "ses-a" }) })
    source.emit({ name: "session.execution.succeeded", details: sse("session.execution.succeeded", { sessionID: "ses-a" }) })
    expect(calls).toBe(2)
  })
})
