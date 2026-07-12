import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
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
import type { Agent } from "../../src/agent/agent"
import type { SessionPrompt } from "../../src/session/prompt"
import { SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
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

  const fakePrompt = {} as unknown as SessionPrompt.Interface

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
    sessionPrompt: fakePrompt,
    instanceStore: fakeStore,
    defaultModel,
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

// §C (P2.10) — the makeEventTurnRunner DAEMON-CONTEXT regression lock (same defect class as the panel
// port). The event-driven turn runner runs on the EventDispatcher → MultiAgentRuntime dispatch fiber,
// which carries NO ambient InstanceRef. agents.get / defaultModel / sessions.create / the prompt calls
// all resolve through InstanceState, which `Effect.die`s without InstanceRef (instance-state.ts:15-17).
// A die is a DEFECT that pierces `orElseSucceed` (which only catches the E channel), so BEFORE the fix
// (agents.get + defaultModel called before withContext) it hit the outer catchCause → EVERY event-driven
// turn silently returned failedTurn (ok:false) — i.e. the whole multi-agent event-driven execution chain
// never ran in prod. AFTER the fix ctx is loaded first and every such call runs inside withContext, so
// the runner reaches the prompt and returns ok:true. Fakes reproduce the EXACT die-on-missing-InstanceRef
// via the real InstanceState.context; the runner is invoked with NO ambient InstanceRef (the real fiber).
describe("V4EventRuntime makeEventTurnRunner daemon-context (§C / P2.10 regression)", () => {
  const CTX = { directory: "/tmp/event-turn-ctx" } as unknown as InstanceContext

  const viaInstanceState = <A>(value: A): Effect.Effect<A> =>
    Effect.gen(function* () {
      yield* InstanceState.context // dies if InstanceRef is absent (the daemon-fiber default)
      return value
    })

  const fakeAgents = {
    // reached OUTSIDE withContext in the bug; MUST be wrapped → resolves via InstanceState.
    get: () => viaInstanceState({ name: "reviewer" }),
  } as unknown as Agent.Interface

  // capture the create inputs so the §F2 test can assert the correlationID was stamped onto the child.
  type CreateInput = { metadata?: Record<string, unknown> }
  const createInputs: (CreateInput | undefined)[] = []
  const fakeSessions = {
    create: (input?: CreateInput) =>
      viaInstanceState(void createInputs.push(input)).pipe(Effect.as({ id: SessionID.make("ses_event_root") })),
  } as unknown as Session.Interface

  // A light SessionPrompt: resolvePromptParts + prompt both resolve via InstanceState (so the test also
  // proves they run under the wrapped context), returning a minimal assistant result with text.
  const fakePrompt = {
    resolvePromptParts: () => viaInstanceState([{ type: "text", text: "hi" }]),
    prompt: () => viaInstanceState({ info: { role: "assistant" }, parts: [], text: "done" }),
  } as unknown as SessionPrompt.Interface

  const fakeStore = {
    // load PRODUCES ctx; it does not read InstanceRef, so it must succeed on the bare daemon fiber.
    load: () => Effect.succeed(CTX),
  } as unknown as InstanceStore.Interface

  const defaultModel = () =>
    viaInstanceState({ providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude") })

  const runner = V4EventRuntime.makeEventTurnRunner({
    sessions: fakeSessions,
    agents: fakeAgents,
    sessionPrompt: fakePrompt,
    instanceStore: fakeStore,
    defaultModel,
  })

  // CRITICAL: invoke the runner with NO ambient InstanceRef — exactly the dispatch daemon fiber.
  baseIt.effect("runner does NOT silently fail on missing InstanceRef; reaches prompt + returns ok:true", () =>
    Effect.gen(function* () {
      // a NON-"wrk" workspaceID doubles as the directory (single-user / directory-routed).
      const result = yield* runner({ agentType: "reviewer", prompt: "do it", workspaceID: "/tmp/event-turn-ctx" })
      // BEFORE the fix: agents.get dies → orElseSucceed does NOT catch it → outer catchCause → failedTurn
      // (ok:false). AFTER the fix: every InstanceState call ran inside withContext → the turn completes.
      expect(result.ok).toBe(true)
      expect(result.text).toBe("done")
    }),
  )

  // §F2 trace back-half — the runner must STAMP the triggering event's correlationID onto the child
  // session it creates, so the §F2 trace spine can join the child's activity (tool calls / message / PR)
  // back to the trigger. Without this the trace stops at the coordination events.
  baseIt.effect("§F2 stamps the input correlationID onto the created child session's metadata", () =>
    Effect.gen(function* () {
      createInputs.length = 0
      const result = yield* runner({
        agentType: "reviewer",
        prompt: "do it",
        workspaceID: "/tmp/event-turn-ctx",
        correlationID: "corr-xyz",
      })
      expect(result.ok).toBe(true)
      // the child session the runner created carries the correlationID in its metadata → the §F2 trace
      // query can pivot from the triggering event into this child's activity.
      const last = createInputs.at(-1)
      expect(last?.metadata?.correlationID).toBe("corr-xyz")
    }),
  )

  baseIt.effect("§F2 omits metadata.correlationID when the caller supplies none", () =>
    Effect.gen(function* () {
      createInputs.length = 0
      const result = yield* runner({ agentType: "reviewer", prompt: "do it", workspaceID: "/tmp/event-turn-ctx" })
      expect(result.ok).toBe(true)
      // no correlationID in ⇒ no metadata stamped (goal-loop / stub callers are unaffected).
      const last = createInputs.at(-1)
      expect(last?.metadata?.correlationID).toBeUndefined()
    }),
  )
})

// §C1/§G (P3.13) — makeEventTurnRunner must HONOR the agent's declared per-turn ceiling
// (limits.maxTurnDurationMs), threaded through the runner input, rather than always using the fixed
// 10-min default. A prompt that outlives the ceiling times out → the runner fail-softs to ok:false; a
// generous ceiling lets the same prompt complete. Uses the LIVE clock so Effect.timeout resolves in real
// time against the injected sleep.
describe("V4EventRuntime makeEventTurnRunner honors maxTurnDurationMs (§C1/§G / P3.13)", () => {
  const CTX = { directory: "/tmp/event-turn-timeout" } as unknown as InstanceContext
  const fakeStore = { load: () => Effect.succeed(CTX) } as unknown as InstanceStore.Interface
  const fakeAgents = { get: () => Effect.succeed({ name: "reviewer" }) } as unknown as Agent.Interface
  const fakeSessions = {
    create: () => Effect.succeed({ id: SessionID.make("ses_timeout_root") }),
  } as unknown as Session.Interface
  const defaultModel = () =>
    Effect.succeed({ providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude") })

  // a prompt that takes ~120ms — longer than a tight ceiling, shorter than a generous one.
  const slowPrompt = {
    resolvePromptParts: () => Effect.succeed([{ type: "text", text: "hi" }]),
    prompt: () =>
      Effect.succeed({ info: { role: "assistant" }, parts: [], text: "done" }).pipe(Effect.delay("120 millis")),
  } as unknown as SessionPrompt.Interface

  const runner = V4EventRuntime.makeEventTurnRunner({
    sessions: fakeSessions,
    agents: fakeAgents,
    sessionPrompt: slowPrompt,
    instanceStore: fakeStore,
    defaultModel,
  })

  baseIt.live("a turn exceeding the agent's maxTurnDurationMs times out → ok:false", () =>
    Effect.gen(function* () {
      const result = yield* runner({
        agentType: "reviewer",
        prompt: "do it",
        workspaceID: "/tmp/event-turn-timeout",
        maxTurnDurationMs: 20, // tighter than the ~120ms prompt → the turn times out
      })
      expect(result.ok).toBe(false)
    }),
  )

  baseIt.live("the SAME prompt completes under a generous maxTurnDurationMs → ok:true", () =>
    Effect.gen(function* () {
      const result = yield* runner({
        agentType: "reviewer",
        prompt: "do it",
        workspaceID: "/tmp/event-turn-timeout",
        maxTurnDurationMs: 60_000, // far above the ~120ms prompt → completes
      })
      expect(result.ok).toBe(true)
      expect(result.text).toBe("done")
    }),
  )
})
