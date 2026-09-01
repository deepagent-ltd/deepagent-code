import { describe, expect, test } from "bun:test"
import { createRecoveryLifecycle } from "./recovery-lifecycle-state"
import {
  createExecutionJournalSubscription,
  subscribeExecutionEvents,
  toLifecycleEvent,
  type ExecutionEventInput,
  type ExecutionJournalClient,
  type ExecutionJournalRow,
} from "./lifecycle-execution-pump"

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

  test("accepts the VERSIONED durable row type (EventTable.type = versionedType)", () => {
    // W9.5 — the journal persists `session.execution.started.1` (EventV2.versionedType); the
    // pump maps the version-stripped name while keeping the `data` payload.
    expect(toLifecycleEvent(drain("session.execution.started.1", { sessionID: "ses-c" }))).toEqual({
      type: "execution-started",
      sessionID: "ses-c",
      timestamp: 1000,
    })
    expect(toLifecycleEvent(drain("session.execution.succeeded.1", { sessionID: "ses-c" }))).toEqual({
      type: "execution-succeeded",
      sessionID: "ses-c",
      timestamp: 1000,
    })
    expect(toLifecycleEvent(drain("session.execution.failed.1", { sessionID: "ses-c", error: { message: "boom" } }))).toEqual({
      type: "execution-failed",
      sessionID: "ses-c",
      timestamp: 1000,
      error: { message: "boom" },
    })
    expect(toLifecycleEvent(drain("session.execution.interrupted.1", { sessionID: "ses-c", reason: "shutdown" }))).toEqual({
      type: "execution-interrupted",
      sessionID: "ses-c",
      timestamp: 1000,
      reason: "shutdown",
    })
    // A versioned NON-execution row stays filtered (no accidental vocabulary drift).
    expect(toLifecycleEvent(drain("session.next.text.ended.1", { sessionID: "ses-c" }))).toBeUndefined()
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

// W9.5 — durable journal drive (context.eventsCursor/events poll). The journal is the PRIMARY
// execution source under V2 admission ON (the SSE mirror is skipped there).

const row = (seq: number, type: string, data: Record<string, unknown>): ExecutionJournalRow => ({
  id: `ev-${seq}`,
  seq,
  type,
  data: { timestamp: 1000, ...data },
})

const waitFor = async (check: () => boolean | Promise<boolean>, message: string, timeoutMs = 2000) => {
  const started = Date.now()
  while (true) {
    if (await check()) return
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const typedGap = () => ({
  schemaVersion: "stable-error.v1",
  code: "cursor_gap_exceeded",
  category: "cursor",
  httpStatus: 410,
  resource: "ses-a",
  message: "cursor below retained floor",
})

describe("createExecutionJournalSubscription (durable drain)", () => {
  test("first drain anchors at the watermark; following drains resume from the last seen seq", async () => {
    const lifecycle = createRecoveryLifecycle()
    const afterCalls: string[] = []
    let page = 0
    const client: ExecutionJournalClient = {
      context: {
        eventsCursor: async () => ({ data: { watermark: 10, cursor: 10, floor: 5 } }),
        events: async ({ after }) => {
          afterCalls.push(after)
          page += 1
          if (page === 1) {
            return {
              data: {
                events: [row(11, "session.execution.started.1", { sessionID: "ses-a" }), row(12, "session.execution.succeeded.1", { sessionID: "ses-a" })],
              },
            }
          }
          return { data: { events: [] } }
        },
      },
    }
    const journals = createExecutionJournalSubscription(
      { client, sessionIDs: () => ["ses-a"], lifecycle },
      10,
    )
    try {
      await waitFor(() => afterCalls.length >= 2, "journal never drained")
      expect(afterCalls[0]).toBe("10") // watermark anchor (never a history replay at mount)
      expect(afterCalls[1]).toBe("12") // seq-resume from the last seen row
      const state = lifecycle.snapshot().sessions.get("ses-a")!
      expect(state.lastExecution?.state).toBe("succeeded")
      expect(state.lastExecution?.number).toBe(1)
    } finally {
      journals.dispose()
    }
  })

  test("seq-dedupe absorbs a duplicated page (no double delivery)", async () => {
    const lifecycle = createRecoveryLifecycle()
    let page = 0
    const client: ExecutionJournalClient = {
      context: {
        eventsCursor: async () => ({ data: { watermark: 10, cursor: 10, floor: 5 } }),
        events: async () => {
          page += 1
          if (page === 1) {
            return { data: { events: [row(11, "session.execution.started.1", { sessionID: "ses-a" }), row(12, "session.execution.succeeded.1", { sessionID: "ses-a" })] } }
          }
          return {
            data: {
              events: [
                row(11, "session.execution.started.1", { sessionID: "ses-a" }),
                row(12, "session.execution.succeeded.1", { sessionID: "ses-a" }),
                row(13, "session.execution.started.1", { sessionID: "ses-a" }),
                row(14, "session.execution.succeeded.1", { sessionID: "ses-a" }),
              ],
            },
          }
        },
      },
    }
    const journals = createExecutionJournalSubscription({ client, sessionIDs: () => ["ses-a"], lifecycle }, 10)
    try {
      await waitFor(() => lifecycle.snapshot().sessions.get("ses-a")?.lastExecution?.number === 2, "turn 2 never closed")
      const state = lifecycle.snapshot().sessions.get("ses-a")!
      expect(state.execution).toBeUndefined()
      expect(state.lastExecution?.number).toBe(2) // duplicates did NOT open phantom turns
      expect(state.lastExecution?.state).toBe("succeeded")
    } finally {
      journals.dispose()
    }
  })

  test("network failure flips connectivity and recovery resumes from the last cursor (no re-anchor)", async () => {
    const lifecycle = createRecoveryLifecycle()
    const afterCalls: string[] = []
    const transitions: boolean[] = []
    let page = 0
    const client: ExecutionJournalClient = {
      context: {
        eventsCursor: async () => ({ data: { watermark: 10, cursor: 10, floor: 5 } }),
        events: async ({ after }) => {
          afterCalls.push(after)
          page += 1
          if (page === 1) return { data: { events: [row(11, "session.execution.started.1", { sessionID: "ses-a" })] } }
          if (page === 2) throw new TypeError("network unreachable")
          return { data: { events: [row(12, "session.execution.succeeded.1", { sessionID: "ses-a" })] } }
        },
      },
    }
    const journals = createExecutionJournalSubscription(
      {
        client,
        sessionIDs: () => ["ses-a"],
        lifecycle,
        handlers: { onConnectionChange: (connected) => transitions.push(connected) },
      },
      10,
    )
    try {
      await waitFor(() => transitions.length >= 2, "connection transitions never fired")
      expect(transitions).toEqual([false, true])
      // The reconnect resumed from the last cursor: the failing tick never re-anchored.
      const resumeCall = afterCalls[2]
      expect(resumeCall).toBe("11")
      const state = lifecycle.snapshot().sessions.get("ses-a")!
      expect(state.lastExecution?.state).toBe("succeeded")
      expect(state.lastExecution?.number).toBe(1)
    } finally {
      journals.dispose()
    }
  })

  test("a typed 410 resync re-anchors at the retained floor (no connectivity flip)", async () => {
    const lifecycle = createRecoveryLifecycle()
    const afterCalls: string[] = []
    const transitions: boolean[] = []
    let page = 0
    let cursorReads = 0
    const client: ExecutionJournalClient = {
      context: {
        eventsCursor: async () => {
          cursorReads += 1
          // Between the first drain and the 410 the server pruned rows up to floor=15: the
          // stale anchor (12) falls behind it, and the missed window is exactly the unseen rows.
          return cursorReads === 1
            ? { data: { watermark: 10, cursor: 10, floor: 5 } }
            : { data: { watermark: 17, cursor: 17, floor: 15 } }
        },
        events: async ({ after }) => {
          afterCalls.push(after)
          page += 1
          if (page === 1) return { data: { events: [row(11, "session.execution.started.1", { sessionID: "ses-a" }), row(12, "session.execution.succeeded.1", { sessionID: "ses-a" })] } }
          if (page === 2) throw typedGap()
          return { data: { events: [row(16, "session.execution.started.1", { sessionID: "ses-a" }), row(17, "session.execution.failed.1", { sessionID: "ses-a", error: { message: "x" } })] } }
        },
      },
    }
    const journals = createExecutionJournalSubscription(
      {
        client,
        sessionIDs: () => ["ses-a"],
        lifecycle,
        handlers: { onConnectionChange: (connected) => transitions.push(connected) },
      },
      10,
    )
    try {
      await waitFor(() => afterCalls.length >= 3, "resync never drained")
      expect(afterCalls[1]).toBe("12") // reached head, then the 410 took the anchor behind the floor
      expect(afterCalls[2]).toBe("15") // re-anchored at the retained floor
      expect(transitions).toEqual([]) // the server answered — no connectivity flip
      const state = lifecycle.snapshot().sessions.get("ses-a")!
      // The un-seen retained window (16,17) landed as a new turn — no re-delivery of seen rows.
      expect(state.lastExecution?.state).toBe("failed")
      expect(state.lastExecution?.number).toBe(2)
    } finally {
      journals.dispose()
    }
  })

  test("session-set rebuild preserves per-session anchors and stops removed sessions", async () => {
    const lifecycle = createRecoveryLifecycle()
    const afterBySession = new Map<string, string[]>()
    const record = (sessionID: string, after: string) => {
      const list = afterBySession.get(sessionID) ?? []
      list.push(after)
      afterBySession.set(sessionID, list)
    }
    const cursor = async () => ({ data: { watermark: 10, cursor: 10, floor: 5 } })
    const eventsA: ExecutionJournalClient["context"]["events"] = async ({ after }) => {
      record("ses-a", after)
      return { data: { events: [row(11, "session.execution.started.1", { sessionID: "ses-a" })] } }
    }
    let removed = false
    let eventsBCalls = 0
    const eventsB: ExecutionJournalClient["context"]["events"] = async ({ after }) => {
      eventsBCalls += 1
      record("ses-b", after)
      if (removed) return { data: { events: [row(11, "session.execution.started.1", { sessionID: "ses-b" })] } }
      return { data: { events: [] } }
    }
    const client: ExecutionJournalClient = {
      context: {
        eventsCursor: cursor,
        events: async (params) => (params.session_id === "ses-a" ? eventsA(params) : eventsB(params)),
      },
    }
    let activeIDs = ["ses-a", "ses-b"]
    const journals = createExecutionJournalSubscription({ client, sessionIDs: () => [...activeIDs], lifecycle }, 10)
    try {
      journals.refresh()
      await waitFor(() => eventsBCalls >= 1, "ses-b never polled")
      // Rebuild with a single session: the removed loop must stop and the anchor must survive.
      activeIDs = ["ses-a"]
      removed = true
      journals.refresh()
      const callsB = eventsBCalls
      await waitFor(() => (afterBySession.get("ses-a")?.length ?? 0) >= 3, "ses-a poll stopped")
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(eventsBCalls).toBeLessThanOrEqual(callsB + 1) // at most the in-flight tick resolves; no new loop survives
      expect(afterBySession.get("ses-a")!.slice(-2)).toEqual(["11", "11"]) // resumed from last seq, not watermark
    } finally {
      journals.dispose()
    }
  })
})
