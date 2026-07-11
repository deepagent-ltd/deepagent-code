import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { EventDispatcher } from "../../src/session/event-dispatcher"
import { MultiAgentRuntime } from "../../src/session/multi-agent-runtime"
import type { SubagentTurnRunner } from "../../src/session/goal-loop-wiring"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { Observability } from "@deepagent-code/core/deepagent/observability"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { Database } from "@deepagent-code/core/database/database"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { testEffect } from "../lib/effect"

// V4.0 §I — END-TO-END integration. Wires the real chain across all waves over one in-memory DB:
//   publish(event) → EventDispatcher.handle (§A4 flag+registry+route) → MultiAgentRuntime.dispatch
//   (§C partition→gate→arbitrate→run) → §C4 coordination events on the bus → Observability.trace/metrics
//   (§F) assembles the spine. Proves the pieces compose, not just pass in isolation (§J: event source →
//   specialized agents → coordination → observable trace).

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

// two specialized agents (§J: ≥3 in prod; 2 suffices to exercise multi-agent coordination here).
const fixer: AgentDescriptor = {
  id: "CodeFixAgent",
  name: "CodeFixAgent",
  displayName: "Code Fix Agent",
  visible: true,
  capabilities: ["code_edit", "test_run"],
  triggers: [{ event: "ci.failure" }],
  autonomy: "level_2",
}
const registry = Layer.succeed(AgentListProviderService, {
  listAgents: () => Effect.succeed([fixer]),
  findByTrigger: () => Effect.succeed([fixer]),
  findByCapability: () => Effect.succeed([]),
})

// a fake turn runner records which agents ran (no real SessionPrompt in the test). `runnerOk` toggles
// the leaf outcome so the failure→nack→retry propagation can be exercised end-to-end.
let ran: string[] = []
let runnerOk = true
const runner: SubagentTurnRunner = (input) =>
  Effect.sync(() => {
    ran.push(input.agentType)
    return { ok: runnerOk, structured: undefined, text: "fixed", tokensUsed: 100, cost: 0 }
  })

const makeLayer = (flags?: Partial<RuntimeFlags.Info>) => {
  const database = Database.layerFromPath(":memory:")
  const flagsLayer = RuntimeFlags.layer({
    v4EventDrivenIm: true,
    v4AgentPushEnabled: true,
    v4MultiAgentRuntime: true,
    v4AgentAutonomyLevel2: true,
    ...flags,
  })
  const core = Layer.mergeAll(
    DeepAgentEventBus.layerWith({ now }),
    Scheduler.layerWith({ now }),
    Observability.layerWith({ now }),
  ).pipe(Layer.provideMerge(database))
  // MultiAgentRuntime is the REAL DispatchPort the dispatcher hands routed events to.
  const runtime = MultiAgentRuntime.layerWith({ runner }).pipe(Layer.provide(core), Layer.provide(registry))
  return { core, flagsLayer, runtime, database }
}

// build a dispatcher layer whose DispatchPort is the live MultiAgentRuntime.
const fullLayer = (() => {
  const { core, flagsLayer, runtime, database } = makeLayer()
  const dispatcherLayer = Layer.unwrap(
    Effect.gen(function* () {
      const rt = yield* MultiAgentRuntime.Service
      return EventDispatcher.layerWith({ dispatchPort: { dispatch: rt.dispatch }, runLoops: false, now }).pipe(
        Layer.provide(core),
        Layer.provide(registry),
        Layer.provide(flagsLayer),
      )
    }),
  ).pipe(Layer.provide(runtime), Layer.provide(core), Layer.provide(registry))
  return Layer.mergeAll(dispatcherLayer, runtime, core, flagsLayer).pipe(Layer.provideMerge(database))
})()

const it = testEffect(fullLayer)

const ciEvent = (over?: Partial<DeepAgentEvent.PublishInput>): DeepAgentEvent.PublishInput => ({
  type: "ci.failure",
  source: "ci",
  workspaceID: "wrk_1",
  payload: { files: ["src/broken.ts"], failedTests: 2 },
  ...over,
})

describe("V4.0 end-to-end (§I/§J)", () => {
  it.effect("event → dispatch → multi-agent coordinate → coordination events → observable trace", () =>
    Effect.gen(function* () {
      ran = []
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const obs = yield* Observability.Service

      // 1. an event source publishes (ci.failure with a correlationID that seeds the trace spine).
      const event = yield* bus.publish(ciEvent({ idempotencyKey: "e2e-1", correlationID: "trace-1" }))

      // 2. the dispatcher routes it → MultiAgentRuntime coordinates the partition.
      const decision = yield* dispatcher.handle(event)
      expect(decision.type).toBe("dispatch")

      // 3. the specialized agent ran both subtasks (code_edit → test_run).
      expect(ran).toEqual(["CodeFixAgent", "CodeFixAgent"])

      // 4. §C4 coordination events landed on the bus (started + completed per subtask).
      const started = yield* bus.recentByType({ type: "agent.task.started", windowMs: Number.MAX_SAFE_INTEGER, now: 1_000 })
      const completed = yield* bus.recentByType({ type: "agent.task.completed", windowMs: Number.MAX_SAFE_INTEGER, now: 1_000 })
      expect(started.length).toBe(2)
      expect(completed.length).toBe(2)

      // 5. §F observability: the trace spine chains the triggering event → its coordination events
      //    (they set correlationID = event.correlationID), and metrics show 100% success.
      const trace = yield* obs.trace({ workspaceID: "wrk_1", correlationID: "trace-1" })
      expect(trace.some((n) => n.type === "ci.failure")).toBe(true)
      expect(trace.some((n) => n.type === "agent.task.completed")).toBe(true)
      // causal linkage: the coordination events name the triggering event as their cause.
      const coordNodes = trace.filter((n) => n.type.startsWith("agent.task."))
      expect(coordNodes.length).toBeGreaterThan(0)
      expect(coordNodes.every((n) => n.causationID === event.id)).toBe(true)
      const metrics = yield* obs.metrics({ workspaceID: "wrk_1", from: 0, to: 2_000 })
      expect(metrics.agentTaskCompleted).toBe(2)
      expect(metrics.agentTaskFailed).toBe(0)
      expect(metrics.agentTaskSuccessRate).toBe(1)
    }),
  )

  it.effect("§I failure propagation: a failing agent turn → dispatch fails → bus nacks → pending retry", () =>
    Effect.gen(function* () {
      ran = []
      runnerOk = false // the leaf turn fails
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      // a grouped subscriber so publish records a durable pending delivery for "router".
      yield* bus
        .subscribe({ group: EventDispatcher.DISPATCH_GROUP })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* bus.publish(ciEvent({ idempotencyKey: "fail-1" }))
      // the dispatcher routed + coordinated, but the runner failed → hasUnfinished → dispatch fails →
      // the dispatcher nacks. handle() itself does not throw (it catches + nacks).
      yield* dispatcher.handle(event)
      // the delivery is now pending-with-backoff (nacked), recoverable by the retry pump — NOT acked away.
      const due = yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)
      expect(due.map((d) => d.eventID)).toContain(event.id)
      expect(due.find((d) => d.eventID === event.id)?.attempts).toBe(1)
      runnerOk = true // reset for other tests
    }),
  )

  it.effect("§A4 scheduler → dispatcher tick → event published → routed end-to-end", () =>
    Effect.gen(function* () {
      ran = []
      setNow(0)
      const scheduler = yield* Scheduler.Service
      const dispatcher = yield* EventDispatcher.Service
      const bus = yield* DeepAgentEventBus.Service

      // a scheduled ci.failure fires at t=5000 → tick publishes it → its own subscribe path would route
      // it; here we drive tick then handle the published event to prove the scheduler→bus hop.
      yield* scheduler.scheduleDelay({
        workspaceID: "wrk_1",
        fireAt: 5_000,
        eventTemplate: { type: "ci.failure", source: "schedule", workspaceID: "wrk_1", payload: { files: ["s.ts"] } },
      })
      const fired = yield* dispatcher.tick(5_000)
      expect(fired).toBe(1)
      const recent = yield* bus.recentByType({ type: "ci.failure", windowMs: Number.MAX_SAFE_INTEGER, now: 5_000 })
      expect(recent.length).toBe(1)
      // route the scheduler-published event through the runtime.
      yield* dispatcher.handle(recent[0])
      expect(ran).toEqual(["CodeFixAgent", "CodeFixAgent"])
    }),
  )
})

describe("V4.0 §H2 rollback safety — every flag OFF disables the feature", () => {
  const offLayer = (() => {
    const { core, flagsLayer, runtime, database } = makeLayer({
      v4EventDrivenIm: false,
      v4MultiAgentRuntime: false,
    })
    const dispatcherLayer = Layer.unwrap(
      Effect.gen(function* () {
        const rt = yield* MultiAgentRuntime.Service
        return EventDispatcher.layerWith({ dispatchPort: { dispatch: rt.dispatch }, runLoops: false, now }).pipe(
          Layer.provide(core),
          Layer.provide(registry),
          Layer.provide(flagsLayer),
        )
      }),
    ).pipe(Layer.provide(runtime), Layer.provide(core), Layer.provide(registry))
    return Layer.mergeAll(dispatcherLayer, runtime, core, flagsLayer).pipe(Layer.provideMerge(database))
  })()
  const it = testEffect(offLayer)

  it.effect("flags OFF: a published event is durably retained but NOT dispatched (§H2 rollback-safe)", () =>
    Effect.gen(function* () {
      ran = []
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      // the event still persists (durable — §H2: worker stop keeps events), but routing is fail-closed.
      const event = yield* bus.publish(ciEvent({ idempotencyKey: "off-1" }))
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "dropped", reason: "flag_disabled" })
      expect(ran).toEqual([]) // no agent executed
      // durability: the event is still replayable (retained, not dropped) — §H2 keeps persisted events.
      const replayed = yield* bus.recentByType({ type: "ci.failure", windowMs: Number.MAX_SAFE_INTEGER, now: 1_000 })
      expect(replayed.length).toBe(1)
    }),
  )
})
