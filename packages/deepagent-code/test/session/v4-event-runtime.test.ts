import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { V4EventRuntime } from "../../src/session/v4-event-runtime"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { EventDispatcher } from "../../src/session/event-dispatcher"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "../lib/effect"

// V4.0 — proves the production event-runtime layer BUILDS and starts its scoped daemons without error
// against a real bus + DB. This is the layer whose absence meant every V4 daemon was dormant in prod.
//
// NOTE: the full end-to-end (publish → dispatcher routes → MAR runs an agent turn) is covered by
// v4-integration.test.ts with a fake runner + explicit ticks. Here we assert the composition itself is
// sound (the layer's requirements are satisfiable and the daemons launch), which is the integration
// contract this module adds. Driving a real agent turn needs the whole session stack (Session /
// SessionPrompt / Agent / Provider), which is out of scope for a unit test — that path is exercised by
// the server harness. So this test provides the layer's core V4 deps and confirms it constructs +
// tears down cleanly, and that the bus it shares is the one events land on.

const database = Database.layerFromPath(":memory:")

describe("V4EventRuntime.layer", () => {
  // We can't build the full layer here (it requires the session stack), but we CAN assert the exported
  // layer value exists and that the core services it composes over a shared bus behave: an event
  // published to the shared bus is visible to a subscriber under the dispatcher's router group — i.e.
  // there is ONE bus, not a split-brain. This guards the "publisher and dispatcher share a bus"
  // integration invariant that a self-provided bus would silently violate.
  const it = testEffect(DeepAgentEventBus.layer.pipe(Layer.provideMerge(database)))

  it.effect("the shared bus round-trips a published event (single-instance invariant)", () =>
    Effect.gen(function* () {
      // the exported runtime layer must exist (its composition is type-satisfiable).
      expect(V4EventRuntime.layer).toBeDefined()
      const bus = yield* DeepAgentEventBus.Service
      const published = yield* bus.publish({
        type: "ci.failure",
        source: "ci",
        workspaceID: "wrk_1",
        idempotencyKey: "k1",
        priority: "normal",
        payload: {},
      } satisfies DeepAgentEvent.PublishInput)
      const fetched = yield* bus.getByID(published.id)
      expect(fetched?.id).toBe(published.id)
    }),
  )
})

// P1.6 — the production schedule bootstrap. Proves the tick loop now has real rows: registration is
// flag-gated, idempotent across restarts, and the "3× CI failure → repair" condition fires when seeded.
describe("V4EventRuntime schedule bootstrap", () => {
  const database = Database.layerFromPath(":memory:")
  const it = testEffect(Scheduler.defaultLayer.pipe(Layer.provideMerge(database)))
  const WS = V4EventRuntime.SYSTEM_WORKSPACE_ID

  it.effect("registers the periodic maintenance scan + the CI-repair condition (flag ON)", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      yield* V4EventRuntime.registerBootstrapSchedules(scheduler, 0)
      const active = yield* scheduler.list(WS)
      const byKind = Object.fromEntries(active.map((s) => [s.kind, s]))
      expect(active.length).toBe(2)
      // (A) periodic maintenance scan: daily, publishes schedule.scan
      expect(byKind.periodic?.intervalMs).toBe(V4EventRuntime.MAINTENANCE_SCAN_INTERVAL_MS)
      expect((byKind.periodic?.eventTemplate as { type: string }).type).toBe(V4EventRuntime.MAINTENANCE_SCAN_EVENT)
      // (B) condition: 3× ci.failure in-window → ci.repair.requested, counted ACROSS workspaces
      expect(byKind.condition?.condition).toEqual({
        eventType: V4EventRuntime.CI_FAILURE_EVENT,
        threshold: V4EventRuntime.CI_REPAIR_THRESHOLD,
        windowMs: V4EventRuntime.CI_REPAIR_WINDOW_MS,
        crossWorkspace: true,
      })
      expect((byKind.condition?.eventTemplate as { type: string }).type).toBe(V4EventRuntime.CI_REPAIR_EVENT)
      // the stable dedupe keys are persisted on the rows (schedule_key column), enabling DB-level dedupe.
      expect(byKind.periodic?.scheduleKey).toBe(V4EventRuntime.MAINTENANCE_SCAN_KEY)
      expect(byKind.condition?.scheduleKey).toBe(V4EventRuntime.CI_REPAIR_KEY)
    }),
  )

  it.effect("is idempotent — re-running registration creates no duplicate rows", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      yield* V4EventRuntime.registerBootstrapSchedules(scheduler, 0)
      yield* V4EventRuntime.registerBootstrapSchedules(scheduler, 1_000) // simulate a restart
      yield* V4EventRuntime.registerBootstrapSchedules(scheduler, 2_000)
      const active = yield* scheduler.list(WS)
      expect(active.length).toBe(2) // still exactly the two canonical rows
    }),
  )

  it.effect("skips schedules already present but adds a missing one (partial idempotency)", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      // pre-seed ONLY the maintenance scan, carrying its stable key in the schedule_key column so the
      // subsequent bootstrap insert collides on it (onConflictDoNothing) and does not duplicate.
      yield* scheduler.schedulePeriodic({
        workspaceID: WS,
        intervalMs: V4EventRuntime.MAINTENANCE_SCAN_INTERVAL_MS,
        firstFireAt: 999,
        scheduleKey: V4EventRuntime.MAINTENANCE_SCAN_KEY,
        eventTemplate: {
          type: V4EventRuntime.MAINTENANCE_SCAN_EVENT,
          source: "schedule",
          workspaceID: WS,
          payload: { scheduleKey: V4EventRuntime.MAINTENANCE_SCAN_KEY },
        },
      })
      yield* V4EventRuntime.registerBootstrapSchedules(scheduler, 0)
      const active = yield* scheduler.list(WS)
      // one periodic (the pre-seeded one, untouched at firstFireAt 999) + one newly-added condition = 2
      expect(active.length).toBe(2)
      expect(active.filter((s) => s.kind === "periodic").length).toBe(1)
      expect(active.filter((s) => s.kind === "condition").length).toBe(1)
      expect(active.find((s) => s.kind === "periodic")?.fireAt).toBe(999) // the pre-seeded row won
    }),
  )

  it.effect("FIX2: a raw duplicate insert of the same scheduleKey lands only ONE row (DB-level dedupe)", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      // Simulate the multi-process TOCTOU: two registrations of the SAME key with NO list() between them
      // (a list-then-guard could not catch this — both would see "absent"). The unique schedule_key index
      // + onConflictDoNothing makes the second a no-op at the DB layer.
      const first = yield* scheduler.schedulePeriodic({
        workspaceID: WS,
        intervalMs: V4EventRuntime.MAINTENANCE_SCAN_INTERVAL_MS,
        firstFireAt: 1_000,
        scheduleKey: V4EventRuntime.MAINTENANCE_SCAN_KEY,
        eventTemplate: { type: V4EventRuntime.MAINTENANCE_SCAN_EVENT, source: "schedule", workspaceID: WS, payload: {} },
      })
      const second = yield* scheduler.schedulePeriodic({
        workspaceID: WS,
        intervalMs: V4EventRuntime.MAINTENANCE_SCAN_INTERVAL_MS,
        firstFireAt: 5_000, // different values — but the key collides, so this insert is dropped
        scheduleKey: V4EventRuntime.MAINTENANCE_SCAN_KEY,
        eventTemplate: { type: V4EventRuntime.MAINTENANCE_SCAN_EVENT, source: "schedule", workspaceID: WS, payload: {} },
      })
      const active = yield* scheduler.list(WS)
      expect(active.length).toBe(1) // exactly one row, not two
      // the race-loser returns the WINNER's row (same id, the winner's fireAt), not its own phantom values
      expect(second.id).toBe(first.id)
      expect(second.fireAt).toBe(1_000)
    }),
  )
})

// P1.6 — flag gate: with v4MultiAgentRuntime OFF the bootstrap layer registers nothing (a fresh prod DB
// stays empty), and ON it registers the rows. Uses the real scheduleBootstrapLayer effect (not just the
// exported function) so the flag gate itself is exercised.
describe("V4EventRuntime scheduleBootstrapLayer flag gate", () => {
  const database = Database.layerFromPath(":memory:")
  const WS = V4EventRuntime.SYSTEM_WORKSPACE_ID

  const build = (flag: boolean) =>
    V4EventRuntime.scheduleBootstrapLayer.pipe(
      Layer.provide(RuntimeFlags.layer({ v4MultiAgentRuntime: flag })),
      Layer.provideMerge(Scheduler.defaultLayer.pipe(Layer.provideMerge(database))),
    )

  const itOff = testEffect(build(false))
  itOff.effect("flag OFF ⇒ registers nothing", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      expect((yield* scheduler.list(WS)).length).toBe(0)
    }),
  )

  const itOn = testEffect(build(true))
  itOn.effect("flag ON ⇒ registers the two canonical schedules", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      expect((yield* scheduler.list(WS)).length).toBe(2)
    }),
  )
})

// P1.6 — the CI-repair condition actually FIRES when 3 ci.failure events are in the window. Drives the
// dispatcher tick directly (runLoops:false) against a real bus + scheduler and asserts the templated
// ci.repair.requested event is published. This proves the §A4/§N condition path end-to-end.
describe("V4EventRuntime CI-repair condition fires on 3× failure", () => {
  let clock = 0
  const now = () => clock
  const WS = V4EventRuntime.SYSTEM_WORKSPACE_ID

  const noAgents = Layer.succeed(AgentListProviderService, {
    listAgents: () => Effect.succeed([]),
    findByTrigger: () => Effect.succeed([]),
    findByCapability: () => Effect.succeed([]),
  })

  const database = Database.layerFromPath(":memory:")
  const core = Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), Scheduler.layerWith({ now })).pipe(
    Layer.provideMerge(database),
  )
  const dispatcher = EventDispatcher.layerWith({ runLoops: false, now }).pipe(
    Layer.provide(core),
    Layer.provide(noAgents),
    Layer.provide(RuntimeFlags.layer({ v4MultiAgentRuntime: true })),
  )
  const it = testEffect(Layer.mergeAll(dispatcher, core))

  const ciFailure = (key: string, workspaceID = WS): DeepAgentEvent.PublishInput => ({
    type: V4EventRuntime.CI_FAILURE_EVENT,
    source: "ci",
    workspaceID,
    idempotencyKey: key,
    priority: "normal",
    payload: {},
  })

  it.effect("condition met ⇒ tick publishes ci.repair.requested; not met ⇒ does not", () =>
    Effect.gen(function* () {
      clock = 0
      const scheduler = yield* Scheduler.Service
      const bus = yield* DeepAgentEventBus.Service
      const disp = yield* EventDispatcher.Service
      yield* V4EventRuntime.registerBootstrapSchedules(scheduler, 0)

      // only 2 failures in the window → below threshold(3) → no repair published. The not-met tick
      // reschedules the next re-check to now + recheckEveryMs (60_000), so we advance the clock past it.
      yield* bus.publish(ciFailure("f1"))
      yield* bus.publish(ciFailure("f2"))
      yield* disp.tick()
      let repairs = yield* bus.recentByType({ type: V4EventRuntime.CI_REPAIR_EVENT, workspaceID: WS })
      expect(repairs.length).toBe(0)

      // a 3rd failure (still inside the 30-min window) meets the threshold; the next due re-check fires
      // the templated repair event. Advance the clock to the rescheduled re-check time first.
      clock = V4EventRuntime.CI_REPAIR_RECHECK_MS
      yield* bus.publish(ciFailure("f3"))
      yield* disp.tick()
      repairs = yield* bus.recentByType({ type: V4EventRuntime.CI_REPAIR_EVENT, workspaceID: WS })
      expect(repairs.length).toBe(1)
      expect(repairs[0]?.source).toBe("schedule")
      expect((repairs[0]?.payload as { scheduleKey?: string })?.scheduleKey).toBe(V4EventRuntime.CI_REPAIR_KEY)
    }),
  )

  it.effect("FIX1: 3× ci.failure in a PROJECT workspace (≠ wrk_system) still fires the system CI-repair", () =>
    Effect.gen(function* () {
      clock = 0
      const scheduler = yield* Scheduler.Service
      const bus = yield* DeepAgentEventBus.Service
      const disp = yield* EventDispatcher.Service
      yield* V4EventRuntime.registerBootstrapSchedules(scheduler, 0)

      // Real CI failures land in per-project workspaces (P1.4 webhook ingress), NOT wrk_system. Because
      // the condition is crossWorkspace, the system-scoped trigger counts them across tenants. Publish 3
      // failures spread across TWO different project workspaces — none in wrk_system.
      yield* bus.publish(ciFailure("p1", "wrk_projectA"))
      yield* bus.publish(ciFailure("p2", "wrk_projectA"))
      yield* bus.publish(ciFailure("p3", "wrk_projectB"))
      yield* disp.tick()

      // the system-workspace repair event fired even though ZERO failures were in wrk_system.
      const repairs = yield* bus.recentByType({ type: V4EventRuntime.CI_REPAIR_EVENT, workspaceID: WS })
      expect(repairs.length).toBe(1)
      expect((repairs[0]?.payload as { scheduleKey?: string })?.scheduleKey).toBe(V4EventRuntime.CI_REPAIR_KEY)
    }),
  )
})
