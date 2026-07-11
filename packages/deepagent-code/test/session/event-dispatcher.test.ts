import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { EventDispatcher } from "../../src/session/event-dispatcher"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { Database } from "@deepagent-code/core/database/database"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { testEffect } from "../lib/effect"

// V4.0 §A4 Wave 2b — the Event Router + Scheduler runtime wiring. Verifies the deepagent-code half:
// flag gating, agent resolution, dispatch/ack/nack, and the scheduler tick → bus publish path. The
// pure decision + durable state are covered by core/{event-router,scheduler}.test.ts.

let clock = 0
const setNow = (t: number) => {
  clock = t
}
const now = () => clock

// A fake registry: one agent that triggers on ci.failure.
const ciAgent: AgentDescriptor = {
  id: "agt_ci",
  name: "CodeFixAgent",
  displayName: "Code Fix Agent",
  visible: true,
  triggers: [{ event: "ci.failure" }],
}
const fakeAgentList = Layer.succeed(AgentListProviderService, {
  listAgents: () => Effect.succeed([ciAgent]),
  findByTrigger: () => Effect.succeed([ciAgent]),
  findByCapability: () => Effect.succeed([]),
})

// A module-level recorder the DispatchPort writes to (reset per test). Simpler than a context slot and
// keeps the layer construction static so `testEffect` can memoize it.
let recorded: EventDispatcher.DispatchRequest[] = []
let failDispatch = false
const resetRecorder = () => {
  recorded = []
  failDispatch = false
}
const recordingPort: EventDispatcher.DispatchPort = {
  dispatch: (request) =>
    Effect.suspend(() => {
      recorded.push(request)
      return failDispatch ? Effect.fail(new Error("boom")) : Effect.void
    }),
}

const makeLayer = (flags?: Partial<RuntimeFlags.Info>) => {
  const database = Database.layerFromPath(":memory:")
  const flagsLayer = RuntimeFlags.layer({
    v4EventDrivenIm: true,
    v4AgentPushEnabled: true,
    v4MultiAgentRuntime: true,
    ...flags,
  })
  const core = Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), Scheduler.layerWith({ now })).pipe(
    Layer.provideMerge(database),
  )
  const dispatcher = EventDispatcher.layerWith({ dispatchPort: recordingPort, runLoops: false, now }).pipe(
    Layer.provide(core),
    Layer.provide(fakeAgentList),
    Layer.provide(flagsLayer),
  )
  return Layer.mergeAll(dispatcher, core, flagsLayer)
}

const input = (over?: Partial<DeepAgentEvent.PublishInput>): DeepAgentEvent.PublishInput => ({
  type: "ci.failure",
  source: "ci",
  workspaceID: "wrk_1",
  payload: { failedTests: 1 },
  ...over,
})

describe("EventDispatcher", () => {
  const it = testEffect(makeLayer())

  it.effect("§A4 dispatch: a matching event with the flag on is routed to the target agent + acked", () =>
    Effect.gen(function* () {
      resetRecorder()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(input({ idempotencyKey: "d-1" }))
      const decision = yield* dispatcher.handle(event)
      expect(decision.type).toBe("dispatch")
      expect(recorded.length).toBe(1)
      expect(recorded[0]?.targets.map((t) => t.id)).toEqual(["agt_ci"])
      expect((yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).length).toBe(0) // acked
    }),
  )

  it.effect("§A4 no_match: an event no agent subscribes to is dropped (no dispatch), still acked", () =>
    Effect.gen(function* () {
      resetRecorder()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(input({ idempotencyKey: "d-2", type: "pr.comment", source: "pr" }))
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "dropped", reason: "no_match" })
      expect(recorded.length).toBe(0)
    }),
  )

  it.effect("§A4 tick: a due delay schedule publishes its templated event through the bus", () =>
    Effect.gen(function* () {
      resetRecorder()
      setNow(0)
      const scheduler = yield* Scheduler.Service
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      yield* scheduler.scheduleDelay({
        workspaceID: "wrk_1",
        fireAt: 5_000,
        eventTemplate: { type: "ci.failure", source: "schedule", workspaceID: "wrk_1", payload: { via: "sched" } },
      })
      expect(yield* dispatcher.tick(4_999)).toBe(0) // not due yet
      expect(yield* dispatcher.tick(5_000)).toBe(1) // fires once, publishes
      const recent = yield* bus.recentByType({
        type: "ci.failure",
        windowMs: Number.MAX_SAFE_INTEGER,
        now: 5_000,
      })
      expect(recent.map((r) => (r.payload as { via?: string }).via)).toContain("sched")
      expect(yield* dispatcher.tick(10_000)).toBe(0) // fired delay doesn't refire
    }),
  )
})

describe("EventDispatcher flag gating", () => {
  const it = testEffect(makeLayer({ v4MultiAgentRuntime: false }))

  it.effect("§A4 flag off: dispatch is fail-closed (dropped flag_disabled, no dispatch)", () =>
    Effect.gen(function* () {
      resetRecorder()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(input({ idempotencyKey: "g-1" }))
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "dropped", reason: "flag_disabled" })
      expect(recorded.length).toBe(0)
    }),
  )
})

describe("EventDispatcher dispatch failure + retry pump", () => {
  const it = testEffect(makeLayer())

  it.effect("§A3 retry: a failing dispatch nacks so the bus schedules a retry", () =>
    Effect.gen(function* () {
      resetRecorder()
      failDispatch = true
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(input({ idempotencyKey: "r-1" }))
      const decision = yield* dispatcher.handle(event)
      expect(decision.type).toBe("dispatch") // routed, but the port threw
      const due = yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)
      expect(due.map((d) => d.eventID)).toEqual([event.id])
      expect(due[0]?.attempts).toBe(1)
    }),
  )

  it.effect("§A3 retry pump: re-drives a nacked delivery; succeeds once the port recovers (at-least-once)", () =>
    Effect.gen(function* () {
      resetRecorder()
      failDispatch = true
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      // grouped subscriber so publish records a durable pending delivery for "router".
      yield* bus.subscribe({ group: EventDispatcher.DISPATCH_GROUP }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* bus.publish(input({ idempotencyKey: "rp-1" }))
      yield* dispatcher.handle(event) // fails → nacked, attempt 1, next at 2_000
      expect((yield* bus.dueRetries(2_000)).map((d) => d.eventID)).toEqual([event.id])
      // port recovers; pump at t=2_000 reloads the event and re-drives handle → dispatch ok → ack
      failDispatch = false
      const redriven = yield* dispatcher.pumpRetries(2_000)
      expect(redriven).toBe(1)
      expect(recorded.length).toBe(2) // dispatch attempted twice: initial (failed) + retry (ok)
      expect((yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).length).toBe(0) // acked, no longer pending
    }),
  )
})

describe("EventDispatcher condition tick", () => {
  const it = testEffect(makeLayer())

  it.effect("§A4 条件触发: tick fires a condition only when the threshold is met, else reschedules", () =>
    Effect.gen(function* () {
      resetRecorder()
      setNow(0)
      const scheduler = yield* Scheduler.Service
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      yield* scheduler.scheduleCondition({
        workspaceID: "wrk_1",
        condition: { eventType: "ci.failure", threshold: 2, windowMs: 60_000 },
        firstCheckAt: 0,
        recheckEveryMs: 1_000,
        eventTemplate: { type: "git.push", source: "schedule", workspaceID: "wrk_1", payload: { fixIt: true } },
      })
      // only 1 ci.failure in the window → threshold(2) not met → tick reschedules, does NOT fire
      yield* bus.publish(input({ idempotencyKey: "cf-1", type: "ci.failure" }))
      expect(yield* dispatcher.tick(0)).toBe(0)
      // second failure → threshold met → next due tick fires the template event
      yield* bus.publish(input({ idempotencyKey: "cf-2", type: "ci.failure" }))
      expect(yield* dispatcher.tick(1_000)).toBe(1)
      const fired = yield* bus.recentByType({ type: "git.push", windowMs: Number.MAX_SAFE_INTEGER, now: 1_000 })
      expect(fired.length).toBe(1)
    }),
  )
})

describe("EventDispatcher.flagForEventType", () => {
  const it = testEffect(makeLayer())
  it.effect("maps event-type prefixes to the right flag", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      expect(EventDispatcher.flagForEventType(flags, "im.message.created")).toBe(flags.v4EventDrivenIm)
      expect(EventDispatcher.flagForEventType(flags, "agent.push.requested")).toBe(flags.v4AgentPushEnabled)
      expect(EventDispatcher.flagForEventType(flags, "ci.failure")).toBe(flags.v4MultiAgentRuntime)
      expect(EventDispatcher.flagForEventType(flags, "git.push")).toBe(flags.v4MultiAgentRuntime)
    }),
  )
})
