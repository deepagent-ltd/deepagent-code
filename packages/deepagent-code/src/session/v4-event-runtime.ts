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
  flags.v4MultiAgentRuntime || flags.v4EventDrivenIm || flags.v4PanelAutoConvene || flags.v4AgentPushEnabled

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

/**
 * The full V4 event-runtime, ready to merge into the instance app graph. Starts (as scoped daemons):
 * the EventDispatcher (router + scheduler tick + retry pump), the MultiAgentRuntime (DispatchPort),
 * the RetentionSweeper, and the §E2 publish-limiter sweep. All behavior is flag-gated, so providing
 * this layer is inert until the V4 flags are enabled.
 *
 * Requires from the surrounding graph: Session, SessionPrompt, Agent, Provider, RuntimeFlags, and a
 * Database (for the core V4 services this self-provides over it). The core services
 * (DeepAgentEventBus / ApprovalQueue / Scheduler / WorkspaceConfig / WorkspaceConcurrency /
 * AgentListProvider / RetentionSweeper) are provided here so the daemons share one bus + DB.
 */
export const layer = Layer.mergeAll(dispatcherLayer, retentionLayer, limiterSweepLayer).pipe(
  Layer.provideMerge(runtimeLayer),
)

