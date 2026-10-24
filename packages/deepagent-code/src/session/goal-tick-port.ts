export * as GoalTickPort from "./goal-tick-port"

import { Effect } from "effect"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalTickCheckpointV2 } from "@deepagent-code/core/deepagent/goal-tick-checkpoint-v2"
import { GoalTickState } from "@deepagent-code/core/deepagent/goal-tick-state"
import { Schema } from "effect"
import { GoalControlSchema } from "@deepagent-code/core/deepagent/goal-control.schema"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { makeGoalLoop, matchesGoalInitialization, readGoalTickCursor } from "@deepagent-code/core/deepagent/goal-loop"
import { readPendingPlanEditCommand, settlePlanEditCommand } from "@deepagent-code/core/deepagent/plan-edit-protocol"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import type { SessionV2 } from "@deepagent-code/core/session"
import type { Snapshot } from "../snapshot"
import * as Log from "@deepagent-code/core/util/log"
import { EventRouteRef, InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import type { InstanceStore } from "@/project/instance-store"
import type { Database } from "@deepagent-code/core/database/database"
import type { EventV2 } from "@deepagent-code/core/event"
import type { Session } from "./session"
import type { Agent } from "../agent/agent"
import type { SessionRevert } from "./revert"
import type { SessionSteer } from "./steer"
import type { Provider } from "../provider/provider"
import type { LSP } from "../lsp/lsp"
import type { RuntimeFlags } from "../effect/runtime-flags"
import { SessionID } from "./schema"
import { GoalDriver, type GoalDriverPorts } from "./goal-driver"
import {
  GoalLoopWiring,
  liveDiagnostics,
  liveRollback,
  liveRollbackNotice,
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
// InstanceState-touching call (agents.get / sessions.get|create / provider.defaultModel /
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
  readonly revert: SessionRevert.Interface
  readonly steerBuffer: SessionSteer.Interface
  readonly provider: Provider.Interface
  readonly lsp: LSP.Interface
  readonly instanceStore: InstanceStore.Interface
  readonly events: EventV2.Interface
  /** The shared DB handle backing the B5 rollback notice's deterministic-id dedupe check. */
  readonly db: Database.Interface["db"]
  readonly eventBus: DeepAgentEventBus.Interface
  readonly approvalQueue: ApprovalQueue.Interface
  readonly flags: RuntimeFlags.Info
  /** The canonical store-root resolver (goal-manager.goalStoreRoot) — the SAME path the warm driver uses. */
  readonly goalStoreRoot: (sessionID: string) => string
  /** The durable V2 session authority driving every goal-worker subagent turn (V2-only). */
  readonly v2Session: SessionV2.Interface
  readonly snapshot?: Snapshot.Interface
  readonly runOwned?: (input: { permitID: string; directory: string }) => Effect.Effect<GoalTickCheckpointV2.Row>
}

const defaultPanelQuestion = (): PanelQuestionInput => ({
  question: "Is the current change safe and correct enough to complete this goal?",
  codeRefs: [],
  lenses: ["correctness", "security", "architecture"],
})

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
      if (request.revision === undefined)
        return yield* new GoalControlSchema.Error({
          code: "unsupported",
          message: "Legacy tick has no durable control revision",
        })
      const target = yield* GoalControl.requireTarget(deps.db, request.goalId, sessionID)
      if (target.initialization.executionContract === "owned-goal-v2") {
        if (!deps.runOwned)
          return yield* new GoalControlSchema.Error({
            code: "unavailable",
            message: "Owned Goal runtime is unavailable",
          })
        if (target.plan_doc_id !== request.planDocId || target.revision !== request.revision)
          return yield* new GoalControlSchema.Error({
            code: "revision_conflict",
            message: "Owned Goal command differs from current control",
          })
        const permitID = `goaltick_${GoalControl.fingerprint([request.goalId, request.seq])}`
        const prior = yield* GoalTickCheckpointV2.read(deps.db, permitID)
        const admission = !prior || !["mirror_pending", "committed"].includes(prior.state)
          ? yield* GoalControl.beginTick(deps.db, { ...request, revision: request.revision, mode: "event" })
          : undefined
        return yield* Effect.gen(function* () {
          const ctx = yield* deps.instanceStore.load({ directory: target.directory })
          const completed = yield* deps
            .runOwned!({ permitID, directory: deps.goalStoreRoot(sessionID) })
            .pipe(
              Effect.provideService(InstanceRef, ctx),
              Effect.provideService(
                WorkspaceRef,
                target.workspace_id ? WorkspaceV2.ID.make(target.workspace_id) : undefined,
              ),
            )
          const state = Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickState.Runtime))(
            completed.journal.nextState,
          )
          const settledControl = yield* GoalControl.requireTarget(deps.db, request.goalId, sessionID)
          if (completed.state === "committed")
            yield* makeGoalStatusPublisher({
              controlDB: deps.db,
              events: deps.events,
              sessions: deps.sessions,
              eventBus: deps.eventBus,
              approvalQueue: deps.approvalQueue,
              v4MultiAgentRuntime: deps.flags.v4MultiAgentRuntime,
              v4GoalTickEventDriven: deps.flags.v4GoalTickEventDriven,
              goalStoreRoot: deps.goalStoreRoot,
            })
              .publishStatus(sessionID, state)
              .pipe(
                Effect.provideService(InstanceRef, ctx),
                Effect.provideService(
                  WorkspaceRef,
                  target.workspace_id ? WorkspaceV2.ID.make(target.workspace_id) : undefined,
                ),
                Effect.provideService(EventRouteRef, {
                  ...ctx,
                  ...(target.workspace_id ? { workspaceID: WorkspaceV2.ID.make(target.workspace_id) } : {}),
                }),
                Effect.catchCause(() => Effect.void),
              )
          return {
            progress: state.phase === "running" && settledControl.requested_phase === "running" && !settledControl.pending_rebase_id ? ("continue" as const) : ("terminal" as const),
            nextSeq: state.ledger.ticks,
            nextExpectedPlanVersion: state.lastProcessedVersion!,
          }
        }).pipe(
          // This finalizer runs uninterruptibly and retains only the original issued obligation.
          Effect.onExit((exit) => exit._tag === "Failure" && admission
            ? GoalControl.unknown(deps.db, admission.permit).pipe(Effect.ignore)
            : Effect.void),
        )
      }
      // This transaction precedes Instance, model, wiring and all child/provider work.
      const admission = yield* GoalControl.beginTick(deps.db, { ...request, revision: request.revision, mode: "event" })
      if (admission.replayed)
        return {
          progress: admission.permit.outcome === "running" ? ("continue" as const) : ("terminal" as const),
          nextSeq: admission.permit.next_seq!,
          nextExpectedPlanVersion: admission.permit.next_plan_version!,
        }
      return yield* Effect.gen(function* () {
        const store = DocumentStore.shared(deps.goalStoreRoot(sessionID))
        store.rebuildIndex()
        const before = readGoalTickCursor(store, sessionID, request.goalId)
        const recovered = recoverGoalTickRequest(request, before)
        if (
          !before ||
          recovered !== null ||
          before.planVersion !== request.expectedPlanVersion ||
          !matchesGoalInitialization(
            store,
            { sessionId: sessionID, goalId: request.goalId, planDocId: request.planDocId },
            admission.row.initialization.spec,
            admission.row.initialization.netTokenBudget,
          )
        ) {
          return yield* Effect.die(
            new Error(`Goal SQL permit and DocumentStore cursor require reconciliation for ${request.goalId}`),
          )
        }

        // Reconstruct cwd + instance context from the goal session. sessions.get itself resolves through
        // InstanceState, but it is called BEFORE we hold a ctx — so tolerate a die by loading the ctx from a
        // best-effort directory. In practice the daemon runs in-process where session-state is on disk; the
        // session row read here is via the DB service (Session.get), which does NOT need InstanceRef for the
        // lookup itself in this codebase, but we still guard defensively.
        const session = yield* deps.sessions.get(SessionID.make(sessionID))
        const directory = admission.row.directory

        // Establish the instance context on this cold fiber (see header). A load failure ⇒ we cannot run any
        // InstanceState call → halt the chain (ack, no infinite retry).
        const ctx = yield* deps.instanceStore.load({ directory }).pipe(Effect.orElseSucceed(() => undefined))
        if (!ctx) {
          log.warn("goal tick: could not load instance context; halting chain", { sessionID, goalId: request.goalId })
          return yield* Effect.die("Goal instance context unavailable after permit")
        }
        const workspaceID =
          session?.workspaceID && String(session.workspaceID).startsWith("wrk")
            ? WorkspaceV2.ID.make(String(session.workspaceID))
            : undefined
        const withContext = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
          eff.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, workspaceID))

        // Model selection is immutable initialization evidence, not a new provider-default lookup.
        const model = admission.row.initialization.model

        // The turn runner — parented to the goal session, wrapped so its InstanceState calls don't die cold.
        const baseRunner = makeTaskSubagentRunner({
          sessions: deps.sessions,
          agents: deps.agents,
          parentSessionID: SessionID.make(sessionID),
          model,
          allowPlanWriteCapability: true,
          purpose: "goal-loop",
          v2Session: deps.v2Session,
          ...(deps.snapshot ? { snapshot: deps.snapshot } : {}),
        })
        const runTurn: typeof baseRunner = (input) => withContext(baseRunner(input))

        // Diagnostics + rollback, both wrapped (LSP / SessionRevert resolve through InstanceState).
        const diagnostics = () =>
          withContext(liveDiagnostics().pipe(Effect.provideService(LSPService.Service, deps.lsp)))
        const rollback = liveRollback(
          deps.revert,
          (sid) =>
            withContext(
              deps.sessions.messages({ sessionID: SessionID.make(sid) }).pipe(
                Effect.map((msgs) => msgs.at(-1)?.info.id ?? null),
                Effect.catchCause(() => Effect.succeed(null)),
              ),
            ),
          liveRollbackNotice(deps.events, deps.db),
        )
        const wrappedRollback: typeof rollback = (rbInput) => withContext(rollback(rbInput))

        // One goal-steer relay per tick, shared by the wiring (executor threads staged guidance) + the driver.
        const steerRelay = GoalDriver.makeGoalSteerRelay()

        const deps_ = yield* GoalLoopWiring.makeGoalLoopWiring({
          store,
          parentSessionID: sessionID,
          cwd: directory,
          runTurn,
          panelQuestion: defaultPanelQuestion,
          diagnostics,
          rollback: wrappedRollback,
          steerRelay,
        }).pipe(Effect.provideService(RuntimeFlagsService.Service, deps.flags))
        if (deps_ == null) {
          log.warn("goal tick: goal loop disabled (experimentalGoalLoop off); halting chain", { sessionID })
          return yield* Effect.die("Goal wiring disabled after permit")
        }

        // The SHARED status publisher — IDENTICAL onStatus behaviour to the warm goal-manager path (mirror
        // plan → session-state, publish goal.updated, flag-on mirror to bus + approval queue). No cacheStatus
        // callback: the cold path has no in-memory control map (pause/resume/stop read the durable pointer).
        const statusPublisher = makeGoalStatusPublisher({
          controlDB: deps.db,
          events: deps.events,
          sessions: deps.sessions,
          eventBus: deps.eventBus,
          approvalQueue: deps.approvalQueue,
          v4MultiAgentRuntime: deps.flags.v4MultiAgentRuntime,
          v4GoalTickEventDriven: deps.flags.v4GoalTickEventDriven,
          goalStoreRoot: deps.goalStoreRoot,
        })

        // Ports from DURABLE sources (no in-memory control map on the cold fiber):
        //   • shouldPause / shouldStop — the session-state active-goal pointer phase (pause/stop persist it).
        //   • goal-steer — the SessionSteer buffer on the goal session id + goal_steer delivery channel.
        //   • pendingPlanEdit — the durable activity mailbox shared with GoalManager admission.
        const ports: GoalDriverPorts = {
          onStatus: (status) =>
            statusPublisher.publishStatus(sessionID, status).pipe(Effect.catchCause(() => Effect.void)),
          // The committed permit defines this admitted tick. Later control blocks its successor.
          shouldPause: () => Effect.succeed(false),
          shouldStop: () => Effect.succeed(false),
          pendingSteer: () =>
            deps.steerBuffer.pending(SessionID.make(sessionID), GoalDriver.GOAL_STEER_DELIVERY).pipe(
              Effect.map((rows) => rows.map((r) => ({ id: r.id, text: r.prompt.text }))),
              Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<GoalDriver.PendingGoalSteer>)),
            ),
          markSteerConsumed: (ids) =>
            deps.steerBuffer
              .markConsumed(SessionID.make(sessionID), [...ids], GoalDriver.GOAL_STEER_DELIVERY)
              .pipe(Effect.catchCause(() => Effect.void)),
          pendingPlanEdit: () => Effect.sync(() => readPendingPlanEditCommand(store, sessionID, request.goalId)),
          settlePlanEdit: (command, settlement) =>
            Effect.sync(() => {
              settlePlanEditCommand(store, command, settlement)
            }),
        }

        const handle = { goalId: request.goalId, planDocId: request.planDocId, sessionId: sessionID }
        const result = yield* GoalDriver.runOneTick(makeGoalLoop(deps_), { deps: deps_, handle, ports, steerRelay })

        // The post-tick durable cursor is the next command identity and the retry checkpoint for this command.
        // If state vanished, runOneTick cannot continue, so the fallback is unused by the consumer.
        const cursor = readGoalTickCursor(store, sessionID, request.goalId)
        const nextSeq = cursor?.seq ?? request.seq + 1
        const nextExpectedPlanVersion = cursor?.planVersion ?? request.expectedPlanVersion
        if (!cursor) return yield* Effect.die("Goal tick did not persist a completion cursor")
        yield* GoalControl.settleTick(deps.db, {
          permit: admission.permit,
          nextSeq,
          planVersion: nextExpectedPlanVersion,
          phase: cursor.phase,
        })
        const status = yield* makeGoalLoop(deps_).status(handle)
        if (status) yield* statusPublisher.publishStatus(sessionID, status).pipe(Effect.catchCause(() => Effect.void))
        return { progress: result.progress, nextSeq, nextExpectedPlanVersion }
      }).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure" ? GoalControl.unknown(deps.db, admission.permit).pipe(Effect.ignore) : Effect.void,
        ),
      )
    }).pipe(
      // The port lives on `never` — a defect here (unexpected) must NOT crash the consumer's stream. But we
      // The consumer may retry delivery, but an issued/unknown SQL permit forbids execution replay.
      // Only a settled receipt can repair a successor without re-running the tick.
      Effect.orDie,
    )
