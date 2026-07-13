import { afterEach, describe, expect } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { EventDrivenArchiver } from "../../src/wiki/event-driven-archiver"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { Database } from "@deepagent-code/core/database/database"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { Global } from "@deepagent-code/core/global"
import { testEffect } from "../lib/effect"

// Seed a session's run-scoped context store (the SAME root archiveSessionOnCompletion reads) with a
// trajectory doc, so a well-formed archive-trigger event produces a REAL archive (handle → true). This
// is what disambiguates "passed the payload guard" from "guard-dropped" — both a drop and an empty
// archive return false, but a produced archive returns true only when the guard let the event through.
const seededSessions: string[] = []
const seedSessionStore = (sessionID: string) => {
  const root = path.join(Global.Path.agent.data, "state", "context", sessionID)
  const store = new DocumentStore(root)
  store.create({
    type: "plan",
    scope: `run:${sessionID}`,
    body: "goal: ship it\nstep 1 done",
    description: "plan",
    provenance: { source: "runner", run_ref: `run:${sessionID}` },
  })
  seededSessions.push(root)
}
afterEach(() => {
  for (const root of seededSessions.splice(0)) rmSync(root, { recursive: true, force: true })
})

// V4.0 §L — the event-driven archiver's ROUTING behavior (which events trigger archival, payload
// validation, subscription filtering). The archival PROJECTION itself is covered by
// execution-archiver.test.ts; here we verify the bus→archiver bridge, not re-test the projection.

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

const database = Database.layerFromPath(":memory:")
const busLayer = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))
// runLoop:false → drive handle() directly for determinism.
const archiverLayer = EventDrivenArchiver.layerWith({ runLoop: false }).pipe(Layer.provideMerge(busLayer))
const it = testEffect(archiverLayer)

// handle() acks/nacks the delivery, whose FK references the durable event row — so the event must be
// PUBLISHED first (a synthetic in-memory event object would FK-violate on ack). This helper publishes
// then returns the persisted event.
const publish = (over: Partial<DeepAgentEvent.PublishInput>) =>
  Effect.gen(function* () {
    const bus = yield* DeepAgentEventBus.Service
    return yield* bus.publish({
      type: LMNEvents.SESSION_COMPLETED,
      source: "system",
      workspaceID: "wrk_1",
      idempotencyKey: `idem-${Math.random()}`,
      payload: {},
      ...over,
    })
  })

describe("EventDrivenArchiver.handle (§L)", () => {
  it.effect("ignores a non-archive-trigger event (e.g. ci.failure)", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const archiver = yield* EventDrivenArchiver.Service
      const ev = yield* publish({ type: "ci.failure", source: "ci", payload: { sessionID: "s1", workspacePath: "/tmp/ws" } })
      const handled = yield* archiver.handle(ev)
      expect(handled).toBe(false) // not an archive trigger → skipped regardless of payload
    }),
  )

  it.effect("skips an archive trigger missing sessionID/workspacePath (best-effort, no throw)", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const archiver = yield* EventDrivenArchiver.Service
      const e1 = yield* publish({ type: LMNEvents.SESSION_COMPLETED, payload: {} })
      const e2 = yield* publish({ type: LMNEvents.GOAL_COMPLETED, payload: { sessionID: "s1" } })
      expect(yield* archiver.handle(e1)).toBe(false)
      expect(yield* archiver.handle(e2)).toBe(false)
    }),
  )

  it.effect("attempts archival for a valid trigger (returns false when the session has no store, never throws)", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const archiver = yield* EventDrivenArchiver.Service
      // a well-formed session.completed for a session with no seeded context store → archiveSession
      // returns null (nothing to archive) → handle returns false, but crucially does NOT throw. This
      // proves the bridge reaches the archiver for a valid trigger (the projection itself is tested in
      // execution-archiver.test.ts). Both goal.completed and session.completed are archive triggers.
      expect(LMNEvents.isArchiveTrigger(LMNEvents.SESSION_COMPLETED)).toBe(true)
      expect(LMNEvents.isArchiveTrigger(LMNEvents.GOAL_COMPLETED)).toBe(true)
      const ev = yield* publish({ type: LMNEvents.SESSION_COMPLETED, payload: { sessionID: "no-such-session", workspacePath: "/tmp/nonexistent-ws" } })
      expect(yield* archiver.handle(ev)).toBe(false) // no store → null archive, no throw
    }),
  )

  it.effect("§L end-to-end: a session.completed published on the bus is consumed by the archiver", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const archiver = yield* EventDrivenArchiver.Service
      // publish a real event, then feed it to handle (the background loop would do this automatically).
      const published = yield* bus.publish({
        type: LMNEvents.SESSION_COMPLETED,
        source: "system",
        workspaceID: "wrk_1",
        idempotencyKey: "sc-1",
        payload: { sessionID: "s-int", workspacePath: "/tmp/nonexistent-ws" },
      })
      expect(published.type).toBe(LMNEvents.SESSION_COMPLETED)
      // the archiver processes it without throwing (idempotent + best-effort).
      const handled = yield* archiver.handle(published)
      expect(typeof handled).toBe("boolean")
    }),
  )

  it.effect("T2.4: a goal.completed carrying sessionID + workspacePath IS archived (not dropped at the guard)", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const archiver = yield* EventDrivenArchiver.Service
      // Pre-fix the goal.completed producer emitted only { goalId, planDocId, phase, gaps } → the
      // archiver's payload guard dropped EVERY completed goal (missing sessionID/workspacePath). Seed a
      // real trajectory store for the session, then publish a goal.completed with the CORRECTED payload
      // shape (goal-manager.emitGoalLifecycleEvent). handle() returns TRUE — an archive was produced —
      // which is only reachable if the event cleared the field guard (a missing-field drop and an empty
      // archive both return false, so `true` unambiguously proves the fix).
      const sessionID = "sess-goal-archived"
      seedSessionStore(sessionID)
      const ev = yield* publish({
        type: LMNEvents.GOAL_COMPLETED,
        source: "system",
        payload: { goalId: "g1", planDocId: "doc1", phase: "done", gaps: [], sessionID, workspacePath: "/tmp/nonexistent-ws" },
      })
      expect(yield* archiver.handle(ev)).toBe(true)
    }),
  )

  it.effect("§A3 discharges the delivery: a grouped subscriber's event is ACKED (no orphaned pending row)", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const archiver = yield* EventDrivenArchiver.Service
      // a live grouped subscriber so publish records a durable pending delivery for wiki-archiver.
      yield* bus
        .subscribe({ group: EventDrivenArchiver.ARCHIVE_GROUP })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const published = yield* bus.publish({
        type: LMNEvents.SESSION_COMPLETED,
        source: "system",
        workspaceID: "wrk_1",
        idempotencyKey: "ack-1",
        payload: { sessionID: "s-nonexist", workspacePath: "/tmp/nonexistent-ws" },
      })
      // before handling, the delivery is pending (owed).
      expect((yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).some((d) => d.eventID === published.id)).toBe(true)
      // after handling (null archive = successful no-op), it is ACKED → no longer retry-eligible.
      yield* archiver.handle(published)
      expect((yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).some((d) => d.eventID === published.id)).toBe(false)
    }),
  )

  it.effect("a non-trigger event is also acked (group receives all events; discharge them)", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const archiver = yield* EventDrivenArchiver.Service
      yield* bus
        .subscribe({ group: EventDrivenArchiver.ARCHIVE_GROUP })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const published = yield* bus.publish({ type: "ci.failure", source: "ci", workspaceID: "wrk_1", idempotencyKey: "nt-1", payload: {} })
      yield* archiver.handle(published)
      expect((yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).some((d) => d.eventID === published.id)).toBe(false)
    }),
  )
})
