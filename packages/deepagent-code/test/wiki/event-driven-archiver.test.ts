import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { EventDrivenArchiver } from "../../src/wiki/event-driven-archiver"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "../lib/effect"

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
