import { Effect, Layer, Context, SynchronizedRef } from "effect"
import path from "node:path"
import fs from "node:fs"
import { Global } from "@deepagent-code/core/global"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { createPlanDoc, type PlanDoc } from "@deepagent-code/core/deepagent/plan-controller"
import { parseGoalPlanFile, GOAL_PLAN_FILE, type ParsedGoalPlan } from "@deepagent-code/core/deepagent/goal-plan-file"
import type { GoalStatus, GoalLimits, CompletionCriterion } from "@deepagent-code/core/deepagent/goal-loop"
import { InvalidGoalError } from "@deepagent-code/core/deepagent/goal-loop"
import { RuntimeFlags } from "../effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BackgroundJob } from "@/background/job"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "./prompt"
import { SessionRevert } from "./revert"
import { LSP } from "../lsp/lsp"
import { Provider } from "../provider/provider"
import { SessionID } from "./schema"
import { GoalEvent } from "./goal-event"
import {
  GoalLoopWiring,
  liveDiagnostics,
  liveRollback,
  makeTaskSubagentRunner,
  type PanelQuestionInput,
} from "./goal-loop-wiring"
import { GoalDriver, type GoalDriverPorts } from "./goal-driver"

/**
 * V3.9 §D — the GOAL MANAGER service: the resident, in-process supervisor that OWNS running goals.
 *
 * This is the production seam that turns the built-but-unwired Goal Loop into a user-invocable mode.
 * `startGoal` materializes the session's plan into the graded store doc, assembles the live
 * `ControllerDeps` (via `makeGoalLoopWiring` — flag-gated), starts the driver as a BackgroundJob
 * (a resident background Effect with cancellation), and tracks per-session control state so
 * `pause` / `resume` / `stop` / `status` work while it runs. Each tick's status is published as a
 * `goal.updated` event and mirrored into the session-state active-goal pointer so the UI stays live.
 *
 * Concurrency model (per the product decision — 服务内常驻后台任务): one goal per session at a time.
 * The driver ticks in the background; the user's foreground conversation stays free. Pause is
 * cooperative (the driver checks a flag before each tick and suspends without tearing down the loop);
 * resume re-drives from the persisted run_context doc.
 */

// The DocumentStore holding a session's goal docs. Co-located with the run graph under the agent data
// root, keyed by session id, so a restart re-opens the same store (the loop state is restart-recoverable).
const goalStoreRoot = (sessionID: string): string =>
  path.join(Global.Path.agent.data, "state", "goal", sessionID, "graph")

// DESIGN mode's plan source: read the human-authored `.deepagent-code/plans/goal+plan.md` from the
// session's working directory and parse it into a PlanDoc (+ any declared criteria). Default-safe — a
// missing/unreadable/malformed file returns null so `start` falls through to the next plan source and
// never throws. The parser (core) is pure; the fs read lives here at the wiring seam.
const readGoalPlanFile = (cwd: string, sessionID: string): ParsedGoalPlan | null => {
  try {
    const file = path.join(cwd, GOAL_PLAN_FILE)
    if (!fs.existsSync(file)) return null
    const contents = fs.readFileSync(file, "utf8")
    return parseGoalPlanFile(sessionID, contents)
  } catch {
    return null
  }
}

// Per-session control state the driver ports read. Held in a SynchronizedRef so pause/stop from a route
// are observed by the running background driver without a lock.
type GoalControl = {
  readonly goalId: string
  readonly planDocId: string
  jobId: string
  paused: boolean
  stopped: boolean
}

export type StartGoalInput = {
  readonly sessionID: string
  /**
   * An optional free-text objective (e.g. from the CLI `/goal <objective>`). When the session has no
   * plan yet, this seeds a minimal single-step plan so the goal can start; the goal-worker refines it
   * on the first tick. Ignored when a plan already exists (the existing plan is the goal carrier).
   */
  readonly objective?: string
  /** Objective completion criteria (AND). Defaults to plan_complete + no_diagnostics when omitted. */
  readonly criteria?: readonly CompletionCriterion[]
  /** Hard bounds; a goal with no bounds is rejected by the core (InvalidGoalError). */
  readonly limits?: Partial<GoalLimits>
  readonly stallThreshold?: number
  /** The Expert Panel question convened at a decision point (§D.7). Defaults to a review of the diff. */
  readonly panelQuestion?: PanelQuestionInput
}

export type GoalSnapshot = {
  readonly goalId: string
  readonly planDocId: string
  readonly phase: string
  readonly running: boolean
}

export interface Interface {
  readonly start: (input: StartGoalInput) => Effect.Effect<GoalSnapshot, InvalidGoalError>
  readonly pause: (sessionID: string) => Effect.Effect<boolean>
  readonly resume: (sessionID: string) => Effect.Effect<boolean>
  readonly stop: (sessionID: string) => Effect.Effect<boolean>
  readonly status: (sessionID: string) => Effect.Effect<GoalSnapshot | null>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/GoalManager") {}

const DEFAULT_LIMITS: GoalLimits = { maxTicks: 50, maxTokens: 500_000, maxWallclockMs: 60 * 60 * 1000 }
const DEFAULT_CRITERIA: readonly CompletionCriterion[] = [{ kind: "plan_complete" }, { kind: "no_diagnostics" }]

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const revert = yield* SessionRevert.Service
    const events = yield* EventV2Bridge.Service
    const background = yield* BackgroundJob.Service
    const provider = yield* Provider.Service
    const lsp = yield* LSP.Service
    const flags = yield* RuntimeFlags.Service

    // Diagnostics accessor with LSP already provided, so the goal-loop wiring stays free of LSP in its
    // requirement channel (liveDiagnostics needs LSP.Service; we satisfy it here at construction).
    const diagnostics = () => liveDiagnostics().pipe(Effect.provideService(LSP.Service, lsp))

    // Rollback port shared by start + resume (best-effort revert to the last message).
    const rollback = liveRollback(revert, (sid) =>
      sessions
        .messages({ sessionID: SessionID.make(sid) })
        .pipe(
          Effect.map((msgs) => msgs.at(-1)?.info.id ?? null),
          Effect.catchCause(() => Effect.succeed(null)),
        ),
    )

    const defaultPanelQuestion = (): PanelQuestionInput => ({
      question: "Is the current change safe and correct enough to complete this goal?",
      codeRefs: [],
      lenses: ["correctness", "security", "architecture"],
    })

    // Per-session control state, observed by the running driver's ports.
    const controls = yield* SynchronizedRef.make(new Map<string, GoalControl>())

    const getControl = (sessionID: string) =>
      SynchronizedRef.get(controls).pipe(Effect.map((m) => m.get(sessionID) ?? null))

    const setControl = (sessionID: string, control: GoalControl | null) =>
      SynchronizedRef.update(controls, (m) => {
        const next = new Map(m)
        if (control) next.set(sessionID, control)
        else next.delete(sessionID)
        return next
      })

    const mutateControl = (sessionID: string, f: (c: GoalControl) => void) =>
      SynchronizedRef.update(controls, (m) => {
        const c = m.get(sessionID)
        if (c) f(c)
        return m
      })

    // Publish a status → both the goal.updated event and the session-state active-goal pointer.
    const publishStatus = (sessionID: string, status: GoalStatus) =>
      Effect.gen(function* () {
        const phase = status.phase as string
        AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, phase as never)
        yield* events
          .publish(GoalEvent.Updated, {
            sessionID: SessionID.make(sessionID),
            goalId: status.goalId,
            planDocId: status.planDocId,
            phase,
            ledger: {
              ticks: status.ledger.ticks,
              tokens: status.ledger.tokens,
              cost: status.ledger.cost,
              wallclockMs: status.ledger.wallclockMs,
            },
            stallCount: status.stallCount,
            gaps: status.gaps,
          })
          .pipe(Effect.ignore)
      })

    const start: Interface["start"] = (input) =>
      Effect.gen(function* () {
        const sessionID = input.sessionID
        const session = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.orDie)
        const cwd = session.directory ?? process.cwd()

        // Resolve the goal's plan from the FIRST available source, in precedence order:
        //   1. session-state plan  — LOOP mode: the agent just produced the plan via the `plan` tool.
        //   2. repo goal+plan.md   — DESIGN mode: the HUMAN authored `.deepagent-code/plans/goal+plan.md`;
        //                            we parse it into a PlanDoc so the loop executes the user's plan as-is
        //                            (the agent does NOT regenerate it). Criteria declared in the file are
        //                            adopted unless the caller supplied explicit criteria.
        //   3. free-text objective — CLI `/goal <objective>`: seed a minimal single-step plan the worker
        //                            refines on the first tick.
        // With none of these, the plan stays null and the core rejects the start (a goal must be decidable).
        const existing = AgentGateway.DeepAgentSessionState.getPlan(sessionID) as PlanDoc | null
        const objective = input.objective?.trim()
        // Only fall back to the repo goal+plan.md (design mode) when there is NEITHER a session-state
        // plan (loop mode) NOR an explicit free-text objective. An explicit objective is a direct user
        // intent for THIS start and must win over a stale/leftover file in the workspace.
        const fromFile = existing == null && !objective ? readGoalPlanFile(cwd, sessionID) : null
        const plan =
          existing ??
          (objective
            ? createPlanDoc(sessionID, objective, [
                {
                  step_id: "step_1",
                  title: objective,
                  status: "active",
                  acceptance: null,
                  assigned_agent: null,
                  evidence: [],
                  note: null,
                },
              ])
            : (fromFile?.plan ?? null))
        const store = new DocumentStore(goalStoreRoot(sessionID))
        const planDocId =
          plan != null
            ? GoalDriver.materializePlanDoc({ store, sessionId: sessionID, plan })
            : GoalDriver.goalPlanScope(sessionID) // no plan + no objective → startGoal rejects (no doc)

        const model = yield* provider.defaultModel().pipe(Effect.orDie)

        const runTurn = makeTaskSubagentRunner({
          sessions,
          agents,
          sessionPrompt,
          parentSessionID: SessionID.make(sessionID),
          model: { providerID: model.providerID, modelID: model.modelID },
        })

        const deps = yield* GoalLoopWiring.makeGoalLoopWiring({
          store,
          parentSessionID: sessionID,
          cwd,
          runTurn,
          panelQuestion: () => input.panelQuestion ?? defaultPanelQuestion(),
          diagnostics,
          rollback,
        }).pipe(Effect.provideService(RuntimeFlags.Service, flags))
        // Flag OFF ⇒ wiring is null ⇒ the goal loop is unavailable. Reject clearly.
        if (deps == null) {
          return yield* Effect.fail(
            new InvalidGoalError({ reason: "goal loop is disabled (experimentalGoalLoop flag off)" }),
          )
        }

        // Criteria precedence mirrors the plan: explicit caller criteria win; else a design-mode file's
        // own criteria (when it declared any); else the built-in default (plan_complete + no_diagnostics).
        const criteria =
          input.criteria ??
          (fromFile && fromFile.criteria.length > 0 ? fromFile.criteria : DEFAULT_CRITERIA)

        const { handle } = yield* GoalDriver.startGoal({
          deps,
          planDocId,
          criteria,
          limits: { ...DEFAULT_LIMITS, ...input.limits },
          stallThreshold: input.stallThreshold,
        })

        // Register the session-state pointer so the UI reflects the goal even before the first tick.
        AgentGateway.DeepAgentSessionState.setActiveGoal(sessionID, {
          goalId: handle.goalId,
          planDocId: handle.planDocId,
          phase: "running",
          startedAt: new Date().toISOString(),
        })

        // The driver ports read the per-session control flags (pause/stop) live.
        const ports: GoalDriverPorts = {
          onStatus: (status) => publishStatus(sessionID, status),
          shouldPause: () => getControl(sessionID).pipe(Effect.map((c) => c?.paused ?? false)),
          shouldStop: () => getControl(sessionID).pipe(Effect.map((c) => c?.stopped ?? false)),
        }

        // Start the driver as a resident background task. onFinish clears the pointer / control state.
        const job = yield* background.start({
          type: "goal-loop",
          title: `goal ${handle.goalId}`,
          metadata: { sessionID, goalId: handle.goalId },
          run: GoalDriver.runToCompletion({ deps, handle, ports }).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                // A terminal outcome clears the running pointer to its terminal phase; a paused exit
                // leaves the pointer for a later resume.
                if (outcome !== "continue") {
                  AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, outcome as never)
                }
              }),
            ),
            Effect.map((outcome) => `goal ${handle.goalId}: ${outcome}`),
            Effect.catchCause(() => Effect.succeed(`goal ${handle.goalId}: driver defect`)),
          ),
        })

        yield* setControl(sessionID, {
          goalId: handle.goalId,
          planDocId: handle.planDocId,
          jobId: job.id,
          paused: false,
          stopped: false,
        })

        return { goalId: handle.goalId, planDocId: handle.planDocId, phase: "running", running: true }
      })

    const pause: Interface["pause"] = (sessionID) =>
      Effect.gen(function* () {
        const c = yield* getControl(sessionID)
        if (!c) return false
        yield* mutateControl(sessionID, (ctrl) => (ctrl.paused = true))
        AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, "paused")
        return true
      })

    const resume: Interface["resume"] = (sessionID) =>
      Effect.gen(function* () {
        const c = yield* getControl(sessionID)
        if (!c || c.stopped) return false
        yield* mutateControl(sessionID, (ctrl) => (ctrl.paused = false))
        AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, "running")
        // Re-drive: the persisted run_context doc resumes exactly where it paused. A fresh store handle
        // over the same root re-reads the loop state.
        const store = new DocumentStore(goalStoreRoot(sessionID))
        const model = yield* provider.defaultModel().pipe(Effect.orDie)
        const session = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.orDie)
        const runTurn = makeTaskSubagentRunner({
          sessions,
          agents,
          sessionPrompt,
          parentSessionID: SessionID.make(sessionID),
          model: { providerID: model.providerID, modelID: model.modelID },
        })
        const deps = yield* GoalLoopWiring.makeGoalLoopWiring({
          store,
          parentSessionID: sessionID,
          cwd: session.directory ?? process.cwd(),
          runTurn,
          panelQuestion: defaultPanelQuestion,
          diagnostics,
          rollback,
        }).pipe(Effect.provideService(RuntimeFlags.Service, flags))
        if (deps == null) return false
        const handle = { goalId: c.goalId, planDocId: c.planDocId, sessionId: sessionID }
        const ports: GoalDriverPorts = {
          onStatus: (status) => publishStatus(sessionID, status),
          shouldPause: () => getControl(sessionID).pipe(Effect.map((ctrl) => ctrl?.paused ?? false)),
          shouldStop: () => getControl(sessionID).pipe(Effect.map((ctrl) => ctrl?.stopped ?? false)),
        }
        const job = yield* background.start({
          type: "goal-loop",
          title: `goal ${c.goalId} (resumed)`,
          metadata: { sessionID, goalId: c.goalId },
          run: GoalDriver.runToCompletion({ deps, handle, ports }).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                if (outcome !== "continue")
                  AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, outcome as never)
              }),
            ),
            Effect.map((outcome) => `goal ${c.goalId}: ${outcome}`),
            Effect.catchCause(() => Effect.succeed(`goal ${c.goalId}: driver defect`)),
          ),
        })
        yield* mutateControl(sessionID, (ctrl) => (ctrl.jobId = job.id))
        return true
      })

    const stop: Interface["stop"] = (sessionID) =>
      Effect.gen(function* () {
        const c = yield* getControl(sessionID)
        if (!c) return false
        yield* mutateControl(sessionID, (ctrl) => (ctrl.stopped = true))
        yield* background.cancel(c.jobId).pipe(Effect.ignore)
        AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, "stopped")
        yield* setControl(sessionID, null)
        return true
      })

    const status: Interface["status"] = (sessionID) =>
      Effect.gen(function* () {
        const ptr = AgentGateway.DeepAgentSessionState.getActiveGoal(sessionID)
        if (!ptr) return null
        const c = yield* getControl(sessionID)
        return {
          goalId: ptr.goalId,
          planDocId: ptr.planDocId,
          phase: ptr.phase,
          running: c != null && !c.paused && !c.stopped,
        }
      })

    // Reference `flags` so an unused-var lint stays quiet; the real gate is makeGoalLoopWiring returning
    // null when experimentalGoalLoop is off (checked in start/resume).
    void flags

    return Service.of({ start, pause, resume, stop, status })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(SessionPrompt.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(BackgroundJob.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

export * as GoalManager from "./goal-manager"
