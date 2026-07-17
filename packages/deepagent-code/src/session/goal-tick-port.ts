export * as GoalTickPort from "./goal-tick-port"

import { Effect, Option } from "effect"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { makeGoalLoop, readGoalTickCursor } from "@deepagent-code/core/deepagent/goal-loop"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import * as Log from "@deepagent-code/core/util/log"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import type { InstanceStore } from "@/project/instance-store"
import type { EventV2 } from "@deepagent-code/core/event"
import type { Session } from "./session"
import type { Agent } from "../agent/agent"
import type { SessionPrompt } from "./prompt"
import type { SessionRevert } from "./revert"
import type { Provider } from "../provider/provider"
import type { LSP } from "../lsp/lsp"
import type { RuntimeFlags } from "../effect/runtime-flags"
import { SessionID } from "./schema"
import { type GoalDriverPorts } from "./goal-driver"
import {
  GoalLoopWiring,
  liveDiagnostics,
  liveRollback,
  makeTaskSubagentRunner,
  type PanelQuestionInput,
} from "./goal-loop-wiring"
import { makeGoalStatusPublisher } from "./goal-status-publisher"
import { RuntimeFlags as RuntimeFlagsService } from "../effect/runtime-flags"
import { LSP as LSPService } from "../lsp/lsp"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import type { GoalTickConsumer } from "./goal-tick-consumer"

// V4.1 §N — the PRODUCTION `runTick` port for the GoalTickConsumer: execute EXACTLY ONE goal tick on a
// COLD fiber, reconstructing the entire goal wiring from durable state + the event payload. This is the
// piece that makes the event-driven chain survive a process restart: nothing about a running goal is held
// in memory that this cannot rebuild from {sessionID, goalId} + the file-backed run_context doc.
//
// COLD-FIBER DISCIPLINE (mirrors makeEventTurnRunner / makeEventPanelPort): the GoalTickConsumer's
// subscription runs on a background daemon fiber that carries NO ambient InstanceRef. EVERY
// InstanceState-touching call (agents.get / sessions.get|create / sessionPrompt.* / provider.defaultModel /
// SessionRevert / LSP) reads InstanceRef and `Effect.die`s without it. So we load the instance context for
// the goal session's directory ONCE and wrap every such call in `withContext`. A die would pierce the
// consumer's catchCause and nack forever; wrapping keeps the tick honest.
//
// PARENTING (§D invariant 不越权): the goal-worker turn is parented to the GOAL SESSION (parentSessionID =
// sessionID), exactly as the in-process driver does — swapping to a fresh root would change permission
// derivation. makeTaskSubagentRunner does NOT self-wrap withContext (it only ever ran on a request fiber),
// so this port wraps it.

const log = Log.create({ service: "goal-tick-port" })

export type GoalTickPortDeps = {
  readonly sessions: Session.Interface
  readonly agents: Agent.Interface
  readonly sessionPrompt: SessionPrompt.Interface
  readonly revert: SessionRevert.Interface
  readonly provider: Provider.Interface
  readonly lsp: LSP.Interface
  readonly instanceStore: InstanceStore.Interface
  readonly events: EventV2.Interface
  readonly eventBus: DeepAgentEventBus.Interface
  readonly approvalQueue: ApprovalQueue.Interface
  readonly flags: RuntimeFlags.Info
  /** The canonical store-root resolver (goal-manager.goalStoreRoot) — the SAME path the warm driver uses. */
  readonly goalStoreRoot: (sessionID: string) => string
}

const defaultPanelQuestion = (): PanelQuestionInput => ({
  question: "Is the current change safe and correct enough to complete this goal?",
  codeRefs: [],
  lenses: ["correctness", "security", "architecture"],
})

// A halt result that discharges the command WITHOUT re-emitting (progress="stopped") — used when the tick
// genuinely cannot run (no model configured, wiring disabled). Distinct from a transient failure (which
// the consumer nacks): a config problem won't fix on retry, so we ack + halt the chain rather than spin.
const HALT: GoalTickConsumer.GoalTickPortResult = { progress: "stopped", nextSeq: 0, nextExpectedPlanVersion: 0 }

// The cursor is persisted by the tick itself, before the consumer publishes its successor or acks the
// current delivery. An advanced cursor therefore proves this command already committed. Returning the
// current cursor lets a retry idempotently repair a missing successor; a command ahead of durable state is
// invalid and must be nacked instead of executing out of order.
export const recoverGoalTickRequest = (
  request: GoalTickConsumer.GoalTickRequest,
  cursor: ReturnType<typeof readGoalTickCursor>,
) => {
  if (cursor == null || cursor.seq === request.seq) return null
  if (cursor.seq < request.seq) return "invalid" as const
  return {
    progress: cursor.phase === "running" ? "continue" : cursor.phase === "stopped" ? "stopped" : "terminal",
    nextSeq: cursor.seq,
    nextExpectedPlanVersion: cursor.planVersion,
  } as const
}

/**
 * Build the production GoalTickPort. One call = one cold-reconstructed tick.
 */
export const makeGoalTickPort =
  (deps: GoalTickPortDeps): GoalTickConsumer.GoalTickPort =>
  (request) =>
    Effect.gen(function* () {
      const sessionID = request.sessionID
      const store = new DocumentStore(deps.goalStoreRoot(sessionID))
      const recovered = recoverGoalTickRequest(request, readGoalTickCursor(store, sessionID, request.goalId))
      if (recovered === "invalid") {
        return yield* Effect.die(
          new Error(`goal tick command ${request.seq} is ahead of durable state for ${request.goalId}`),
        )
      }
      if (recovered != null) {
        log.info("goal tick delivery already committed; repairing successor", {
          goalId: request.goalId,
          seq: request.seq,
          nextSeq: recovered.nextSeq,
        })
        return recovered
      }

      // Reconstruct cwd + instance context from the goal session. sessions.get itself resolves through
      // InstanceState, but it is called BEFORE we hold a ctx — so tolerate a die by loading the ctx from a
      // best-effort directory. In practice the daemon runs in-process where session-state is on disk; the
      // session row read here is via the DB service (Session.get), which does NOT need InstanceRef for the
      // lookup itself in this codebase, but we still guard defensively.
      const session = yield* deps.sessions.get(SessionID.make(sessionID)).pipe(Effect.orElseSucceed(() => undefined))
      const directory = session?.directory ?? process.cwd()

      // Establish the instance context on this cold fiber (see header). A load failure ⇒ we cannot run any
      // InstanceState call → halt the chain (ack, no infinite retry).
      const ctx = yield* deps.instanceStore.load({ directory }).pipe(Effect.orElseSucceed(() => undefined))
      if (!ctx) {
        log.warn("goal tick: could not load instance context; halting chain", { sessionID, goalId: request.goalId })
        return HALT
      }
      const workspaceID =
        session?.workspaceID && String(session.workspaceID).startsWith("wrk")
          ? WorkspaceV2.ID.make(String(session.workspaceID))
          : undefined
      const withContext = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
        eff.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, workspaceID))

      // Resolve the goal model (session model else provider default), wrapped so defaultModel doesn't die.
      const model = yield* withContext(
        Effect.gen(function* () {
          if (session?.model) return { providerID: session.model.providerID, modelID: session.model.id }
          const fallback = yield* deps.provider.defaultModel().pipe(Effect.option)
          if (Option.isNone(fallback)) return null
          return { providerID: fallback.value.providerID, modelID: fallback.value.modelID }
        }),
      ).pipe(Effect.orElseSucceed(() => null))
      if (!model) {
        log.warn("goal tick: no model configured; halting chain", { sessionID, goalId: request.goalId })
        return HALT
      }

      // The turn runner — parented to the goal session, wrapped so its InstanceState calls don't die cold.
      const baseRunner = makeTaskSubagentRunner({
        sessions: deps.sessions,
        agents: deps.agents,
        sessionPrompt: deps.sessionPrompt,
        parentSessionID: SessionID.make(sessionID),
        model,
      })
      const runTurn: typeof baseRunner = (input) => withContext(baseRunner(input))

      // Diagnostics + rollback, both wrapped (LSP / SessionRevert resolve through InstanceState).
      const diagnostics = () =>
        withContext(liveDiagnostics().pipe(Effect.provideService(LSPService.Service, deps.lsp)))
      const rollback = liveRollback(deps.revert, (sid) =>
        withContext(
          deps.sessions
            .messages({ sessionID: SessionID.make(sid) })
            .pipe(
              Effect.map((msgs) => msgs.at(-1)?.info.id ?? null),
              Effect.catchCause(() => Effect.succeed(null)),
            ),
        ),
      )
      const wrappedRollback: typeof rollback = (rbInput) => withContext(rollback(rbInput))

      const deps_ = yield* GoalLoopWiring.makeGoalLoopWiring({
        store,
        parentSessionID: sessionID,
        cwd: directory,
        runTurn,
        panelQuestion: defaultPanelQuestion,
        diagnostics,
        rollback: wrappedRollback,
      }).pipe(Effect.provideService(RuntimeFlagsService.Service, deps.flags))
      if (deps_ == null) {
        log.warn("goal tick: goal loop disabled (experimentalGoalLoop off); halting chain", { sessionID })
        return HALT
      }

      // The SHARED status publisher — IDENTICAL onStatus behaviour to the warm goal-manager path (mirror
      // plan → session-state, publish goal.updated, flag-on mirror to bus + approval queue). No cacheStatus
      // callback: the cold path has no in-memory control map (pause/resume/stop read the durable pointer).
      const statusPublisher = makeGoalStatusPublisher({
        events: deps.events,
        sessions: deps.sessions,
        eventBus: deps.eventBus,
        approvalQueue: deps.approvalQueue,
        v4MultiAgentRuntime: deps.flags.v4MultiAgentRuntime,
        goalStoreRoot: deps.goalStoreRoot,
      })

      // Ports from DURABLE sources (no in-memory control map on the cold fiber):
      // shouldPause / shouldStop read the session-state active-goal pointer phase (pause/stop persist it).
      const goalPhase = () => AgentGateway.DeepAgentSessionState.getActiveGoal(sessionID)?.phase
      const ports: GoalDriverPorts = {
        onStatus: (status) => statusPublisher.publishStatus(sessionID, status),
        shouldPause: () => Effect.sync(() => goalPhase() === "paused"),
        shouldStop: () => Effect.sync(() => goalPhase() === "stopped"),
      }

      // One tick with the driver's cooperative pause/stop checks (the body of runToCompletion, minus the
      // iteration — the event chain re-emits the next command instead of looping in-process).
      const loop = makeGoalLoop(deps_)
      const handle = { goalId: request.goalId, planDocId: request.planDocId, sessionId: sessionID }
      const progress = yield* Effect.gen(function* () {
        if (yield* ports.shouldStop().pipe(Effect.catchCause(() => Effect.succeed(false)))) {
          yield* loop.stop(handle).pipe(Effect.catchCause(() => Effect.void))
          return "stopped" as const
        }
        if (yield* ports.shouldPause().pipe(Effect.catchCause(() => Effect.succeed(false)))) {
          return "paused" as const
        }
        const outcome = yield* loop.tick(handle)
        const status = yield* loop.status(handle).pipe(Effect.catchCause(() => Effect.succeed(null)))
        if (status) yield* ports.onStatus(status).pipe(Effect.catchCause(() => Effect.void))
        if (outcome === "continue") return "continue" as const
        return "terminal" as const
      })

      // The post-tick durable cursor is the next command identity and the retry checkpoint for this command.
      // If state vanished, the tick cannot continue, so the fallback is unused by the consumer.
      const cursor = readGoalTickCursor(store, sessionID, request.goalId)
      const nextSeq = cursor?.seq ?? request.seq + 1
      const nextExpectedPlanVersion = cursor?.planVersion ?? request.expectedPlanVersion

      return { progress, nextSeq, nextExpectedPlanVersion }
    }).pipe(
      // The port lives on `never` — a defect here (unexpected) must NOT crash the consumer's stream. But we
      // WANT a genuine transient failure to nack for retry, so we RE-RAISE as a die: the consumer's
      // catchCause converts it to a nack (retry the REAL tick). We only swallow to HALT for the explicit
      // config cases above. So: no catch here — let a defect propagate to the consumer's nack path.
      Effect.orDie,
    )
