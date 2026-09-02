import { describe, expect, test } from "bun:test"
import { createRecoveryLifecycle } from "./recovery-lifecycle-state"
import {
  createExecutionJournalSubscription,
  toLifecycleEvent,
  type ExecutionEventInput,
  type ExecutionJournalClient,
  type ExecutionJournalRow,
} from "./lifecycle-execution-pump"

// C6-11 + W9.5 + W9.6 — the real-event pump: `SessionEvent.Execution.*` wire shapes map to
// `LifecycleEvent`s and the durable-journal subscription drives the reducer, order-preserving
// and type-safe. W9.6: the SSE fallback subscription (`subscribeExecutionEvents`) was REMOVED —
// the journal is the sole source in both admission modes (see lifecycle-execution-pump.ts);
// the mapper keeps accepting both wire shapes for older-server tolerance.

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

// W9.5 + W9.6 — durable journal drive (context.eventsCursor/events poll). The journal is the ONLY
// execution source (the SSE fallback was removed in W9.6 — it double-delivered under admission
// OFF: phantom superseded + synthetic records + turn number +2 per round).

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

const typedNotFound = () => ({
  schemaVersion: "stable-error.v1",
  code: "session_not_found",
  category: "session",
  httpStatus: 404,
  resource: "ses-a",
  message: "session not found on this instance",
})

describe("createExecutionJournalSubscription (durable drain)", () => {
  test("first drain anchors at the watermark; following drains resume from the last seen seq", async () => {
    const lifecycle = createRecoveryLifecycle()
    const afterCalls: string[] = []
    let eventCalls = 0
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
      { client, sessionIDs: () => ["ses-a"], lifecycle, handlers: { onEvent: () => (eventCalls += 1) } },
      10,
    )
    try {
      await waitFor(() => afterCalls.length >= 2, "journal never drained")
      expect(afterCalls[0]).toBe("10") // watermark anchor (never a history replay at mount)
      expect(afterCalls[1]).toBe("12") // seq-resume from the last seen row
      expect(eventCalls).toBe(2) // reactivity hook fires once per mapped event
      const state = lifecycle.snapshot().sessions.get("ses-a")!
      expect(state.lastExecution?.state).toBe("succeeded")
      expect(state.lastExecution?.number).toBe(1)
    } finally {
      journals.dispose()
    }
  })

  test("two started rows close the first turn as superseded (no stuck running)", async () => {
    // Through the sole source (journal): a started row while a turn is still open means the
    // previous turn closed without its own terminal event (stream gap) — never a leak.
    const lifecycle = createRecoveryLifecycle()
    let page = 0
    const client: ExecutionJournalClient = {
      context: {
        eventsCursor: async () => ({ data: { watermark: 10, cursor: 10, floor: 5 } }),
        events: async () => {
          page += 1
          if (page === 1) return { data: { events: [row(11, "session.execution.started.1", { sessionID: "ses-a" }), row(12, "session.execution.started.1", { sessionID: "ses-a" })] } }
          return { data: { events: [] } }
        },
      },
    }
    const journals = createExecutionJournalSubscription({ client, sessionIDs: () => ["ses-a"], lifecycle }, 10)
    try {
      await waitFor(() => lifecycle.snapshot().sessions.get("ses-a")?.execution?.number === 2, "turn 2 never opened")
      const state = lifecycle.snapshot().sessions.get("ses-a")!
      expect(state.execution?.ref.commandId).toBe("execution:2")
      expect(state.lastExecution?.state).toBe("interrupted")
      expect(state.lastExecution?.reason).toBe("superseded")
      expect(state.lastExecution?.ref.commandId).toBe("execution:1")
    } finally {
      journals.dispose()
    }
  })

  test("dispose stops the poll (no delivery from an in-flight tick after unsubscribe)", async () => {
    const lifecycle = createRecoveryLifecycle()
    let eventCalls = 0
    let page = 0
    let secondPollStarted = false
    // The second poll HANGS on a gate the test releases only after dispose, so the in-flight
    // tick resumes deterministically after the cancel — it must never deliver.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client: ExecutionJournalClient = {
      context: {
        eventsCursor: async () => ({ data: { watermark: 10, cursor: 10, floor: 5 } }),
        events: async () => {
          page += 1
          if (page === 1) return { data: { events: [row(11, "session.execution.started.1", { sessionID: "ses-a" })] } }
          secondPollStarted = true
          await gate
          return { data: { events: [row(12, "session.execution.succeeded.1", { sessionID: "ses-a" })] } }
        },
      },
    }
    const journals = createExecutionJournalSubscription(
      { client, sessionIDs: () => ["ses-a"], lifecycle, handlers: { onEvent: () => (eventCalls += 1) } },
      10,
    )
    try {
      await waitFor(() => eventCalls >= 1, "first row never delivered")
      await waitFor(() => secondPollStarted, "second poll never started")
      journals.dispose() // while the second tick is in flight
      release()
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(eventCalls).toBe(1) // the in-flight tick must not deliver after dispose
      expect(lifecycle.snapshot().sessions.get("ses-a")?.execution?.number).toBe(1)
    } finally {
      release()
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

  test("a typed 404 after a network failure clears the fail flag (connected flips back)", async () => {
    // W9.6 — a preceding network blip marks the session failed; the SERVER then answers with a
    // typed refusal (404/400/…). Any non-network response means the server is reachable, so it
    // must mark the session recovered — otherwise the aggregate signal stays false forever
    // (the server keeps answering 404, so no later success could ever flip it back).
    const lifecycle = createRecoveryLifecycle()
    const transitions: boolean[] = []
    const errors: unknown[] = []
    let page = 0
    const client: ExecutionJournalClient = {
      context: {
        eventsCursor: async () => ({ data: { watermark: 10, cursor: 10, floor: 5 } }),
        events: async () => {
          page += 1
          if (page === 1) return { data: { events: [row(11, "session.execution.started.1", { sessionID: "ses-a" })] } }
          if (page === 2) throw new TypeError("network unreachable")
          return { error: typedNotFound() }
        },
      },
    }
    const journals = createExecutionJournalSubscription(
      {
        client,
        sessionIDs: () => ["ses-a"],
        lifecycle,
        handlers: {
          onConnectionChange: (connected) => transitions.push(connected),
          onErrorEvent: (error) => errors.push(error),
        },
      },
      10,
    )
    try {
      await waitFor(() => transitions.length >= 2, "connection transitions never fired")
      expect(transitions).toEqual([false, true]) // network fail → false; the 404 ANSWER → true
      expect(errors.length).toBeGreaterThanOrEqual(2)
      // The loop kept its seq-resume anchor (after=11) through the typed refusals; turn 1 stays
      // open (no terminal arrived) but the reducer is exactly in the delivered state — no
      // re-anchor at the watermark, no phantom turns.
      const state = lifecycle.snapshot().sessions.get("ses-a")!
      expect(state.execution?.number).toBe(1)
    } finally {
      journals.dispose()
    }
  })

  test("a typed 410 resync re-anchors at the retained floor (no connectivity flip)", async () => {
    const lifecycle = createRecoveryLifecycle()
    const afterCalls: string[] = []
    const transitions: boolean[] = []
    const resyncs: { sessionID: string; fromSeq: number | undefined; floor: number }[] = []
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
        handlers: {
          onConnectionChange: (connected) => transitions.push(connected),
          onResync: (info) => resyncs.push(info),
        },
      },
      10,
    )
    try {
      await waitFor(() => afterCalls.length >= 3, "resync never drained")
      expect(afterCalls[1]).toBe("12") // reached head, then the 410 took the anchor behind the floor
      expect(afterCalls[2]).toBe("15") // re-anchored at the retained floor
      expect(transitions).toEqual([]) // the server answered — no connectivity flip
      // W9.6 — the bounded resync surfaces a typed notice: the journal compacted the window
      // (12, 15] and the summary resumes from the retained floor (authoritative contract).
      expect(resyncs).toEqual([{ sessionID: "ses-a", fromSeq: 12, floor: 15 }])
      const state = lifecycle.snapshot().sessions.get("ses-a")!
      // The un-seen retained window (16,17) landed as a new turn — no re-delivery of seen rows.
      expect(state.lastExecution?.state).toBe("failed")
      expect(state.lastExecution?.number).toBe(2)
    } finally {
      journals.dispose()
    }
  })

  test("W9.6 regression: a rebuild resumes from lastSeqs — no watermark re-anchor, no phantom slot", async () => {
    // W9.5 review repro: after-calls ["10","11",…,"10","11",…] + phantom slot execution:2 +
    // a forged superseded record. Scripted exactly: after=10 always serves rows 11/12 (started +
    // succeeded, one turn); after=12 serves nothing. The FIXED pump must drain after=12 after the
    // rebuild (the OLD one re-anchored at the watermark and re-delivered 11/12 → phantom turn 2).
    const lifecycle = createRecoveryLifecycle()
    const afterCalls: string[] = []
    let eventCalls = 0
    const client: ExecutionJournalClient = {
      context: {
        eventsCursor: async () => ({ data: { watermark: 10, cursor: 10, floor: 5 } }),
        events: async ({ after }) => {
          afterCalls.push(after)
          if (after === "10") {
            return { data: { events: [row(11, "session.execution.started.1", { sessionID: "ses-a" }), row(12, "session.execution.succeeded.1", { sessionID: "ses-a" })] } }
          }
          return { data: { events: [] } }
        },
      },
    }
    const journals = createExecutionJournalSubscription(
      { client, sessionIDs: () => ["ses-a"], lifecycle, handlers: { onEvent: () => (eventCalls += 1) } },
      10,
    )
    try {
      await waitFor(() => afterCalls.length >= 3, "first window never drained")
      journals.refresh(true) // FORCED rebuild — same session set, but the loops are re-seeded from lastSeqs
      await waitFor(() => afterCalls.length >= 6, "rebuilt drain never ran")
      // FULL after sequence (no slice masking): the watermark anchor "10" must appear exactly
      // once — the rebuild resumes from the last seen seq, never back to the mount watermark.
      expect(afterCalls[0]).toBe("10")
      expect(afterCalls.slice(1).every((after) => after === "12")).toBe(true)
      // Exactly one delivered turn: no phantom slot, no forged superseded, no stuck running.
      expect(eventCalls).toBe(2)
      const state = lifecycle.snapshot().sessions.get("ses-a")!
      expect(state.lastExecution?.number).toBe(1)
      expect(state.lastExecution?.state).toBe("succeeded")
      expect(state.lastExecution?.reason).toBeUndefined()
      expect(state.execution).toBeUndefined()
    } finally {
      journals.dispose()
    }
  })

  test("W9.6 regression: an empty first window is re-drained from the anchor, never a watermark re-read", async () => {
    // First window [.. 10] is empty; the server then advances to rows 11/12. The rebuilt loop
    // must resume from the anchor (after=10, the lastSeqs value) and receive 11/12 — a new
    // watermark read at rebuild would anchor at 12 (the advanced head) and LOSE the window.
    const lifecycle = createRecoveryLifecycle()
    const afterCalls: string[] = []
    let cursorReads = 0
    let deliveredAfter: string | undefined
    let serveRows = false
    const client: ExecutionJournalClient = {
      context: {
        eventsCursor: async () => {
          cursorReads += 1
          // The second read (buggy rebuild) would return the ADVANCED head: 12.
          return cursorReads === 1
            ? { data: { watermark: 10, cursor: 10, floor: 5 } }
            : { data: { watermark: 12, cursor: 12, floor: 5 } }
        },
        events: async ({ after }) => {
          afterCalls.push(after)
          if (after === "10" && serveRows) {
            deliveredAfter = after
            return { data: { events: [row(11, "session.execution.started.1", { sessionID: "ses-a" }), row(12, "session.execution.succeeded.1", { sessionID: "ses-a" })] } }
          }
          return { data: { events: [] } }
        },
      },
    }
    const journals = createExecutionJournalSubscription({ client, sessionIDs: () => ["ses-a"], lifecycle }, 10)
    try {
      await waitFor(() => afterCalls.length >= 2, "first window never drained")
      expect(afterCalls).toContain("10") // anchored at the watermark while the window was empty
      serveRows = true
      journals.refresh(true) // FORCED rebuild: must resume from the anchor seq, NOT re-read the watermark
      await waitFor(() => deliveredAfter !== undefined, "the (10, 12] window never arrived")
      expect(cursorReads).toBe(1) // no watermark re-read at rebuild
      expect(deliveredAfter).toBe("10") // the rebuild re-drained from the preserved anchor
      const state = lifecycle.snapshot().sessions.get("ses-a")!
      expect(state.lastExecution?.state).toBe("succeeded")
      expect(state.lastExecution?.number).toBe(1)
    } finally {
      journals.dispose()
    }
  })

  test("W15 P1 regression: a stale gapResync tick after a rebuild never overwrites the new anchor or fakes onResync", async () => {
    // Old-generation tick: first drain hits the typed 410 (gapResync) and the next tick is
    // awaiting its FLOOR re-read when a forced rebuild lands. The new loop seeds from the shared
    // pre-410 anchor (45) and drains the retained window up to 50 (lastSeqs → 50). The stale
    // tick must then return WITHOUT `advance(45)` (which would overwrite the shared anchor and
    // replay the already-delivered (45, 50] window at the NEXT rebuild) and WITHOUT firing a fake
    // onResync. Script: cursor#1 = watermark 45/floor 40; events(after=45) first call = 410;
    // cursor#2 (the stale floor read) hangs on a gate released only after the rebuild; the
    // rebuilt loop's events(after=45) serves rows 46..50; every later drain (after=50) is empty.
    const lifecycle = createRecoveryLifecycle()
    const afterCalls: string[] = []
    const resyncs: { sessionID: string; fromSeq: number | undefined; floor: number }[] = []
    let eventCalls = 0
    let cursorReads = 0
    let drainCalls = 0
    let release: () => void = () => {}
    const cursorGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client: ExecutionJournalClient = {
      context: {
        eventsCursor: async () => {
          cursorReads += 1
          if (cursorReads === 1) return { data: { watermark: 45, cursor: 45, floor: 40 } }
          // The STALE tick's floor re-read: hangs until the test releases it after the rebuild
          // (the server meanwhile pruned up to floor=45).
          if (cursorReads === 2) {
            await cursorGate
            return { data: { watermark: 50, cursor: 50, floor: 45 } }
          }
          return { data: { watermark: 50, cursor: 50, floor: 45 } }
        },
        events: async ({ after }) => {
          afterCalls.push(after)
          drainCalls += 1
          if (after !== "45") return { data: { events: [] } }
          if (drainCalls === 1) throw typedGap() // stale anchor behind the newly-raised floor
          return {
            data: {
              events: [
                row(46, "session.execution.started.1", { sessionID: "ses-a" }),
                row(47, "session.execution.succeeded.1", { sessionID: "ses-a" }),
                row(48, "session.execution.started.1", { sessionID: "ses-a" }),
                row(49, "session.execution.succeeded.1", { sessionID: "ses-a" }),
                row(50, "session.execution.started.1", { sessionID: "ses-a" }),
              ],
            },
          }
        },
      },
    }
    const journals = createExecutionJournalSubscription(
      {
        client,
        sessionIDs: () => ["ses-a"],
        lifecycle,
        handlers: {
          onEvent: () => (eventCalls += 1),
          onResync: (info) => resyncs.push(info),
        },
      },
      10,
    )
    try {
      // Generation 1: anchor 45, drain 410 → gapResync; the stale tick is then parked in its
      // floor re-read (cursor gate). Only after that does the rebuild land (generation 2).
      await waitFor(() => drainCalls >= 1, "the 410 drain never ran")
      await waitFor(() => cursorReads >= 2, "the stale floor read never started")
      journals.refresh(true) // rebuild while the old tick is in flight at the cursor gate
      await waitFor(() => eventCalls >= 5, "rebuilt loop never drained the retained window")
      // The rebuilt loop delivered rows 46..50: the shared anchor is 50 now.
      release() // the stale tick's floor read (floor=45) resolves post-rebuild
      await new Promise((resolve) => setTimeout(resolve, 60)) // let the stale tick settle
      // Second rebuild: seeds from the shared anchor. It must be 50 (the preserved position —
      // not the stale floor 45, which would re-drain and REPLAY the already-delivered window).
      journals.refresh(true)
      await waitFor(() => afterCalls.length >= 6, "second rebuild never drained")
      expect(resyncs).toEqual([]) // no fake onResync from the stale tick
      expect(afterCalls.filter((after) => after === "45")).toHaveLength(2) // 410 drain + rebuilt drain only
      expect(eventCalls).toBe(5) // every row delivered exactly once — no (45, 50] replay
      const state = lifecycle.snapshot().sessions.get("ses-a")!
      expect(state.execution?.number).toBe(3) // row 50 opened turn 3 exactly once
      expect(state.lastExecution?.number).toBe(2) // turns 1+2 closed by rows 47/49 exactly once
      expect(state.lastExecution?.reason).toBeUndefined() // no forged superseded from a replay
    } finally {
      release()
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
      await waitFor(() => (afterBySession.get("ses-a")?.length ?? 0) >= 4, "ses-a poll stopped")
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(eventsBCalls).toBeLessThanOrEqual(callsB + 1) // at most the in-flight tick resolves; no new loop survives
      // W9.6 — FULL sequence (no slice masking): ses-a anchored once at the watermark ("10");
      // every later drain resumes from the last seen seq ("11"). A re-anchor would repeat "10"
      // and re-deliver row 11 → phantom turn 2 + forged superseded.
      const afterA = afterBySession.get("ses-a")!
      expect(afterA[0]).toBe("10")
      expect(afterA.slice(1).every((after) => after === "11")).toBe(true)
      const stateA = lifecycle.snapshot().sessions.get("ses-a")!
      expect(stateA.execution?.number).toBe(1) // no phantom slot from re-delivery
      expect(stateA.lastExecution?.reason).toBeUndefined() // no forged superseded
      expect(lifecycle.snapshot().sessions.has("ses-b")).toBe(false)
    } finally {
      journals.dispose()
    }
  })
})
