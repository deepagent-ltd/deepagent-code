import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { EventDispatcher } from "../../src/session/event-dispatcher"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { Database } from "@deepagent-code/core/database/database"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
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

// §C4 re-entrancy scenario: an agent with a WILDCARD trigger that WOULD match every event type —
// including the coordination/derivative family. Used to prove the router's guard severs the loop.
const wildcardAgent: AgentDescriptor = {
  id: "agt_star",
  name: "OmniAgent",
  displayName: "Omni Agent",
  visible: true,
  triggers: [{ event: "*" }],
}
const wildcardAgentList = Layer.succeed(AgentListProviderService, {
  listAgents: () => Effect.succeed([wildcardAgent]),
  findByTrigger: () => Effect.succeed([wildcardAgent]),
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

const makeLayer = (
  flags?: Partial<RuntimeFlags.Info>,
  agentListLayer: Layer.Layer<AgentListProviderService> = fakeAgentList,
) => {
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
    Layer.provide(agentListLayer),
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

// §E4/§N (P3.13) — quiet-hours filter for the scheduler tick. The dispatcher resolves the workspace's
// configured window via the OPTIONAL WorkspaceConfig service; a low/normal scheduled fire during quiet
// hours is DEFERRED (rescheduled past the window), while high/critical always fire (§E4 允许即时送达).
describe("EventDispatcher quiet-hours tick filter", () => {
  // a layer that ALSO provides WorkspaceConfig over the same in-memory DB, so a test can configure a
  // quiet-hours window and observe the dispatcher defer during it.
  const makeQuietLayer = () => {
    const database = Database.layerFromPath(":memory:")
    const flagsLayer = RuntimeFlags.layer({ v4EventDrivenIm: true, v4AgentPushEnabled: true, v4MultiAgentRuntime: true })
    const core = Layer.mergeAll(
      DeepAgentEventBus.layerWith({ now }),
      Scheduler.layerWith({ now }),
      WorkspaceConfig.layerWith({ now }),
    ).pipe(Layer.provideMerge(database))
    const dispatcher = EventDispatcher.layerWith({ dispatchPort: recordingPort, runLoops: false, now }).pipe(
      Layer.provide(core),
      Layer.provide(fakeAgentList),
      Layer.provide(flagsLayer),
    )
    return Layer.mergeAll(dispatcher, core, flagsLayer)
  }
  const it = testEffect(makeQuietLayer())

  // a UTC window 00:00–06:00 (tz offset 0). now() returns epoch ms; hour-of-day = floor(ms/3.6e6)%24.
  const setQuiet = (config: WorkspaceConfig.Interface) =>
    config.set("wrk_1", { quietHours: { startHour: 0, endHour: 6, tzOffsetMinutes: 0 } })

  // an epoch ms whose UTC hour is 2 (inside 00:00–06:00): 2h = 7_200_000ms.
  const QUIET_AT = 2 * 3_600_000
  // an epoch ms whose UTC hour is 8 (outside the window): 8h.
  const AWAKE_AT = 8 * 3_600_000

  it.effect("a NORMAL scheduled fire during quiet hours DEFERS (does not publish), reschedules past window", () =>
    Effect.gen(function* () {
      resetRecorder()
      const config = yield* WorkspaceConfig.Service
      yield* setQuiet(config)
      const scheduler = yield* Scheduler.Service
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      setNow(QUIET_AT)
      yield* scheduler.scheduleDelay({
        workspaceID: "wrk_1",
        fireAt: QUIET_AT,
        // normal priority (default) — subject to the quiet-hours defer.
        eventTemplate: { type: "ci.failure", source: "schedule", workspaceID: "wrk_1", priority: "normal", payload: { via: "sched" } },
      })
      // tick during quiet hours → deferred, NOT fired.
      expect(yield* dispatcher.tick(QUIET_AT)).toBe(0)
      const duringQuiet = yield* bus.recentByType({ type: "ci.failure", windowMs: Number.MAX_SAFE_INTEGER, now: QUIET_AT })
      expect(duringQuiet.length).toBe(0) // nothing published during quiet hours
      // it was rescheduled to the window END (06:00 = 6h) — due once we tick past the window.
      const afterWindow = yield* dispatcher.tick(6 * 3_600_000)
      expect(afterWindow).toBe(1)
      const fired = yield* bus.recentByType({ type: "ci.failure", windowMs: Number.MAX_SAFE_INTEGER, now: 6 * 3_600_000 })
      expect(fired.map((r) => (r.payload as { via?: string }).via)).toContain("sched")
    }),
  )

  it.effect("a HIGH-priority scheduled fire ALWAYS fires, even during quiet hours (§E4 允许即时送达)", () =>
    Effect.gen(function* () {
      resetRecorder()
      const config = yield* WorkspaceConfig.Service
      yield* setQuiet(config)
      const scheduler = yield* Scheduler.Service
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      setNow(QUIET_AT)
      yield* scheduler.scheduleDelay({
        workspaceID: "wrk_1",
        fireAt: QUIET_AT,
        eventTemplate: { type: "pr.comment", source: "schedule", workspaceID: "wrk_1", priority: "high", payload: { urgent: true } },
      })
      // high priority breaks through quiet hours → fires immediately.
      expect(yield* dispatcher.tick(QUIET_AT)).toBe(1)
      const fired = yield* bus.recentByType({ type: "pr.comment", windowMs: Number.MAX_SAFE_INTEGER, now: QUIET_AT })
      expect(fired.length).toBe(1)
    }),
  )

  it.effect("outside quiet hours a normal fire proceeds normally", () =>
    Effect.gen(function* () {
      resetRecorder()
      const config = yield* WorkspaceConfig.Service
      yield* setQuiet(config)
      const scheduler = yield* Scheduler.Service
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      setNow(AWAKE_AT)
      yield* scheduler.scheduleDelay({
        workspaceID: "wrk_1",
        fireAt: AWAKE_AT,
        eventTemplate: { type: "ci.failure", source: "schedule", workspaceID: "wrk_1", priority: "normal", payload: { via: "awake" } },
      })
      expect(yield* dispatcher.tick(AWAKE_AT)).toBe(1)
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

// §C4 RE-ENTRANCY GUARD (end-to-end) — even with a wildcard-trigger agent registered (which WOULD match
// a coordination event), handling an agent.task.* / agent.handoff.* event must NOT reach the DispatchPort
// (no fresh coordinate() pass), while a normal event through the SAME wildcard agent still dispatches.
// This proves the loop that would otherwise cascade unbounded past the §E2 ceiling is closed.
describe("EventDispatcher §C4 coordination re-entrancy guard", () => {
  const it = testEffect(makeLayer(undefined, wildcardAgentList))

  it.effect("a coordination event does NOT dispatch (no coordinate() re-entry), still acked", () =>
    Effect.gen(function* () {
      resetRecorder()
      setNow(2_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      // publish a coordination event exactly as the Multi-Agent Runtime would (system source, high).
      const coord = yield* bus.publish({
        type: "agent.task.completed",
        source: "system",
        workspaceID: "wrk_1",
        priority: "high",
        idempotencyKey: "coord-1",
        payload: { taskID: "t1", artifacts: [] },
      })
      const decision = yield* dispatcher.handle(coord)
      expect(decision).toEqual({ type: "dropped", reason: "coordination" })
      expect(recorded.length).toBe(0) // the DispatchPort was never invoked → no new coordinate() pass
      // terminal drop is acked (kept in the durable log for the trace, not retry-eligible).
      expect((yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).length).toBe(0)
    }),
  )

  it.effect("the SAME wildcard agent still dispatches a normal (non-coordination) event", () =>
    Effect.gen(function* () {
      resetRecorder()
      setNow(2_500)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(input({ idempotencyKey: "wc-ok" }))
      const decision = yield* dispatcher.handle(event)
      expect(decision.type).toBe("dispatch")
      expect(recorded.map((r) => r.event.type)).toEqual(["ci.failure"]) // guard is scoped, not blanket
    }),
  )
})
