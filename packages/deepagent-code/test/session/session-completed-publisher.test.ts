import { describe, expect } from "bun:test"
import { Effect, Layer, Stream, Duration } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { SessionCompletedPublisher } from "../../src/session/session-completed-publisher"
import { EventDrivenArchiver } from "../../src/wiki/event-driven-archiver"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionStatus } from "../../src/session/status"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

// V4.0 §L — the `session.completed` PRODUCER. Proves the missing archiver trigger is now published, and
// — critically (Check 2 fix) — that it is debounced to ONE-PER-EXECUTION rather than per-turn: an
// interactive root session idles after every turn, so publishing per idle would re-project the whole
// trace N times. The bridge coalesces a burst of idles into a single `session.completed` carrying the
// session's LATEST state, and re-archives on a genuinely separate later completion.
//
// Two styles of test:
//  - DIRECT (publishCompleted): shape / root-only / no-dir / gone / per-epoch idempotency — no timer.
//  - DEBOUNCE (handleIdle + TestClock): N rapid idles → 1 publish; distinct completions → 2 publishes;
//    plus a LIVE subscription-chain test that publishes real session.status idle events end-to-end.

let clock = 0
const now = () => clock

const database = Database.layerFromPath(":memory:")
const busLayer = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))

const DEBOUNCE_MS = 1_000

// A resolver stub keyed off the sessionID: "root-*" → root session, "child-*" → has a parent, "nodir-*"
// → empty directory, "gone-*" → missing (undefined). Mirrors the shape Session.get would map to.
const resolver: SessionCompletedPublisher.SessionResolver = (sessionID) => {
  if (sessionID.startsWith("gone")) return Effect.succeed(undefined)
  if (sessionID.startsWith("child"))
    return Effect.succeed({ parentID: "root-parent", directory: "/tmp/ws", workspaceID: "wrk_1" })
  if (sessionID.startsWith("nodir")) return Effect.succeed({ directory: "" })
  return Effect.succeed({ directory: "/tmp/ws", workspaceID: "wrk_1" })
}

// Publisher (+ archiver, sharing the one bus). runLoop:false → drive handleIdle()/publishCompleted()
// directly for determinism (no EventV2 subscription). Optionally provide EventV2Bridge for the live
// subscription test (runLoop:true).
const archiverLayer = EventDrivenArchiver.layerWith({ runLoop: false }).pipe(Layer.provideMerge(busLayer))

const publisherFor = (flag: boolean) =>
  SessionCompletedPublisher.layerWith({ runLoop: false, resolveSession: resolver, debounceMs: DEBOUNCE_MS }).pipe(
    Layer.provide(RuntimeFlags.layer({ v4EventDrivenArchive: flag })),
  )

const on = testEffect(Layer.mergeAll(publisherFor(true), archiverLayer).pipe(Layer.provideMerge(busLayer)))
const off = testEffect(Layer.mergeAll(publisherFor(false), archiverLayer).pipe(Layer.provideMerge(busLayer)))

// live: publisher daemon (runLoop:true) + the shared EventV2 bridge the test publishes idle events onto +
// the V4 bus. provideMerge (not provide) EXPOSES the one bridge instance the daemon subscribes on, so the
// test's idle publishes are observed by the daemon. No archiver — the live test asserts the PRODUCER's
// fold and pulls events straight off the bus.
const liveLayer = SessionCompletedPublisher.layerWith({
  runLoop: true,
  resolveSession: resolver,
  debounceMs: DEBOUNCE_MS,
}).pipe(
  Layer.provide(RuntimeFlags.layer({ v4EventDrivenArchive: true })),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
  Layer.provideMerge(busLayer),
)
const live = testEffect(liveLayer)

// Collect every persisted session.completed event from the durable log (optionally for one session).
const collectCompleted = (sessionID?: string) =>
  Effect.gen(function* () {
    const bus = yield* DeepAgentEventBus.Service
    const out: DeepAgentEvent.Event[] = []
    yield* bus
      .replay({ from: 0, type: LMNEvents.SESSION_COMPLETED })
      .pipe(Stream.runForEach((e) => Effect.sync(() => out.push(e))))
    return sessionID ? out.filter((e) => (e.payload as { sessionID?: string })?.sessionID === sessionID) : out
  })

describe("SessionCompletedPublisher.publishCompleted (§L — publish shape + gates)", () => {
  on.effect("a completed ROOT session publishes session.completed with the archiver's payload", () =>
    Effect.gen(function* () {
      const pub = yield* SessionCompletedPublisher.Service
      const published = yield* pub.publishCompleted({ sessionID: "root-1", completionToken: 100 })
      expect(published).toBe(true)
      const events = yield* collectCompleted("root-1")
      expect(events.length).toBe(1)
      const ev = events[0]!
      expect(ev.type).toBe(LMNEvents.SESSION_COMPLETED)
      expect(ev.source).toBe("system") // in DEFAULT_TRUSTED_SOURCES → passes §E1 L1
      const payload = ev.payload as { sessionID: string; workspacePath: string }
      expect(payload.sessionID).toBe("root-1")
      expect(payload.workspacePath).toBe("/tmp/ws")
    }),
  )

  on.effect("§L end-to-end: the published session.completed is ACCEPTED by the archiver as a trigger", () =>
    Effect.gen(function* () {
      const pub = yield* SessionCompletedPublisher.Service
      const archiver = yield* EventDrivenArchiver.Service
      yield* pub.publishCompleted({ sessionID: "root-e2e", completionToken: 100 })
      const events = yield* collectCompleted("root-e2e")
      const ev = events[0]
      expect(ev).toBeDefined()
      expect(LMNEvents.isArchiveTrigger(ev!.type)).toBe(true)
      const handled = yield* archiver.handle(ev!)
      expect(typeof handled).toBe("boolean") // no store on disk → false, but crucially no throw.
    }),
  )

  on.effect("per-token idempotency: same completionToken dedupes; a NEW token re-archives (final state)", () =>
    Effect.gen(function* () {
      const pub = yield* SessionCompletedPublisher.Service
      // same window fired twice (retry/re-entrancy) → ONE row.
      yield* pub.publishCompleted({ sessionID: "root-tok", completionToken: 1000 })
      yield* pub.publishCompleted({ sessionID: "root-tok", completionToken: 1000 })
      expect((yield* collectCompleted("root-tok")).length).toBe(1)
      // a genuinely separate later completion (new window fires at a later instant) → a SECOND archive.
      yield* pub.publishCompleted({ sessionID: "root-tok", completionToken: 2000 })
      expect((yield* collectCompleted("root-tok")).length).toBe(2)
    }),
  )

  on.effect("skips a CHILD/subagent session (would spam the archiver with partial traces)", () =>
    Effect.gen(function* () {
      const pub = yield* SessionCompletedPublisher.Service
      expect(yield* pub.publishCompleted({ sessionID: "child-1", completionToken: 100 })).toBe(false)
      expect((yield* collectCompleted("child-1")).length).toBe(0)
    }),
  )

  on.effect("skips a session with no working directory (unarchivable)", () =>
    Effect.gen(function* () {
      const pub = yield* SessionCompletedPublisher.Service
      expect(yield* pub.publishCompleted({ sessionID: "nodir-1", completionToken: 100 })).toBe(false)
    }),
  )

  on.effect("skips a session that no longer exists", () =>
    Effect.gen(function* () {
      const pub = yield* SessionCompletedPublisher.Service
      expect(yield* pub.publishCompleted({ sessionID: "gone-1", completionToken: 100 })).toBe(false)
    }),
  )

  off.effect("flag OFF: nothing publishes (inert), handleIdle does not arm", () =>
    Effect.gen(function* () {
      const pub = yield* SessionCompletedPublisher.Service
      expect(yield* pub.publishCompleted({ sessionID: "root-off", completionToken: 100 })).toBe(false)
      expect(yield* pub.handleIdle({ sessionID: "root-off" })).toBe(false)
      yield* TestClock.adjust(Duration.millis(DEBOUNCE_MS * 2))
      expect((yield* collectCompleted()).length).toBe(0)
    }),
  )
})

describe("SessionCompletedPublisher.handleIdle (§L — per-turn debounce/coalesce, Check 2 fix)", () => {
  on.effect("MANY rapid idles (simulated multi-turn interaction) coalesce to ONE session.completed", () =>
    Effect.gen(function* () {
      const pub = yield* SessionCompletedPublisher.Service
      // 20-turn interactive session: each turn ends idle inside the quiet window (no clock advance yet).
      for (let i = 0; i < 20; i++) {
        expect(yield* pub.handleIdle({ sessionID: "root-multi" })).toBe(true)
      }
      // still nothing published — the window has not elapsed.
      expect((yield* collectCompleted("root-multi")).length).toBe(0)
      // session goes quiet for the full debounce window → exactly ONE archive (not 20).
      yield* TestClock.adjust(Duration.millis(DEBOUNCE_MS))
      yield* Effect.yieldNow
      expect((yield* collectCompleted("root-multi")).length).toBe(1)
    }),
  )

  on.effect("two SEPARATE completions (quiet, active again, quiet) publish TWICE (reflects final state)", () =>
    Effect.gen(function* () {
      const pub = yield* SessionCompletedPublisher.Service
      // first completion.
      yield* pub.handleIdle({ sessionID: "root-two" })
      yield* TestClock.adjust(Duration.millis(DEBOUNCE_MS))
      yield* Effect.yieldNow
      expect((yield* collectCompleted("root-two")).length).toBe(1)
      // more work happens later, then a second quiet completion → a fresh archive (higher epoch).
      yield* pub.handleIdle({ sessionID: "root-two" })
      yield* TestClock.adjust(Duration.millis(DEBOUNCE_MS))
      yield* Effect.yieldNow
      expect((yield* collectCompleted("root-two")).length).toBe(2)
    }),
  )

  on.effect("an idle that keeps re-arming BEFORE the window elapses never fires early", () =>
    Effect.gen(function* () {
      const pub = yield* SessionCompletedPublisher.Service
      yield* pub.handleIdle({ sessionID: "root-rearm" })
      // advance just under the window, then re-arm — the timer resets, so still nothing fires.
      yield* TestClock.adjust(Duration.millis(DEBOUNCE_MS - 1))
      yield* pub.handleIdle({ sessionID: "root-rearm" })
      yield* TestClock.adjust(Duration.millis(DEBOUNCE_MS - 1))
      expect((yield* collectCompleted("root-rearm")).length).toBe(0)
      // now let the (reset) window fully elapse → one publish.
      yield* TestClock.adjust(Duration.millis(1))
      yield* Effect.yieldNow
      expect((yield* collectCompleted("root-rearm")).length).toBe(1)
    }),
  )

  // LIVE subscription chain: publish real session.status idle events (what run-state.ts emits per turn)
  // and prove the daemon's subscription folds them to one session.completed. Exercises the actual
  // EventV2 → handleIdle → debounce → bus.publish path, not just a direct call.
  live.effect("LIVE: repeated session.status idle events fold to ONE session.completed via the daemon", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      // a real session id (must be "ses"-prefixed); the resolver's default branch treats it as a root.
      const liveID = SessionID.create()
      // emit 5 idle transitions for the same root session (5 interactive turns).
      for (let i = 0; i < 5; i++) {
        yield* events.publish(SessionStatus.Event.Status, {
          sessionID: liveID,
          status: { type: "idle" },
        })
        // let the subscriber fiber drain this event (arm/re-arm) before the next.
        yield* Effect.yieldNow
        yield* Effect.yieldNow
      }
      // window elapses → exactly one archive trigger for the whole burst.
      yield* TestClock.adjust(Duration.millis(DEBOUNCE_MS))
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect((yield* collectCompleted(liveID)).length).toBe(1)
    }),
  )
})
