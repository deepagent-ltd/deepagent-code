export * as V4EventRuntime from "./v4-event-runtime"

import { Cause, Duration, Effect, Layer, Schedule } from "effect"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { WorkspaceConcurrency } from "@deepagent-code/core/deepagent/workspace-concurrency"
import { RetentionSweeper } from "@deepagent-code/core/deepagent/retention-sweeper"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { SecurityResolvers } from "@deepagent-code/core/deepagent/security-resolvers"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { Session } from "./session"
import { SessionPrompt } from "./prompt"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MultiAgentRuntime } from "./multi-agent-runtime"
import { EventDispatcher } from "./event-dispatcher"
import type { SubagentTurnRunner, SubagentTurnResult } from "./goal-loop-wiring"
import { MessageID } from "./schema"
import { SessionCompletedPublisher } from "./session-completed-publisher"
import * as Log from "@deepagent-code/core/util/log"

// V4.0 §A4/§C — the PRODUCTION event-runtime. This is the layer that was missing: every V4 daemon and
// consumer was built + unit-tested but NEVER STARTED in prod, so published events were durably logged
// and then ignored. This layer assembles them and starts their scoped fibers with the server:
//
//   EventDispatcher   — subscribes the bus, runs the §A4 router, hands routed events to →
//   MultiAgentRuntime — the DispatchPort; coordinates §C execution via a real turn runner →
//   RetentionSweeper  — the §A3 periodic prune loop.
//
// Everything is FLAG-GATED at the point of behavior: the dispatcher only dispatches when
// v4MultiAgentRuntime is on (else the router observes + acks), so merely providing this layer does not
// change runtime behavior until an operator flips the flag. The daemon fibers are scoped to the layer,
// so they start with the server and stop when it shuts down.
//
// LAYERING: deepagent-code. Depends on the instance session stack (Session/SessionPrompt/Agent/Provider)
// for the real turn runner, plus the core V4 services.

const log = Log.create({ service: "v4-event-runtime" })

// §G — a per-turn wall-clock ceiling for event-driven agent runs. Generous (event work can be
// substantial) but finite, so a blocked tool can't stall the sequential dispatch loop forever.
const EVENT_TURN_TIMEOUT_MS = 10 * 60 * 1000

const failedTurn = (): SubagentTurnResult => ({ ok: false, structured: undefined, text: "", tokensUsed: 0, cost: 0 })

// The production SubagentTurnRunner for event-driven dispatch. Unlike the goal-loop runner (which
// parents each turn to a fixed goal session), an event has no parent session — so this creates a fresh
// ROOT session rooted in the triggering event's workspace/directory (mirrors the IM agent executor),
// then runs one prompt turn. The model is the provider default (event-triggered agents have no
// inherited session model).
const makeEventTurnRunner = (deps: {
  readonly sessions: Session.Interface
  readonly agents: Agent.Interface
  readonly sessionPrompt: SessionPrompt.Interface
  readonly instanceStore: InstanceStore.Interface
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }>
}): SubagentTurnRunner =>
  (input) =>
    Effect.gen(function* () {
      const next = yield* deps.agents.get(input.agentType).pipe(Effect.orElseSucceed(() => undefined))
      if (!next) return failedTurn()
      // §C — the event's workspaceID is a grouping key that may be a genuine "wrk"-id OR a directory
      // fallback (single-user / directory-routed). Only forward a genuine workspace id to the session.
      const workspaceID =
        input.workspaceID && input.workspaceID.startsWith("wrk")
          ? WorkspaceV2.ID.make(input.workspaceID)
          : undefined
      // The turn must run in a REAL working directory. Prefer an explicit event directory; else, only a
      // NON-"wrk" workspaceID doubles as a directory. A bare "wrk_"-id is NOT a path → no directory.
      const directory =
        input.directory ?? (input.workspaceID && !input.workspaceID.startsWith("wrk") ? input.workspaceID : undefined)
      if (!directory) return failedTurn()

      // CRITICAL: this runs on a background daemon fiber, which carries NO InstanceRef (that is only set
      // per-request by the instance-context middleware). sessions.create → InstanceState.context reads
      // InstanceRef and dies without it. So we must ESTABLISH the instance context here — load it for the
      // event's directory and provide InstanceRef/WorkspaceRef around create + prompt (mirrors the
      // instance-context middleware + the IM executor, which inherit it from the request fiber).
      const ctx = yield* deps.instanceStore.load({ directory }).pipe(Effect.orElseSucceed(() => undefined))
      if (!ctx) return failedTurn()

      const withContext = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
        eff.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, workspaceID))

      const child = yield* withContext(
        deps.sessions.create({
          agent: next.name,
          title: `${input.agentType} (event)`,
          directory,
          ...(workspaceID ? { workspaceID } : {}),
        } as Parameters<Session.Interface["create"]>[0]),
      ).pipe(Effect.orElseSucceed(() => undefined))
      if (!child) return failedTurn()

      if (input.prepareSession) {
        try {
          input.prepareSession(child.id)
        } catch {
          /* best-effort seed; the turn still runs */
        }
      }

      const model = yield* deps.defaultModel()
      const parts = yield* withContext(deps.sessionPrompt.resolvePromptParts(input.prompt))
      const result = yield* withContext(
        deps.sessionPrompt.prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model,
          agent: next.name,
          ...(input.outputSchema
            ? { format: { type: "json_schema" as const, schema: input.outputSchema } as never }
            : {}),
          parts,
        }),
      ).pipe(
        // §G — bound the turn: an event-triggered session has no interactive client, so a tool that
        // blocks on approval would otherwise hang the whole (sequential) dispatch loop indefinitely.
        Effect.timeout(EVENT_TURN_TIMEOUT_MS),
        Effect.map((r) => r as { text?: string }),
        Effect.orElseSucceed(() => undefined),
      )
      if (!result) return failedTurn()

      return {
        ok: true,
        structured: undefined,
        text: typeof result.text === "string" ? result.text : "",
        tokensUsed: 0,
        cost: 0,
        sessionID: child.id,
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(failedTurn())))

// The MultiAgentRuntime layer, built with the production event turn runner. Requires the session stack
// + core V4 services (provided by the app graph). This is the DispatchPort the dispatcher drives.
const runtimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const instanceStore = yield* InstanceStore.Service
    const concurrency = yield* WorkspaceConcurrency.Service
    // §E1 — the PRODUCTION security resolvers. Without these the four-layer gate is default-OPEN (L1/L2/L4
    // resolve to trusted/permitted/allowed unconditionally); injecting them makes L1 (event-source trust),
    // L2 (actor workspace permission) and L4 (runtime operation pre-gate) evaluate REAL facts and FAIL
    // CLOSED on any lookup error. L3 (agent capability) is pure in SecurityGate and already enforced.
    const sec = yield* SecurityResolvers.Service
    const runner = makeEventTurnRunner({
      sessions,
      agents,
      sessionPrompt,
      instanceStore,
      // provider default model, resolved per turn; falls back to failedTurn on error via the runner.
      defaultModel: () => provider.defaultModel().pipe(Effect.orDie),
    })
    // §E2 — cap concurrent agent execution per workspace (default 5).
    // §E1 — wire the four-layer gate to real, fail-closed resolvers:
    //   L1 (event_source)  — per-EVENT: the event's workspace trusted-source set (system events must
    //                        still pass this — the default set includes "system"). Fails closed.
    //   L2 (actor_permission) — the actor is a member of the workspace OR the acting agent is registered
    //                        for it (no-actor/system events defer to L1 by design). Fails closed.
    //   L4 (runtime_operation) — the agent's declared toolWhitelist pre-gate (defense-in-depth; the child
    //                        session's own permission path remains the fine-grained enforcement).
    return MultiAgentRuntime.layerWith({
      runner,
      concurrency,
      trustedSourcesFor: (event) => sec.resolveTrustedSources(event.workspaceID),
      actorHasPermission: (event, agent) =>
        sec.actorHasWorkspacePermission({
          workspaceID: event.workspaceID,
          ...(event.actorID != null ? { actorID: event.actorID } : {}),
          agentID: agent.id,
        }),
      runtimeAllowed: (event, agent, capability) =>
        sec.runtimeAllowsOperation({ workspaceID: event.workspaceID, agent, capability }),
    })
  }),
)

// The master switch: are ANY V4 event-driven daemons active for this process? True if any of the
// event-driven flags is on. We read flags ONCE at layer build and start the daemon fibers only when
// active — so with all flags off (the default) the layer is genuinely INERT: nothing subscribes, nothing
// ticks, and — critically — the RetentionSweeper does NOT run (it would otherwise prune events on a
// 30-day TTL, a real behavior change). Flip a flag and restart to activate; per-event behavior remains
// additionally flag-gated inside each daemon.
const anyV4DaemonEnabled = (flags: RuntimeFlags.Info): boolean =>
  flags.v4MultiAgentRuntime ||
  flags.v4EventDrivenIm ||
  flags.v4PanelAutoConvene ||
  flags.v4AgentPushEnabled ||
  flags.v4EventDrivenArchive

// The EventDispatcher layer whose DispatchPort is the live MultiAgentRuntime. Its subscribe/tick/retry
// daemons run only when a V4 daemon is enabled (else runLoops:false ⇒ built but dormant). The dispatcher
// additionally flag-checks v4MultiAgentRuntime per event before dispatching.
const dispatcherLayer = Layer.unwrap(
  Effect.gen(function* () {
    const rt = yield* MultiAgentRuntime.Service
    const flags = yield* RuntimeFlags.Service
    const concurrency = yield* WorkspaceConcurrency.Service
    return EventDispatcher.layerWith({
      dispatchPort: { dispatch: rt.dispatch },
      runLoops: anyV4DaemonEnabled(flags),
      // §A4 backpressure reads the live agent-execution depth (total across workspaces) so the router
      // sheds low/normal events when the runtime is saturated; high/critical always pass.
      queueDepth: () => concurrency.totalDepth(),
    })
  }),
)

// The retention sweeper daemon — started only when a V4 daemon is enabled. This coupling is
// self-consistent, not a surprise: the durable event/audit tables are written ONLY by V4 publishers
// (the flag-gated IM double-write, goal-manager, agent-push), so with all V4 flags off nothing is
// written and there is nothing to prune. Turning any V4 flag on both starts writing those rows AND
// starts the 30-day sweep that bounds them — they activate together by design.
const retentionLayer = Layer.unwrap(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    return RetentionSweeper.layerWith({ runLoop: anyV4DaemonEnabled(flags) })
  }),
)

// §E2 — the publish rate-limiter SWEEP daemon. The bus's per-workspace publish-rate buckets are an
// in-memory map that grows one entry per workspace that publishes; without a periodic prune it retains
// a bucket for every workspace forever (a slow leak). This scoped fiber calls sweepPublishLimiter on a
// cadence to drop windows that have already elapsed. Same flag coupling as the retention sweeper: the
// limiter is only populated by V4 publishers (im.message.created / goal.*), so with all V4 flags off
// nothing publishes → no buckets → nothing to prune, and this daemon stays inert. A failure in one pass
// is logged and swallowed so the loop never dies. Provides no service (Layer.effectDiscard) — it exists
// purely for its scoped daemon fiber, so it merges cleanly alongside the other daemon layers.
const LIMITER_SWEEP_INTERVAL_MS = 60_000
const limiterSweepLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    if (!anyV4DaemonEnabled(flags)) return
    const bus = yield* DeepAgentEventBus.Service
    yield* bus
      .sweepPublishLimiter()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => log.error("publish-limiter sweep failed", { cause: Cause.pretty(cause) })),
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(LIMITER_SWEEP_INTERVAL_MS))),
        Effect.forkScoped,
      )
  }),
)

// ── §A4/§N — PRODUCTION schedule bootstrap ──────────────────────────────────────────────────────────
// The Scheduler's tick loop scans a durable table that, until now, NOTHING in production ever wrote to
// (the entire delay/periodic/condition machinery + the "3× CI failure → repair" example were dead). This
// block registers the two canonical §A4 schedules at startup so the tick loop has real rows to fire.
//
// The schedules live under a single SYSTEM workspace. `Scheduler.due(now)` scans across ALL workspaces
// (it filters only on status + fire_at), so one system-scoped row is enough for the periodic scan to be
// picked up process-wide. The "wrk"-prefix marks it a genuine workspace id (not a directory fallback in
// the turn runner); an absent WorkspaceConfig row resolves to DEFAULT_TRUSTED_SOURCES (which includes
// "schedule"), so the §E1 layer-1 source-trust gate passes for these self-originated events.
export const SYSTEM_WORKSPACE_ID = "wrk_system"

// (A) §A4 周期扫描 — a daily maintenance scan for the §A1 MaintenanceAgent. Fires `schedule.scan`.
export const MAINTENANCE_SCAN_EVENT = "schedule.scan"
export const MAINTENANCE_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000 // daily

// (B) §A4 条件触发 / §N — the "连续 3 次 CI 失败才启动修复" trigger. Fires `ci.repair.requested` only when
// ≥ 3 `ci.failure` events are seen in the window. crossWorkspace: real per-project CI failures (P1.4
// webhook ingress) land in their own project workspaces, so this SYSTEM-level trigger counts ci.failure
// ACROSS workspaces (the tick omits the workspace filter) — else it would never fire on real failures.
export const CI_FAILURE_EVENT = "ci.failure"
export const CI_REPAIR_EVENT = "ci.repair.requested"
export const CI_REPAIR_THRESHOLD = 3
export const CI_REPAIR_WINDOW_MS = 30 * 60 * 1000 // 30 min
export const CI_REPAIR_RECHECK_MS = 60 * 1000 // re-evaluate the window once a minute

// Stable identity keys embedded in each schedule's eventTemplate.payload + written to the unique
// `schedule_key` column. The Scheduler inserts keyed schedules with onConflictDoNothing, so a duplicate
// registration (even a concurrent second process racing the same boot) is a DB-level no-op that returns
// the existing row — idempotent across restarts with no accreting duplicate rows.
export const MAINTENANCE_SCAN_KEY = "v4:maintenance-scan"
export const CI_REPAIR_KEY = "v4:ci-3x-failure-repair"

/**
 * Register the canonical production schedules IDEMPOTENTLY. Idempotency is enforced at the DB layer: each
 * schedule is registered with a stable `scheduleKey`, written to the unique `schedule_key` column and
 * inserted with onConflictDoNothing — so a duplicate registration (even a concurrent second process
 * racing the same boot) is a no-op that returns the existing row, never a duplicate. Exported for direct,
 * clock-controlled testing; `scheduleBootstrapLayer` calls it (flag-gated) with the real clock at startup.
 */
export const registerBootstrapSchedules = (scheduler: Scheduler.Interface, now: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* scheduler.schedulePeriodic({
      workspaceID: SYSTEM_WORKSPACE_ID,
      intervalMs: MAINTENANCE_SCAN_INTERVAL_MS,
      firstFireAt: now + MAINTENANCE_SCAN_INTERVAL_MS,
      scheduleKey: MAINTENANCE_SCAN_KEY,
      eventTemplate: {
        type: MAINTENANCE_SCAN_EVENT,
        source: "schedule",
        workspaceID: SYSTEM_WORKSPACE_ID,
        priority: "low",
        payload: { scheduleKey: MAINTENANCE_SCAN_KEY, kind: "maintenance" },
      },
    })

    yield* scheduler.scheduleCondition({
      workspaceID: SYSTEM_WORKSPACE_ID,
      condition: {
        eventType: CI_FAILURE_EVENT,
        threshold: CI_REPAIR_THRESHOLD,
        windowMs: CI_REPAIR_WINDOW_MS,
        crossWorkspace: true,
      },
      recheckEveryMs: CI_REPAIR_RECHECK_MS,
      firstCheckAt: now,
      scheduleKey: CI_REPAIR_KEY,
      eventTemplate: {
        type: CI_REPAIR_EVENT,
        source: "schedule",
        workspaceID: SYSTEM_WORKSPACE_ID,
        priority: "high",
        payload: { scheduleKey: CI_REPAIR_KEY, reason: "3x-ci-failure" },
      },
    })
  })

// The startup effect that registers the production schedules. Gated on v4MultiAgentRuntime — the flag
// that governs dispatch of these non-im/non-push events. Registering them while that flag is OFF would
// seed rows that fire events the dispatcher then drops, so we only register when the capability is live.
// Default OFF ⇒ nothing registered ⇒ a fresh prod DB stays empty (no dead rows). A failure is logged and
// swallowed so a transient DB hiccup at boot can't crash the layer build; the next restart re-attempts
// (idempotently). Provides no service (Layer.effectDiscard) — like the limiter sweep it exists purely for
// its startup effect and merges cleanly alongside the daemon layers.
export const scheduleBootstrapLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    if (!flags.v4MultiAgentRuntime) return
    const scheduler = yield* Scheduler.Service
    yield* registerBootstrapSchedules(scheduler, Date.now()).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => log.error("schedule bootstrap failed", { cause: Cause.pretty(cause) })),
      ),
    )
  }),
)

/**
 * The full V4 event-runtime, ready to merge into the instance app graph. Starts (as scoped daemons):
 * the EventDispatcher (router + scheduler tick + retry pump), the MultiAgentRuntime (DispatchPort),
 * the RetentionSweeper, the §E2 publish-limiter sweep, the §A4/§N schedule bootstrap, and the §L
 * SessionCompletedPublisher (republishes a completed root session's end-of-turn idle as
 * `session.completed` so the archiver has a trigger). All behavior is flag-gated, so providing this
 * layer is inert until the V4 flags are enabled.
 *
 * Requires from the surrounding graph: Session, SessionPrompt, Agent, Provider, RuntimeFlags,
 * EventV2Bridge, and a Database (for the core V4 services this self-provides over it). The core services
 * (DeepAgentEventBus / ApprovalQueue / Scheduler / WorkspaceConfig / WorkspaceConcurrency /
 * AgentListProvider / RetentionSweeper) are provided here so the daemons share one bus + DB.
 */
export const layer = Layer.mergeAll(
  dispatcherLayer,
  retentionLayer,
  limiterSweepLayer,
  scheduleBootstrapLayer,
  // §L — the session.completed producer. Its subscription/publish is gated on v4EventDrivenArchive
  // (inert when off). It draws DeepAgentEventBus (provided alongside the runtime), plus RuntimeFlags /
  // EventV2Bridge / Session from the shared app graph — so it shares the ONE bus the archiver consumes.
  SessionCompletedPublisher.layer,
).pipe(
  Layer.provideMerge(runtimeLayer),
)

