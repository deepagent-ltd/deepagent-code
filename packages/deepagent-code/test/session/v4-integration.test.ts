import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { EventDispatcher } from "../../src/session/event-dispatcher"
import { MultiAgentRuntime } from "../../src/session/multi-agent-runtime"
import type { SubagentTurnRunner } from "../../src/session/goal-loop-wiring"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { Observability } from "@deepagent-code/core/deepagent/observability"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
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
    ...flags,
  })
  const core = Layer.mergeAll(
    DeepAgentEventBus.layerWith({ now }),
    Scheduler.layerWith({ now }),
    Observability.layerWith({ now }),
    ApprovalQueue.layerWith({ now }),
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
      const ranAfterFail = ran.length
      expect(ranAfterFail).toBeGreaterThan(0) // the subtasks DID run (and failed)

      // NOW the runner recovers and the retry pump re-drives the event. The failed subtask must ACTUALLY
      // RE-RUN — the started-before-run guard must not short-circuit it as "already done" (the §D HIGH
      // fix: the idempotency guard checks agent.task.completed, not started).
      runnerOk = true
      const redriven = yield* dispatcher.pumpRetries(Number.MAX_SAFE_INTEGER)
      expect(redriven).toBeGreaterThan(0)
      expect(ran.length).toBeGreaterThan(ranAfterFail) // re-ran on retry, not skipped
      // the event is now fully handled → no longer pending.
      expect((yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).map((d) => d.eventID)).not.toContain(event.id)
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

// §E2 + §D2 no-silent-loss — the goal-manager emit sequence must NOT lose an approval-queue event to a
// shared-workspace publish flood. This replicates goal-manager.emitGoalLifecycleEvent's exact logic
// (priority via LMNEvents.isApprovalQueueCandidate → tryPublish → offer on published) against the REAL
// bus + ApprovalQueue, with the per-workspace window exhausted by UNRELATED normal traffic.
describe("V4.0 §E2/§D2 goal.rolled_back survives a shared-workspace publish flood", () => {
  const it = testEffect(fullLayer)

  // faithful mirror of goal-manager.emitGoalLifecycleEvent's publish+offer (the code under test).
  const emitGoalLifecycle = (
    bus: DeepAgentEventBus.Interface,
    approvalQueue: ApprovalQueue.Interface,
    args: { workspaceID: string; eventType: string; goalId: string; idempotencyKey: string; limit: number },
  ) =>
    Effect.gen(function* () {
      const priority = LMNEvents.isApprovalQueueCandidate(args.eventType) ? "high" : "normal"
      const outcome = yield* bus.tryPublish(
        {
          type: args.eventType,
          source: "system",
          workspaceID: args.workspaceID,
          correlationID: args.goalId,
          idempotencyKey: args.idempotencyKey,
          priority,
          payload: { goalId: args.goalId, phase: "rolled_back" },
        },
        { limit: args.limit },
      )
      if ("dropped" in outcome) return { queued: null, dropped: true as const }
      const queued = yield* approvalQueue.offer(outcome.published)
      return { queued, dropped: false as const }
    })

  it.effect("with the publish window exhausted, goal.rolled_back still persists AND reaches the queue", () =>
    Effect.gen(function* () {
      setNow(3_000)
      const bus = yield* DeepAgentEventBus.Service
      const approvalQueue = yield* ApprovalQueue.Service
      const wrk = "wrk_flood"
      // 1. exhaust the per-workspace publish window with UNRELATED normal im.message.created traffic
      //    (limit=2 for the test) — the shared limiter is now saturated for this minute.
      for (const k of ["im-a", "im-b"]) {
        const r = yield* bus.tryPublish(
          { type: LMNEvents.IM_MESSAGE_CREATED, source: "im", workspaceID: wrk, priority: "normal", idempotencyKey: k, payload: {} },
          { limit: 2 },
        )
        expect("published" in r).toBe(true)
      }
      // sanity: a further NORMAL publish is now shed by the exhausted window.
      const shed = yield* bus.tryPublish(
        { type: LMNEvents.IM_MESSAGE_CREATED, source: "im", workspaceID: wrk, priority: "normal", idempotencyKey: "im-c", payload: {} },
        { limit: 2 },
      )
      expect(shed).toEqual({ dropped: "rate_limited" })

      // 2. a goal.rolled_back arrives in the SAME saturated minute. Pre-fix it was "normal" → shed →
      //    never offered (silent loss). Post-fix it is elevated to "high" → bypasses the gate.
      const result = yield* emitGoalLifecycle(bus, approvalQueue, {
        workspaceID: wrk,
        eventType: LMNEvents.GOAL_ROLLED_BACK,
        goalId: "g-rollback",
        idempotencyKey: "goal:g-rollback:rolled_back:1",
        limit: 2,
      })
      expect(result.dropped).toBe(false) // NOT shed despite the exhausted window
      // persisted on the durable log …
      const persisted = yield* bus.recentByType({
        type: LMNEvents.GOAL_ROLLED_BACK,
        workspaceID: wrk,
        windowMs: Number.MAX_SAFE_INTEGER,
        now: 3_000,
      })
      expect(persisted.length).toBe(1)
      // … AND it reached the Approval Queue for human review (the whole point of no-silent-loss).
      expect(result.queued).not.toBeNull()
      expect(result.queued?.eventID).toBe(persisted[0].id) // the queued item is exactly this event
      const pending = yield* approvalQueue.listPending(wrk)
      expect(pending.map((p) => p.eventID)).toContain(persisted[0].id)
      expect(pending.some((p) => p.summary.startsWith("Goal rolled back"))).toBe(true)
    }),
  )

  it.effect("goal.tick / goal.completed stay normal and remain correctly sheddable under load", () =>
    Effect.gen(function* () {
      // membership check is the exact predicate the production priority ternary uses.
      expect(LMNEvents.isApprovalQueueCandidate(LMNEvents.GOAL_ROLLED_BACK)).toBe(true)
      expect(LMNEvents.isApprovalQueueCandidate(LMNEvents.GOAL_NEEDS_HUMAN)).toBe(true)
      expect(LMNEvents.isApprovalQueueCandidate(LMNEvents.GOAL_TICK)).toBe(false)
      expect(LMNEvents.isApprovalQueueCandidate(LMNEvents.GOAL_COMPLETED)).toBe(false)

      setNow(4_000)
      const bus = yield* DeepAgentEventBus.Service
      const wrk = "wrk_tick"
      // exhaust the window, then a goal.tick (normal) is correctly shed — ticks are load-shed by design.
      yield* bus.tryPublish(
        { type: LMNEvents.IM_MESSAGE_CREATED, source: "im", workspaceID: wrk, priority: "normal", idempotencyKey: "t-fill", payload: {} },
        { limit: 1 },
      )
      const tickPriority = LMNEvents.isApprovalQueueCandidate(LMNEvents.GOAL_TICK) ? "high" : "normal"
      const tick = yield* bus.tryPublish(
        { type: LMNEvents.GOAL_TICK, source: "system", workspaceID: wrk, priority: tickPriority, idempotencyKey: "goal:g:tick:1", payload: {} },
        { limit: 1 },
      )
      expect(tick).toEqual({ dropped: "rate_limited" })
    }),
  )
})
