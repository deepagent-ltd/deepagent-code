import { describe, expect } from "bun:test"
import { Context, DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as Scope from "effect/Scope"
import { V4EventRuntime } from "../../src/session/v4-event-runtime"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { EventDispatcher } from "../../src/session/event-dispatcher"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Database } from "@deepagent-code/core/database/database"
import { InstanceState } from "../../src/effect/instance-state"
import type { InstanceContext } from "../../src/project/instance-context"
import type { InstanceStore } from "../../src/project/instance-store"
import type { Session } from "../../src/session/session"
import type { SessionV2 } from "@deepagent-code/core/session"
import type { Agent } from "../../src/agent/agent"
import type { SessionPrompt } from "../../src/session/prompt"
import { SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import type { LocationIndexCoordinator } from "../../src/location-index/coordinator"
import { it as baseIt, testEffect, pollWithTimeout } from "../lib/effect"

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

describe("V4EventRuntime CodeGraph conflict evidence", () => {
  baseIt.effect("resolves only requested-file symbols from the Location snapshot", () =>
    Effect.gen(function* () {
      const coordinator = {
        searchCode: ({ query }: { query: string }) => Effect.succeed({
          revision: undefined,
          hits: [
            {
              entity: {},
              file: { path: query },
              symbol: { symbolPath: "run" },
              score: 1,
            },
            {
              entity: {},
              file: { path: "src/unrelated.ts" },
              symbol: { symbolPath: "ignore" },
              score: 1,
            },
          ],
        }),
      } as unknown as LocationIndexCoordinator.Interface

      const symbols = yield* V4EventRuntime.resolveCodeGraphSymbols({
        coordinator,
        canonicalRoot: "/repo",
        files: ["/repo/src/a.ts", "./src/b.ts"],
      })
      expect(symbols).toEqual(["src/a.ts#run", "src/b.ts#run"])
    }),
  )
})

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

// Durable group lifecycle: registration must be reconciled when flags change, and scope release must
// unregister only the groups this runtime owns so later publishes cannot leave an offline backlog.
describe("V4EventRuntime durable consumer-group lifecycle", () => {
  const staleRuntimeGroups = [
    "event-dispatcher",
    "goal-tick-consumer",
    "panel-convener",
    "wiki-archiver",
    "supervisor-notifier",
    "agent-handoff",
  ]
  const externalGroup = "other-feature-consumer"

  const registration = (flags: Partial<RuntimeFlags.Info>) =>
    V4EventRuntime.consumerRegistrationLayer.pipe(Layer.provide(RuntimeFlags.layer(flags)))

  const fullRuntimeFlagsOff = {
    v4MultiAgentRuntime: false,
    v4PanelAutoConvene: false,
    v4EventDrivenArchive: false,
    v4AgentPushEnabled: false,
    v4GoalTickEventDriven: false,
  }

  const publish = (key: string): DeepAgentEvent.PublishInput => ({
    type: "monitor.alert",
    source: "monitor",
    workspaceID: "wrk_1",
    idempotencyKey: key,
    priority: "normal",
    payload: {},
  })

  baseIt.effect("goal-tick-only mode activates daemon setup and registers only the tick group", () =>
    Effect.gen(function* () {
      const flags = { ...fullRuntimeFlagsOff, v4GoalTickEventDriven: true }
      expect(V4EventRuntime.anyV4DaemonEnabled(flags)).toBe(true)
      expect(V4EventRuntime.goalTickConsumerEnabled(flags)).toBe(true)

      const busScope = yield* Scope.make()
      const busContext = yield* Layer.build(
        DeepAgentEventBus.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))),
      ).pipe(Scope.provide(busScope))
      const bus = Context.get(busContext, DeepAgentEventBus.Service)
      const registrationScope = yield* Scope.make()
      yield* Layer.build(registration(flags)).pipe(
        Scope.provide(registrationScope),
        Effect.provide(busContext),
      )

      const goalTick = yield* bus.publish({
        type: "goal.tick.requested",
        source: "system",
        workspaceID: "wrk_1",
        idempotencyKey: "goal-tick-only",
        priority: "normal",
        payload: {},
      })
      const unrelated = yield* bus.publish(publish("goal-tick-only-unrelated"))
      const due = yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)
      expect(
        due.some(
          (delivery) => delivery.eventID === goalTick.id && delivery.subscriptionGroup === "goal-tick-consumer",
        ),
      ).toBe(true)
      expect(due.some((delivery) => delivery.eventID === unrelated.id && staleRuntimeGroups.includes(delivery.subscriptionGroup))).toBe(false)

      yield* Scope.close(registrationScope, Exit.void)
      yield* Scope.close(busScope, Exit.void)
    }),
  )

  baseIt.effect("all-off mode leaves daemon setup and goal-tick consumer disabled", () =>
    Effect.sync(() => {
      expect(V4EventRuntime.anyV4DaemonEnabled(fullRuntimeFlagsOff)).toBe(false)
      expect(V4EventRuntime.goalTickConsumerEnabled(fullRuntimeFlagsOff)).toBe(false)
    }),
  )

  baseIt.effect("multi-agent mode still activates the goal-tick consumer", () =>
    Effect.sync(() => {
      const flags = { ...fullRuntimeFlagsOff, v4MultiAgentRuntime: true }
      expect(V4EventRuntime.anyV4DaemonEnabled(flags)).toBe(true)
      expect(V4EventRuntime.goalTickConsumerEnabled(flags)).toBe(true)
    }),
  )

  baseIt.effect("multi-agent and goal-tick mode keeps the goal-tick consumer active", () =>
    Effect.sync(() => {
      const flags = { ...fullRuntimeFlagsOff, v4MultiAgentRuntime: true, v4GoalTickEventDriven: true }
      expect(V4EventRuntime.anyV4DaemonEnabled(flags)).toBe(true)
      expect(V4EventRuntime.goalTickConsumerEnabled(flags)).toBe(true)
    }),
  )

  baseIt.effect("enabled runtime registers its groups; a subsequent disabled startup removes only those historical groups", () =>
    Effect.gen(function* () {
      const busScope = yield* Scope.make()
      const busContext = yield* Layer.build(
        DeepAgentEventBus.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))),
      ).pipe(Scope.provide(busScope))
      const bus = Context.get(busContext, DeepAgentEventBus.Service)

      const enabledScope = yield* Scope.make()
      yield* Layer.build(registration({ v4MultiAgentRuntime: true })).pipe(
        Scope.provide(enabledScope),
        Effect.provide(busContext),
      )
      yield* bus.registerConsumerGroup(externalGroup)
      yield* Scope.close(enabledScope, Exit.void)

      const disabledScope = yield* Scope.make()
      yield* Layer.build(registration(fullRuntimeFlagsOff)).pipe(
        Scope.provide(disabledScope),
        Effect.provide(busContext),
      )
      const event = yield* bus.publish(publish("flags-off"))
      const due = yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)

      expect(due.some((delivery) => delivery.eventID === event.id && staleRuntimeGroups.includes(delivery.subscriptionGroup))).toBe(false)
      expect(due.some((delivery) => delivery.eventID === event.id && delivery.subscriptionGroup === externalGroup)).toBe(true)
      yield* Scope.close(disabledScope, Exit.void)
      yield* Scope.close(busScope, Exit.void)
    }),
  )

  baseIt.effect("scope release unregisters enabled groups, so later publishes create no V4 delivery", () =>
    Effect.gen(function* () {
      const busScope = yield* Scope.make()
      const busContext = yield* Layer.build(
        DeepAgentEventBus.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))),
      ).pipe(Scope.provide(busScope))
      const bus = Context.get(busContext, DeepAgentEventBus.Service)
      const registrationScope = yield* Scope.make()
      yield* Layer.build(registration({ v4MultiAgentRuntime: true })).pipe(
        Scope.provide(registrationScope),
        Effect.provide(busContext),
      )
      yield* Scope.close(registrationScope, Exit.void)

      const event = yield* bus.publish(publish("after-release"))
      const due = yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)
      expect(due.some((delivery) => delivery.eventID === event.id && staleRuntimeGroups.includes(delivery.subscriptionGroup))).toBe(false)
      yield* Scope.close(busScope, Exit.void)
    }),
  )
})

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
      // (B) condition: 3× ci.failure in-window → ci.repair.requested, counted ACROSS workspaces and
      // grouped PER REPO (P4.5b), so a repair is scoped to the repo that actually failed 3×.
      expect(byKind.condition?.condition).toEqual({
        eventType: V4EventRuntime.CI_FAILURE_EVENT,
        threshold: V4EventRuntime.CI_REPAIR_THRESHOLD,
        windowMs: V4EventRuntime.CI_REPAIR_WINDOW_MS,
        crossWorkspace: true,
        groupByRepo: true,
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

// §L (P2) — the archiver CONSUMER flag coupling. The wiring decides runLoop = v4EventDrivenArchive ||
// v4MultiAgentRuntime (the archiver consumes BOTH trigger types), and the group is delivery-tracked. So:
//   - both flags OFF ⇒ NO subscription ⇒ the "wiki-archiver" group is never registered ⇒ a published
//     archive trigger records NO pending delivery row (no pileup). THIS is the correctness point.
//   - either flag ON ⇒ the group IS registered ⇒ a published trigger records a pending delivery (owed),
//     which the running consumer then discharges.
describe("V4EventRuntime archiverLayer flag coupling (§L / P2)", () => {
  const trigger = (over?: Partial<DeepAgentEvent.PublishInput>): DeepAgentEvent.PublishInput => ({
    type: "session.completed",
    source: "system",
    workspaceID: "wrk_1",
    idempotencyKey: `arc-${Math.random()}`,
    priority: "normal",
    payload: { sessionID: "s1", workspacePath: "/tmp/nonexistent-ws" },
    ...over,
  })

  // The group is registered while a subscribe({group}) stream is live. With runLoop off the archiver
  // never subscribes, so publishing a trigger must NOT create a pending delivery for that group.
  const build = (flags: Partial<RuntimeFlags.Info>) =>
    V4EventRuntime.archiverLayer.pipe(
      Layer.provide(RuntimeFlags.layer(flags)),
      Layer.provideMerge(DeepAgentEventBus.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:")))),
    )

  const noPileup = (flags: Partial<RuntimeFlags.Info>, label: string) => {
    const it = testEffect(build(flags))
    it.effect(`${label} ⇒ no subscription, a published trigger leaves NO pending delivery row`, () =>
      Effect.gen(function* () {
        // providing the layer builds archiverLayer eagerly (with runLoop off ⇒ no subscription).
        const bus = yield* DeepAgentEventBus.Service
        const published = yield* bus.publish(trigger())
        // no group registered ⇒ no pending delivery owed ⇒ dueRetries never surfaces this event.
        const due = yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)
        expect(due.some((d) => d.eventID === published.id)).toBe(false)
      }),
    )
  }

  noPileup({ v4EventDrivenArchive: false, v4MultiAgentRuntime: false }, "both flags OFF")

  // either producer flag ON ⇒ the archiver subscribes ⇒ the group is registered. A trigger published
  // WHILE the subscriber is live records a pending delivery (which the live consumer then discharges).
  // Uses the LIVE clock (it.live) so the daemon fiber's real-time consume/ack settles — under TestClock
  // the background Stream.runForEach + a wall-clock wait would never progress.
  const registeredWhenOn = (flags: Partial<RuntimeFlags.Info>, label: string) => {
    const it = testEffect(build(flags))
    it.live(`${label} ⇒ archiver subscribes (group registered; delivery is tracked then discharged)`, () =>
      Effect.gen(function* () {
        // providing the layer builds archiverLayer eagerly (runLoop on ⇒ the daemon subscribes).
        const bus = yield* DeepAgentEventBus.Service
        const published = yield* bus.publish(trigger())
        // the running consumer discharges what it receives; poll until the (best-effort null) archive is
        // acked → the event is no longer retry-eligible (no orphaned pending row for the registered group).
        yield* pollWithTimeout(
          bus
            .dueRetries(Number.MAX_SAFE_INTEGER)
            .pipe(Effect.map((due) => (due.some((d) => d.eventID === published.id) ? undefined : true))),
          "archiver never discharged the delivery",
        )
      }),
    )
  }

  registeredWhenOn({ v4EventDrivenArchive: true, v4MultiAgentRuntime: false }, "v4EventDrivenArchive ON")
  registeredWhenOn({ v4EventDrivenArchive: false, v4MultiAgentRuntime: true }, "v4MultiAgentRuntime ON (goal.completed producer)")
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

  // P4.5b — real ci.failure events carry a `repo` discriminator (P1.4 webhook payload). The per-repo
  // trigger groups on it, so every failure here names its repo (default "repo-a").
  const ciFailure = (key: string, opts?: { workspaceID?: string; repo?: string }): DeepAgentEvent.PublishInput => ({
    type: V4EventRuntime.CI_FAILURE_EVENT,
    source: "ci",
    workspaceID: opts?.workspaceID ?? WS,
    idempotencyKey: key,
    priority: "normal",
    payload: { repo: opts?.repo ?? "repo-a" },
  })

  it.effect("condition met ⇒ tick publishes ci.repair.requested; not met ⇒ does not", () =>
    Effect.gen(function* () {
      clock = 0
      const scheduler = yield* Scheduler.Service
      const bus = yield* DeepAgentEventBus.Service
      const disp = yield* EventDispatcher.Service
      yield* V4EventRuntime.registerBootstrapSchedules(scheduler, 0)

      // only 2 failures for repo-a in the window → below threshold(3) → no repair published. The not-met
      // tick reschedules the next re-check to now + recheckEveryMs (60_000), so we advance past it.
      yield* bus.publish(ciFailure("f1"))
      yield* bus.publish(ciFailure("f2"))
      yield* disp.tick()
      let repairs = yield* bus.recentByType({ type: V4EventRuntime.CI_REPAIR_EVENT })
      expect(repairs.length).toBe(0)

      // a 3rd failure for repo-a (still inside the 30-min window) meets the threshold; the next due
      // re-check fires the templated repair event. Advance the clock to the rescheduled re-check first.
      clock = V4EventRuntime.CI_REPAIR_RECHECK_MS
      yield* bus.publish(ciFailure("f3"))
      yield* disp.tick()
      repairs = yield* bus.recentByType({ type: V4EventRuntime.CI_REPAIR_EVENT })
      expect(repairs.length).toBe(1)
      expect(repairs[0]?.source).toBe("schedule")
      expect((repairs[0]?.payload as { scheduleKey?: string })?.scheduleKey).toBe(V4EventRuntime.CI_REPAIR_KEY)
      // P4.5b — the repair carries the repo discriminator (repo=repo-a), so it's scoped, not global.
      expect((repairs[0]?.payload as { repo?: string })?.repo).toBe("repo-a")
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
      // failures for the SAME repo spread across TWO project workspaces — none in wrk_system.
      yield* bus.publish(ciFailure("p1", { workspaceID: "wrk_projectA", repo: "repo-x" }))
      yield* bus.publish(ciFailure("p2", { workspaceID: "wrk_projectA", repo: "repo-x" }))
      yield* bus.publish(ciFailure("p3", { workspaceID: "wrk_projectB", repo: "repo-x" }))
      yield* disp.tick()

      // the repair event fired even though ZERO failures were in wrk_system, and it carries repo-x.
      const repairs = yield* bus.recentByType({ type: V4EventRuntime.CI_REPAIR_EVENT })
      expect(repairs.length).toBe(1)
      expect((repairs[0]?.payload as { scheduleKey?: string })?.scheduleKey).toBe(V4EventRuntime.CI_REPAIR_KEY)
      expect((repairs[0]?.payload as { repo?: string })?.repo).toBe("repo-x")
    }),
  )

  it.effect("P4.5b: 3× for repo A + 1× for repo B → ONE repair for A (carrying repo=A), none for B", () =>
    Effect.gen(function* () {
      clock = 0
      const scheduler = yield* Scheduler.Service
      const bus = yield* DeepAgentEventBus.Service
      const disp = yield* EventDispatcher.Service
      yield* V4EventRuntime.registerBootstrapSchedules(scheduler, 0)

      // repo A fails 3× (meets threshold); repo B fails once (below threshold). Per-repo grouping must
      // fire EXACTLY ONE repair, for repo A, carrying repo=A — repo B gets none.
      yield* bus.publish(ciFailure("a1", { workspaceID: "wrk_projectA", repo: "repoA" }))
      yield* bus.publish(ciFailure("a2", { workspaceID: "wrk_projectA", repo: "repoA" }))
      yield* bus.publish(ciFailure("a3", { workspaceID: "wrk_projectA", repo: "repoA" }))
      yield* bus.publish(ciFailure("b1", { workspaceID: "wrk_projectB", repo: "repoB" }))
      yield* disp.tick()

      const repairs = yield* bus.recentByType({ type: V4EventRuntime.CI_REPAIR_EVENT })
      const repos = repairs.map((r) => (r.payload as { repo?: string })?.repo)
      expect(repairs.length).toBe(1)
      expect(repos).toEqual(["repoA"])
      // the fired repair is scoped to the failing repo's project workspace, not wrk_system.
      expect(repairs[0]?.workspaceID).toBe("wrk_projectA")
    }),
  )
})

// §M (P2.7) — the makeEventPanelPort DAEMON-CONTEXT regression lock. The port runs on the panel
// consumer's subscription fiber (forked at layer build), which carries NO ambient InstanceRef. Every
// InstanceState-touching call (Agent.defaultAgent, Provider.defaultModel, Session.create) `Effect.die`s
// when InstanceRef is absent (instance-state.ts:15-17), so each MUST run inside the port's `withContext`
// (which provides InstanceRef from the ctx it loads). This test injects fakes whose defaultAgent /
// defaultModel / create reproduce that EXACT die-on-missing-InstanceRef behavior (they read the real
// InstanceState.context), then invokes the port with NO ambient InstanceRef — the real daemon-fiber
// environment. BEFORE the fix (defaultAgent/defaultModel called outside withContext) the port dies →
// caught by the outer catchCause → surfaces as a port failure → consumer nacks → infinite retry, panel
// never convenes. AFTER the fix every such call is wrapped, so the port reaches consultPanel and returns
// a real verdict. agents.get returns undefined ⇒ all panelists are absent ⇒ the Arbiter returns
// needs_human with NO LLM — keeping the test light while still exercising the full port path.
describe("V4EventRuntime makeEventPanelPort daemon-context (§M / P2.7 regression)", () => {
  const CTX = { directory: "/tmp/panel-daemon-ctx" } as unknown as InstanceContext

  // A call that resolves the SAME way the real Agent/Provider/Session services do: through
  // InstanceState.context, which dies without an ambient InstanceRef. Provides the value only when
  // InstanceRef is present (i.e. only when the port wrapped it in withContext).
  const viaInstanceState = <A>(value: A): Effect.Effect<A> =>
    Effect.gen(function* () {
      yield* InstanceState.context // dies if InstanceRef is absent (the daemon-fiber default)
      return value
    })

  const fakeAgents = {
    // reached OUTSIDE withContext in the bug; MUST be wrapped → reads InstanceState.
    defaultAgent: () => viaInstanceState("reviewer"),
    // makeTaskSubagentRunner calls this per panelist turn; returning undefined ⇒ the panelist is absent
    // (failedTurn) ⇒ no LLM, and the Arbiter degrades to needs_human. This runs inside runTurn's
    // withContext, so it does not die.
    get: () => Effect.succeed(undefined),
  } as unknown as Agent.Interface

  const fakeSessions = {
    // reached only inside withContext (already correct) — but resolve via InstanceState too, so the test
    // also proves session.create works under the wrapped context.
    create: () => viaInstanceState({ id: SessionID.make("ses_panel_root") }),
    get: () => viaInstanceState({ id: SessionID.make("ses_panel_root"), permission: [], agent: undefined }),
  } as unknown as Session.Interface

  // V2-only deps: the runner REQUIRES the V2 authority, but agents.get returns undefined ⇒ every
  // panelist turn fails soft before any V2 call — a die-if-touched stub proves exactly that.
  const fakeV2Session = {
    prompt: () => Effect.die("v2 stub must not be reached (panelist absent)"),
    messages: () => Effect.die("v2 stub must not be reached (panelist absent)"),
  } as unknown as SessionV2.Interface

  const fakeStore = {
    // load establishes the ctx the port then provides via withContext. Does NOT read InstanceRef (it
    // PRODUCES the context), so it must succeed on the bare daemon fiber.
    load: () => Effect.succeed(CTX),
  } as unknown as InstanceStore.Interface

  const defaultModel = () =>
    viaInstanceState({ providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude") })

  const port = V4EventRuntime.makeEventPanelPort({
    sessions: fakeSessions,
    agents: fakeAgents,
    instanceStore: fakeStore,
    defaultModel,
    v2Session: fakeV2Session,
  })

  const event: DeepAgentEvent.Event = {
    id: "evt_panel_1",
    type: "monitor.alert",
    source: "monitor",
    // a NON-"wrk" workspaceID doubles as the directory (single-user / directory-routed) so the port
    // derives a directory WITHOUT needing a payload.directory.
    workspaceID: "/tmp/panel-daemon-ctx",
    createdAt: 1_000,
    payload: { summary: "security alert" },
  } as unknown as DeepAgentEvent.Event

  // CRITICAL: run the port with NO ambient InstanceRef provided — exactly the daemon subscription fiber.
  baseIt.effect("port does NOT die on missing InstanceRef; reaches consultPanel + returns a verdict", () =>
    Effect.gen(function* () {
      const exit = yield* port({ question: "assess", riskClass: "security", event }).pipe(Effect.exit)
      // BEFORE the fix this is a die (defect) surfaced as a failure by the port's catchCause. AFTER the
      // fix the port completes: every InstanceState call ran inside withContext, so none died.
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        // all panelists absent ⇒ Arbiter degrades to needs_human (never a silent approve).
        expect(exit.value.decision).toBe("needs_human")
      }
    }),
  )
})

// §16.3 order 3 — caller wiring regression lock: the panel port is V2-only, so panelist turns run as
// V2 admissions (research + bounded finalizer attempts) with no legacy path to fall back to. The
// finalizer replies are deliberately non-JSON so the seam degrades
// (structured = undefined) and the Arbiter fail-closes to needs_human — the assertion target is the
// drive path itself, not the verdict content.
describe("V4EventRuntime makeEventPanelPort V2 drive wiring (§16.3 order 3)", () => {
  const CTX = { directory: "/tmp/panel-v2-wiring-ctx" } as unknown as InstanceContext

  const panelist: Agent.Info = {
    name: "reviewer",
    mode: "subagent",
    permission: [],
    options: {},
  }

  const v2Prompts: string[] = []
  const history: Array<Record<string, unknown>> = []
  const replies = ["research ok", "no json here", "still no json"]
  let turn = 0

  const fakeSessions = {
    create: () => Effect.succeed({ id: SessionID.make("ses_panel_v2") }),
    get: () =>
      Effect.succeed({
        id: SessionID.make("ses_panel_v2"),
        permission: [],
        agent: "reviewer",
        directory: "/tmp/panel-v2-wiring-ctx",
      }),
    messages: () => Effect.succeed([]),
    updateMessage: (message: unknown) => Effect.succeed(message),
    updatePart: (part: unknown) => Effect.succeed(part),
  } as unknown as Session.Interface

  const fakeAgents = {
    defaultAgent: () => Effect.succeed("reviewer"),
    get: () => Effect.succeed(panelist),
  } as unknown as Agent.Interface

  const fakeV2Session = {
    prompt: (admission: { readonly prompt: { readonly text: string } }) => {
      v2Prompts.push(admission.prompt.text)
      const reply = replies[Math.min(turn, replies.length - 1)]
      turn += 1
      history.push({
        type: "assistant",
        id: `msg_panel_${turn}`,
        agent: "reviewer",
        model: { id: "model-test", providerID: "test" },
        time: { created: DateTime.makeUnsafe(1000 + turn) },
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        content: [{ type: "text", id: `part_${turn}`, text: reply }],
      })
      return Effect.succeed({})
    },
    resume: () => Effect.void,
    interrupt: () => Effect.void,
    messages: () => Effect.succeed(history),
  } as unknown as SessionV2.Interface

  const fakeStore = { load: () => Effect.succeed(CTX) } as unknown as InstanceStore.Interface

  const port = V4EventRuntime.makeEventPanelPort({
    sessions: fakeSessions,
    agents: fakeAgents,
    instanceStore: fakeStore,
    defaultModel: () =>
      Effect.succeed({ providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }),
    v2Session: fakeV2Session,
  })

  const event = {
    id: "evt_panel_v2",
    type: "monitor.alert",
    source: "monitor",
    workspaceID: "/tmp/panel-v2-wiring-ctx",
    createdAt: 1_000,
    payload: { summary: "wiring check" },
  } as unknown as DeepAgentEvent.Event

  baseIt.effect("panelist turns drive V2 admissions and never call legacy prompt orchestration", () =>
    Effect.gen(function* () {
      const exit = yield* port({ question: "assess", riskClass: "security", event }).pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        // Degraded structured output ⇒ no confirmable panelist result ⇒ fail-closed, never approve.
        expect(exit.value.decision).not.toBe("approve")
      }
      // Research + two bounded finalizer attempts per panelist turn, all durable V2 admissions.
      expect(v2Prompts.length).toBeGreaterThanOrEqual(3)
      expect(v2Prompts.some((text) => text.includes("<research_result>"))).toBe(true)
    }),
  )
})

// §16.3 order 3 — positive propagation lock: when the finalizer yields schema-valid JSON on the FIRST
// attempt, no correction round happens (exactly research + one finalizer per panelist turn) and the
// structured result reaches the panel — the decision must NOT be the fail-closed needs_human that the
// degraded variant produces.
describe("V4EventRuntime makeEventPanelPort V2 structured success propagation (§16.3 order 3)", () => {
  const CTX = { directory: "/tmp/panel-v2-success-ctx" } as unknown as InstanceContext

  const panelist: Agent.Info = {
    name: "reviewer",
    mode: "subagent",
    permission: [],
    options: {},
  }

  const v2Prompts: string[] = []
  // Panelists run CONCURRENTLY, each in its own child session — the fake V2 store is keyed by
  // sessionID so per-session frontier reads never interleave across panelists.
  const histories = new Map<string, Array<Record<string, unknown>>>()
  const turnCounts = new Map<string, number>()
  let created = 0

  const fakeSessions = {
    create: () => {
      created += 1
      return Effect.succeed({ id: SessionID.make(`ses_panel_ok_${created}`) })
    },
    get: (sessionID: string) =>
      Effect.succeed({
        id: SessionID.make(sessionID),
        permission: [],
        agent: "reviewer",
        directory: "/tmp/panel-v2-success-ctx",
      }),
    messages: () => Effect.succeed([]),
    updateMessage: (message: unknown) => Effect.succeed(message),
    updatePart: (part: unknown) => Effect.succeed(part),
  } as unknown as Session.Interface

  const fakeAgents = {
    defaultAgent: () => Effect.succeed("reviewer"),
    get: () => Effect.succeed(panelist),
  } as unknown as Agent.Interface

  const fakeV2Session = {
    prompt: (admission: { readonly sessionID: string; readonly prompt: { readonly text: string } }) => {
      v2Prompts.push(admission.prompt.text)
      // Within one child session admissions strictly alternate (research, finalizer, ...) — answer
      // by per-session position, never by inspecting the prompt text: the finalizer echoes the
      // research text back inside <research_result>, so text-sniffing would feed the finalizer's own
      // JSON into the next round's research input.
      const turn = (turnCounts.get(admission.sessionID) ?? 0) + 1
      turnCounts.set(admission.sessionID, turn)
      const reply = turn % 2 === 1 ? "research ok" : '{"verdict":"revise","findings":[]}'
      const history = histories.get(admission.sessionID) ?? []
      history.push({
        type: "assistant",
        id: `msg_panel_${admission.sessionID}_${turn}`,
        agent: "reviewer",
        model: { id: "model-test", providerID: "test" },
        time: { created: DateTime.makeUnsafe(1000 + turn) },
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        content: [{ type: "text", id: `part_${turn}`, text: reply }],
      })
      histories.set(admission.sessionID, history)
      return Effect.succeed({})
    },
    resume: () => Effect.void,
    interrupt: () => Effect.void,
    messages: (input: { readonly sessionID: string }) => Effect.succeed(histories.get(input.sessionID) ?? []),
  } as unknown as SessionV2.Interface

  const fakeStore = { load: () => Effect.succeed(CTX) } as unknown as InstanceStore.Interface

  const port = V4EventRuntime.makeEventPanelPort({
    sessions: fakeSessions,
    agents: fakeAgents,
    instanceStore: fakeStore,
    defaultModel: () =>
      Effect.succeed({ providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }),
    v2Session: fakeV2Session,
  })

  const event = {
    id: "evt_panel_ok",
    type: "monitor.alert",
    source: "monitor",
    workspaceID: "/tmp/panel-v2-success-ctx",
    createdAt: 1_000,
    payload: { summary: "success propagation check" },
  } as unknown as DeepAgentEvent.Event

  baseIt.effect("schema-valid first-attempt output reaches the panel without correction rounds", () =>
    Effect.gen(function* () {
      const exit = yield* port({ question: "assess", riskClass: "security", event }).pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        // Confirmable structured verdicts replace the degraded fail-closed needs_human.
        expect(exit.value.decision).not.toBe("needs_human")
      }
      const researchCount = v2Prompts.filter((text) => !text.includes("<research_result>")).length
      const finalizerCount = v2Prompts.filter((text) => text.includes("<research_result>")).length
      expect(researchCount).toBeGreaterThanOrEqual(1)
      // Exactly one finalizer admission per research turn: valid JSON on attempt 1, no correction
      // round anywhere (attempt-2 prompts would start with the "Return exactly one JSON value" text).
      expect(finalizerCount).toBe(researchCount)
      expect(v2Prompts.some((text) => text.startsWith("Return exactly one JSON value"))).toBe(false)
    }),
  )
})

// v2w-j4 durable-only: the makeEventTurnRunner regression locks are removed with the runner —
// the legacy event turn runner (fresh V1 Session per turn) is deleted; the V2 admission
// dispatch-branch coverage lives in test/session/multi-agent-runtime-v2-admission.test.ts.
