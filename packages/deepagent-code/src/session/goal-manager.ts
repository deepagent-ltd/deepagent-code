import { Effect, Layer, Context, SynchronizedRef } from "effect"
import path from "node:path"
import fs from "node:fs"
import { Global } from "@deepagent-code/core/global"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { createPlanDoc, type PlanDoc, type PlanInput } from "@deepagent-code/core/deepagent/plan-controller"
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
import { SessionSteer } from "./steer"
import { LSP } from "../lsp/lsp"
import { Provider } from "../provider/provider"
import { SessionID } from "./schema"
import { GoalEvent } from "./goal-event"
import { PlanEvent } from "../tool/plan-write"
import { Log } from "@deepagent-code/core/util/log"
import {
  GoalLoopWiring,
  liveDiagnostics,
  liveRollback,
  makeTaskSubagentRunner,
  type PanelQuestionInput,
} from "./goal-loop-wiring"
import { GoalDriver, type GoalDriverPorts } from "./goal-driver"
import { writeGovernanceAudit } from "./goal-governance-audit"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"

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

const glog = Log.create({ service: "session.goal" })

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

// §S1.3 FIX 2 — the terminal active-goal-pointer phases. A goal in any of these has settled: its driver
// job has returned (natural terminal) or been cancelled (stopped), so no further tick will drain the
// steer buffer. The goal-steer ingress (promptOrSteer) and editPlan refuse to admit once the pointer
// reports one of these (no orphan buffering). "running" and "paused" are the only non-terminal phases
// (a paused goal resumes and drains again).
export const isTerminalGoalPhase = (phase: string): boolean =>
  phase === "done" || phase === "needs_human" || phase === "rolled_back" || phase === "stopped"

// Per-session control state the driver ports read. Held in a SynchronizedRef so pause/stop from a route
// are observed by the running background driver without a lock.
type GoalControl = {
  readonly goalId: string
  readonly planDocId: string
  jobId: string
  paused: boolean
  stopped: boolean
  // Last-known observable status, cached so pause/resume/stop can publish an IMMEDIATE goal.updated that
  // carries the real ledger (not zeros). Updated every tick by publishStatus. Without this, a control
  // transition would either wait for the next tick (pause/resume — slow) or never publish at all (stop
  // cancels the job, so no further tick fires), leaving the UI status bar stuck on the prior phase.
  ledger: { ticks: number; tokens: number; cost: number; wallclockMs: number }
  stallCount: number
  gaps: readonly string[]
  // §S2 — a pending USER PLAN EDIT (the raw PlanInput) enqueued by editPlan, drained+applied by the
  // driver between ticks (pendingPlanEdit port) and cleared after apply (markPlanEditConsumed). Held here
  // on the control channel — NOT written to the durable doc from the HTTP fiber — because the running
  // driver holds its own DocumentStore handle (in-memory map) that would not see a separate handle's
  // write; the driver applies it via its own handle (buildPlanFromInput reconciles ids/evidence against
  // the live doc there). null ⇒ no pending edit. A newer edit replaces an un-applied older one
  // (last-write-wins: the user's latest revision is what takes effect).
  pendingPlanEdit: PlanInput | null
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

// Whether a goal can be started for a session RIGHT NOW, and where its plan would come from. The client
// gates the "convert plan → goal" affordance on this instead of guessing from session_plan alone —
// session_plan is only populated by the plan TOOL, but loop/design modes author the plan as the repo
// file `.deepagent-code/plans/goal+plan.md`, which start() also accepts. `source` lets the UI phrase
// the action correctly (existing in-session plan vs the authored repo file).
export type GoalStartable = {
  readonly startable: boolean
  readonly source: "plan" | "file" | "none"
}

export interface Interface {
  readonly start: (input: StartGoalInput) => Effect.Effect<GoalSnapshot, InvalidGoalError>
  readonly pause: (sessionID: string) => Effect.Effect<boolean>
  readonly resume: (sessionID: string) => Effect.Effect<boolean>
  readonly stop: (sessionID: string) => Effect.Effect<boolean>
  readonly status: (sessionID: string) => Effect.Effect<GoalSnapshot | null>
  readonly startable: (sessionID: string) => Effect.Effect<GoalStartable>
  /**
   * V4.1 §S2 — apply a USER plan edit to a RUNNING or PAUSED goal. The revised plan (a PlanInput) is
   * enqueued on the control channel and applied by the driver BETWEEN ticks (via its own store handle,
   * reconciled through buildPlanFromInput so step ids + evidence survive), which also RE-BASELINES the
   * Controller's stall/version tracking so the revision gets a fresh runway. Returns false when no goal
   * is running for the session OR the goal reached a terminal phase (no orphan edit). Takes effect on the
   * next tick (or on resume, if paused).
   */
  readonly editPlan: (input: { readonly sessionID: string; readonly plan: PlanInput }) => Effect.Effect<boolean>
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
    // §S1.3 — the durable steer buffer the goal driver drains between ticks (goal-directed steering).
    const steerBuffer = yield* SessionSteer.Service
    const events = yield* EventV2Bridge.Service
    const background = yield* BackgroundJob.Service
    const provider = yield* Provider.Service
    const lsp = yield* LSP.Service
    const flags = yield* RuntimeFlags.Service
    // V4.0 §N — the event bus + Approval Queue the goal loop escalates through. Only used when the
    // event-driven runtime flag is on (default OFF → behavior byte-identical to V3.9).
    const eventBus = yield* DeepAgentEventBus.Service
    const approvalQueue = yield* ApprovalQueue.Service

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

    // §S1.3 — the goal-tick steer PORT, backed by SessionSteer keyed on the GOAL (parent) session id AND
    // the DISTINCT `goal_steer` delivery channel.
    // TWO independence dimensions prevent any drainer contention:
    //   (a) SESSION-ID: the goal-worker turns run in FRESH child session ids (makeTaskSubagentRunner →
    //       sessions.create), so S1.1's intra-turn child-runLoop drain reads a DIFFERENT session's buffer.
    //   (b) DELIVERY: on the GOAL/parent session id there are TWO drainers — the parent's OWN runLoop
    //       (drainSteers, delivery="steer") and this goal driver. Scoping this port to delivery=
    //       "goal_steer" makes the two read DISJOINT rows, so a goal-directed steer is never swept into
    //       the parent chat history instead of the goal step prompt (FIX 1 — the design-level race).
    // pendingSteer is NON-consuming: the driver stamps consumed only AFTER the tick threads the steer; the
    // `consumed_seq IS NULL` guard keeps a stamped row from being re-drained by this channel.
    const goalSteerPort = (sessionID: string): GoalDriver.GoalSteerPort => ({
      pendingSteer: () =>
        steerBuffer.pending(SessionID.make(sessionID), GoalDriver.GOAL_STEER_DELIVERY).pipe(
          Effect.map((rows) => rows.map((r) => ({ id: r.id, text: r.prompt.text }))),
          Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<GoalDriver.PendingGoalSteer>)),
        ),
      markSteerConsumed: (ids) =>
        steerBuffer
          .markConsumed(SessionID.make(sessionID), [...ids], GoalDriver.GOAL_STEER_DELIVERY)
          .pipe(Effect.catchCause(() => Effect.void)),
    })

    // Per-session control state, observed by the running driver's ports.
    const controls = yield* SynchronizedRef.make(new Map<string, GoalControl>())

    // §S2 — the plan-edit driver ports over the control channel. pendingPlanEdit reads the control's
    // staged edit (non-consuming); markPlanEditConsumed clears it AFTER the driver applied+re-baselined
    // (consume-once). Kept on the control channel (not the durable doc) because the running driver holds
    // its own DocumentStore handle — see the GoalControl.pendingPlanEdit doc + loop.applyPlanEdit.
    const goalPlanEditPort = (sessionID: string): Pick<GoalDriverPorts, "pendingPlanEdit" | "markPlanEditConsumed"> => ({
      pendingPlanEdit: () => getControl(sessionID).pipe(Effect.map((c) => c?.pendingPlanEdit ?? null)),
      // Consume-once with an IDENTITY GUARD: clear the slot ONLY if it still holds the SAME edit object the
      // driver just applied. Without the guard, a newer edit E2 written by an HTTP fiber between the driver's
      // pendingPlanEdit read (E1) and this clear would be silently wiped — the driver already applied E1 and
      // won't re-read, so E2 is lost forever while editPlan told the user ok:true. Passing `applied` (the
      // reference the driver read) and comparing by identity keeps E2 pending → drained next iteration.
      markPlanEditConsumed: (applied) =>
        SynchronizedRef.update(controls, (m) => {
          const c = m.get(sessionID)
          if (!c || c.pendingPlanEdit == null) return m
          // A newer edit replaced the one we applied → leave it pending (do NOT clobber the newer revision).
          if (applied != null && c.pendingPlanEdit !== applied) return m
          const next = new Map(m)
          next.set(sessionID, { ...c, pendingPlanEdit: null })
          return next
        }),
    })

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

    // Low-level publisher: emit a goal.updated event over the SSE bridge. Best-effort (ignore) so a
    // publish failure never crashes the caller (start route or background driver tick).
    const publishGoalEvent = (
      sessionID: string,
      payload: {
        goalId: string
        planDocId: string
        phase: string
        ledger: { ticks: number; tokens: number; cost: number; wallclockMs: number }
        stallCount: number
        gaps: readonly string[]
      },
    ) =>
      events
        .publish(GoalEvent.Updated, {
          sessionID: SessionID.make(sessionID),
          goalId: payload.goalId,
          planDocId: payload.planDocId,
          phase: payload.phase,
          ledger: payload.ledger,
          stallCount: payload.stallCount,
          gaps: [...payload.gaps],
        })
        .pipe(Effect.ignore)

    // §S2 — mirror the goal's plan doc INTO the parent session's live plan state + emit plan.updated, so
    // the client's session_plan reflects the running goal's progress tick-by-tick. Without this the parent
    // session_plan is frozen at goal-start (the worker's plan edits land on its CHILD session + the goal
    // doc, never republished here), so the plan-edit dialog would pre-fill from STALE data and a save would
    // regress live progress (statuses would be reset to whatever the frozen snapshot showed). Reading the
    // goal doc — the single source of truth the grader uses — keeps the UI and the edit pre-fill honest.
    // Best-effort: a read/publish failure must never break the tick.
    const mirrorGoalPlanToSession = (sessionID: string, planDocId: string) =>
      Effect.gen(function* () {
        const store = new DocumentStore(goalStoreRoot(sessionID))
        const doc = store.get(planDocId)
        if (!doc) return
        let plan: PlanDoc
        try {
          plan = JSON.parse(doc.body) as PlanDoc
        } catch {
          return
        }
        // Keep the parent session's in-memory plan-state live (the dialog pre-fills from this).
        AgentGateway.DeepAgentSessionState.setPlan(sessionID, plan as never)
        const { done, total } = AgentGateway.DeepAgentPlanController.planProgress(plan)
        yield* events
          .publish(PlanEvent.Updated, {
            sessionID: SessionID.make(sessionID),
            plan_id: plan.plan_id,
            goal: plan.goal,
            active_step_id: plan.active_step_id,
            steps: plan.steps.map((s) => ({
              step_id: s.step_id,
              title: s.title,
              status: s.status,
              acceptance: s.acceptance ?? null,
              assigned_agent: s.assigned_agent ?? null,
              note: s.note ?? null,
            })),
            done,
            total,
          })
          .pipe(Effect.ignore)
      }).pipe(Effect.catchCause(() => Effect.void))

    // Publish a driver status → the goal.updated event, the session-state active-goal pointer, AND the
    // cached last-known status on the control (so control transitions can publish the real ledger).
    const publishStatus = (sessionID: string, status: GoalStatus) =>
      Effect.gen(function* () {
        const phase = status.phase as string
        AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, phase as never)
        // Keep the parent session_plan live with the goal's plan-doc progress (see helper doc).
        yield* mirrorGoalPlanToSession(sessionID, status.planDocId)
        const ledger = {
          ticks: status.ledger.ticks,
          tokens: status.ledger.tokens,
          cost: status.ledger.cost,
          wallclockMs: status.ledger.wallclockMs,
        }
        yield* mutateControl(sessionID, (ctrl) => {
          ctrl.ledger = ledger
          ctrl.stallCount = status.stallCount
          ctrl.gaps = status.gaps
        })
        yield* publishGoalEvent(sessionID, {
          goalId: status.goalId,
          planDocId: status.planDocId,
          phase,
          ledger,
          stallCount: status.stallCount,
          gaps: status.gaps,
        })
        // V4.0 §N — mirror the goal lifecycle onto the DeepAgent Event Bus (and escalations into the
        // §D2 Approval Queue). Flag-gated: OFF (default) ⇒ this whole block is skipped and the V3.9
        // goal.updated path above is unchanged. Best-effort: a bus/queue failure never breaks the loop.
        if (flags.v4MultiAgentRuntime) {
          yield* emitGoalLifecycleEvent(sessionID, status, phase).pipe(
            Effect.catchCause(() => Effect.void),
          )
        }
      })

    // §N — publish the discrete goal lifecycle event (goal.tick for a running tick, or the terminal
    // type) and, for a terminal escalation (needs_human / rolled_back), offer it to the Approval Queue.
    // The workspace key is the session's directory (matches how the Oversight surface scopes).
    const emitGoalLifecycleEvent = (sessionID: string, status: GoalStatus, phase: string) =>
      Effect.gen(function* () {
        const session = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.orElseSucceed(() => undefined))
        // workspace key MUST mirror the Oversight read side, else an escalation written here is keyed on
        // one identity while GET /oversight/approvals reads by another → invisible on the Dashboard in
        // server edition. Both sides derive the key via the SINGLE canonical rule (ApprovalQueue.
        // deriveWorkspaceKey): a genuine wrk_ workspaceID wins, else the directory, with sessionID as the
        // last-resort fallback so a key is always produced.
        const workspaceID = ApprovalQueue.deriveWorkspaceKey({
          workspaceID: session?.workspaceID,
          directory: session?.directory,
          fallback: sessionID,
        })
        // map the driver phase → the discrete §N event type (running/paused/stopped ⇒ goal.tick).
        const eventType = LMNEvents.goalPhaseToEventType(phase) ?? LMNEvents.GOAL_TICK
        // idempotencyKey reuses the V3.9 plan-version idempotency intent: one event per (goal, phase,
        // tick) so a re-published status doesn't double-emit.
        const idempotencyKey = `goal:${status.goalId}:${phase}:${status.ledger.ticks}`
        // §E2 RATE GATE + §D2 no-silent-loss: any event that must reach the Approval Queue MUST publish
        // at "high" so it BYPASSES the per-workspace ceiling and always persists + offers. This is NOT
        // just goal.needs_human — goal.rolled_back is also a terminal APPROVAL_QUEUE_TYPES member, and
        // because the publish limiter is shared per-workspace it could otherwise be shed by an unrelated
        // im.message.created flood in the same minute → a rollback needing human review silently lost.
        // `isApprovalQueueCandidate` folds the full APPROVAL_QUEUE_TYPES set; goal.tick / goal.completed
        // are NOT candidates, stay "normal", and remain correctly sheddable under load.
        const priority = LMNEvents.isApprovalQueueCandidate(eventType) ? "high" : "normal"
        // §E2 RATE GATE (live): the goal driver is a workspace-facing publisher (one event per tick),
        // so it goes through `tryPublish` under the 1000/min per-workspace ceiling. A `goal.tick` /
        // `goal.completed` is `normal` and CAN be shed under a flood; an approval-queue candidate
        // (needs_human / rolled_back) is `high` and ALWAYS bypasses the gate — never dropped. On a drop
        // we skip the approval offer (there is no persisted event to queue) and record §A4 event_dropped.
        const outcome = yield* eventBus.tryPublish({
          type: eventType,
          source: "system",
          workspaceID,
          actorID: sessionID,
          correlationID: status.goalId,
          idempotencyKey,
          priority,
          // T2.4 archive contract: goal.completed is an ARCHIVE_TRIGGER, and the EventDrivenArchiver
          // discards any trigger whose payload lacks sessionID + workspacePath (see
          // event-driven-archiver.ts). Carry both (workspacePath = the session directory, mirroring
          // session-completed-publisher's `facts.directory`) so a completed goal is actually archived
          // instead of being silently dropped at the archiver. Harmless on non-archive phases.
          payload: {
            goalId: status.goalId,
            planDocId: status.planDocId,
            phase,
            gaps: status.gaps,
            sessionID,
            workspacePath: session?.directory,
          },
        })
        if ("dropped" in outcome) {
          yield* Effect.logWarning("goal lifecycle event dropped by publish rate gate").pipe(
            Effect.annotateLogs({
              reason: "event_dropped",
              cause: "rate_limited",
              workspaceID,
              goalId: status.goalId,
              phase,
            }),
          )
          return
        }
        // terminal escalations queue for human review (§D2). shouldQueueForApproval gates it.
        yield* approvalQueue.offer(outcome.published)
      })

    // Publish an IMMEDIATE goal.updated for a control transition (pause/resume/stop). Reuses the control's
    // cached ledger/stall/gaps so the UI keeps its live budget readout while only the phase changes.
    const publishControlPhase = (sessionID: string, control: GoalControl, phase: string) =>
      publishGoalEvent(sessionID, {
        goalId: control.goalId,
        planDocId: control.planDocId,
        phase,
        ledger: control.ledger,
        stallCount: control.stallCount,
        gaps: control.gaps,
      })

    // Reflect a driver's terminal outcome into the active-goal pointer — but ONLY if the goal is still
    // controlled. A user `stop()` clears the control (setControl null) and has already set the pointer to
    // "stopped" and published it; the cancelled driver may still settle with its own outcome (e.g. it
    // observed shouldStop and returned "needs_human") whose late tap would otherwise clobber "stopped".
    // Guarding on a live control makes the explicit stop authoritative and drops the racing outcome.
    const finalizeOutcome = (sessionID: string, outcome: string) =>
      getControl(sessionID).pipe(
        Effect.flatMap((c) =>
          Effect.sync(() => {
            if (outcome !== "continue" && c != null) {
              AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, outcome as never)
            }
          }),
        ),
      )

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

        // §S1.3 — ONE goal-steer relay per run, shared by the wiring (executor threads staged guidance
        // into the step prompt) and the driver (drains between ticks + stamps consumed after the tick).
        const steerRelay = GoalDriver.makeGoalSteerRelay()

        // §S1.3 hygiene — the goal_steer buffer is scoped by (session_id, delivery) with NO goal_id column,
        // and stop() does not drain pending rows. So a goal_steer admitted for a PRIOR goal on this session
        // (e.g. one that landed right before the prior goal settled and was never threaded) would otherwise
        // be read by THIS new goal's first between-tick drain — cross-goal contamination. Purge any leftover
        // pending goal_steer rows at start so the new goal begins with a clean buffer. Best-effort: a failure
        // here must not block starting the goal (the worst case is the pre-existing leak, not a new defect).
        yield* steerBuffer
          .pending(SessionID.make(sessionID), GoalDriver.GOAL_STEER_DELIVERY)
          .pipe(
            Effect.flatMap((stale) =>
              stale.length === 0
                ? Effect.void
                : steerBuffer.markConsumed(
                    SessionID.make(sessionID),
                    stale.map((s) => s.id),
                    GoalDriver.GOAL_STEER_DELIVERY,
                  ),
            ),
            Effect.catchCause(() => Effect.void),
          )

        const deps = yield* GoalLoopWiring.makeGoalLoopWiring({
          store,
          parentSessionID: sessionID,
          cwd,
          runTurn,
          panelQuestion: () => input.panelQuestion ?? defaultPanelQuestion(),
          diagnostics,
          rollback,
          steerRelay,
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

        // Emit an IMMEDIATE goal.updated (phase=running, empty ledger) BEFORE the first tick. The first
        // driver tick is a full subagent turn (tens of seconds), and onStatus only fires AFTER it — so
        // without this, the client's session_goal store stays empty and the "convert plan → goal" hint
        // never flips to the GoalStatusBar, leaving the user with no confirmation the goal started. This
        // seeds the store the moment start returns, so the UI reflects the running goal instantly.
        yield* publishGoalEvent(sessionID, {
          goalId: handle.goalId,
          planDocId: handle.planDocId,
          phase: "running",
          ledger: { ticks: 0, tokens: 0, cost: 0, wallclockMs: 0 },
          stallCount: 0,
          gaps: [],
        })

        // The driver ports read the per-session control flags (pause/stop) live, plus the §S1.3 goal-steer
        // channel (drained between ticks and threaded into the next step prompt via the shared relay).
        const steerPort = goalSteerPort(sessionID)
        const planEditPort = goalPlanEditPort(sessionID)
        const ports: GoalDriverPorts = {
          onStatus: (status) => publishStatus(sessionID, status),
          shouldPause: () => getControl(sessionID).pipe(Effect.map((c) => c?.paused ?? false)),
          shouldStop: () => getControl(sessionID).pipe(Effect.map((c) => c?.stopped ?? false)),
          pendingSteer: steerPort.pendingSteer,
          markSteerConsumed: steerPort.markSteerConsumed,
          pendingPlanEdit: planEditPort.pendingPlanEdit,
          markPlanEditConsumed: planEditPort.markPlanEditConsumed,
        }

        // Start the driver as a resident background task. onFinish clears the pointer / control state.
        const job = yield* background.start({
          type: "goal-loop",
          title: `goal ${handle.goalId}`,
          metadata: { sessionID, goalId: handle.goalId },
          run: GoalDriver.runToCompletion({ deps, handle, ports, steerRelay }).pipe(
            // A terminal outcome clears the running pointer to its terminal phase (unless the user already
            // stopped it); a paused exit ("continue") leaves the pointer for a later resume.
            Effect.tap((outcome) => finalizeOutcome(sessionID, outcome)),
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
          ledger: { ticks: 0, tokens: 0, cost: 0, wallclockMs: 0 },
          stallCount: 0,
          gaps: [],
          pendingPlanEdit: null,
        })

        return { goalId: handle.goalId, planDocId: handle.planDocId, phase: "running", running: true }
      })

    const pause: Interface["pause"] = (sessionID) =>
      Effect.gen(function* () {
        const c = yield* getControl(sessionID)
        if (!c) return false
        yield* mutateControl(sessionID, (ctrl) => (ctrl.paused = true))
        AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, "paused")
        // Immediate goal.updated so the status bar flips to "paused" now, not after the in-flight tick.
        yield* publishControlPhase(sessionID, c, "paused")
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
        // §S1.3 — a fresh relay for the resumed run (steers admitted while paused are still pending in the
        // durable buffer, so the resumed driver re-drains and threads them on its first tick — no loss).
        const steerRelay = GoalDriver.makeGoalSteerRelay()
        const deps = yield* GoalLoopWiring.makeGoalLoopWiring({
          store,
          parentSessionID: sessionID,
          cwd: session.directory ?? process.cwd(),
          runTurn,
          panelQuestion: defaultPanelQuestion,
          diagnostics,
          rollback,
          steerRelay,
        }).pipe(Effect.provideService(RuntimeFlags.Service, flags))
        if (deps == null) return false
        const handle = { goalId: c.goalId, planDocId: c.planDocId, sessionId: sessionID }
        const steerPort = goalSteerPort(sessionID)
        const planEditPort = goalPlanEditPort(sessionID)
        const ports: GoalDriverPorts = {
          onStatus: (status) => publishStatus(sessionID, status),
          shouldPause: () => getControl(sessionID).pipe(Effect.map((ctrl) => ctrl?.paused ?? false)),
          shouldStop: () => getControl(sessionID).pipe(Effect.map((ctrl) => ctrl?.stopped ?? false)),
          pendingSteer: steerPort.pendingSteer,
          markSteerConsumed: steerPort.markSteerConsumed,
          pendingPlanEdit: planEditPort.pendingPlanEdit,
          markPlanEditConsumed: planEditPort.markPlanEditConsumed,
        }
        const job = yield* background.start({
          type: "goal-loop",
          title: `goal ${c.goalId} (resumed)`,
          metadata: { sessionID, goalId: c.goalId },
          run: GoalDriver.runToCompletion({ deps, handle, ports, steerRelay }).pipe(
            Effect.tap((outcome) => finalizeOutcome(sessionID, outcome)),
            Effect.map((outcome) => `goal ${c.goalId}: ${outcome}`),
            Effect.catchCause(() => Effect.succeed(`goal ${c.goalId}: driver defect`)),
          ),
        })
        yield* mutateControl(sessionID, (ctrl) => (ctrl.jobId = job.id))
        // Immediate goal.updated so the status bar flips back to "running" now. The resumed driver's
        // first tick may be tens of seconds away; without this the bar would stay stuck on "paused".
        yield* publishControlPhase(sessionID, c, "running")
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
        // Immediate goal.updated is MANDATORY here: cancelling the job means no further tick will ever
        // fire onStatus, so this is the ONLY event that can move the status bar off its prior phase.
        // Without it the UI is stuck showing "running" forever after the user hits stop.
        yield* publishControlPhase(sessionID, c, "stopped")
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

    // Whether start() would find a plan to run — mirrors its plan-resolution precedence WITHOUT side
    // effects (no doc materialized, no driver started). Flag-gated: a disabled goal loop is never
    // startable. session_plan (loop-tool authored) wins; else the repo goal+plan.md (loop/design file);
    // else none. Used by the client to gate the convert-to-goal affordance in the modes where it applies.
    const startable: Interface["startable"] = (sessionID) =>
      Effect.gen(function* () {
        if (!flags.experimentalGoalLoop) return { startable: false, source: "none" as const }
        const existing = AgentGateway.DeepAgentSessionState.getPlan(sessionID) as PlanDoc | null
        if (existing != null) return { startable: true, source: "plan" as const }
        const session = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.orDie)
        const cwd = session.directory ?? process.cwd()
        const fromFile = readGoalPlanFile(cwd, sessionID)
        if (fromFile?.plan != null) return { startable: true, source: "file" as const }
        return { startable: false, source: "none" as const }
      })

    // §S2 — apply a USER plan edit to a running/paused goal. Like the goal-steer path, this does NOT touch the
    // durable doc directly (the running driver holds its own DocumentStore handle that would not see an
    // HTTP-fiber write). It ENQUEUES the revised plan onto the control channel; the driver drains it
    // between ticks and applies it via its own handle (loop.applyPlanEdit → upsert + re-baseline). Refuses
    // when no goal is running OR the goal reached a terminal phase (the orphan guard: no live driver to
    // drain a terminal goal). The
    // revised plan is normalized through buildPlanFromInput, which PRESERVES step ids + evidence across the
    // rewrite (accumulated proof survives a re-status/reorder). Last-write-wins: a newer edit replaces an
    // un-applied older one on the control slot.
    const editPlan: Interface["editPlan"] = (input) =>
      Effect.gen(function* () {
        const c = yield* getControl(input.sessionID)
        if (!c || c.stopped) return false
        const ptr = AgentGateway.DeepAgentSessionState.getActiveGoal(input.sessionID)
        if (ptr && isTerminalGoalPhase(ptr.phase)) return false
        // Enqueue the RAW PlanInput on the control channel. The driver applies it between ticks via
        // loop.applyPlanEdit, which reconciles it (buildPlanFromInput, preserving ids/evidence) against
        // the live doc using the driver's own store handle — not from this HTTP fiber (whose separate
        // handle would not see the running driver's in-memory doc). Last-write-wins on the slot.
        yield* SynchronizedRef.update(controls, (m) => {
          const ctrl = m.get(input.sessionID)
          if (!ctrl) return m
          const next = new Map(m)
          next.set(input.sessionID, { ...ctrl, pendingPlanEdit: input.plan })
          return next
        })
        // Audit + operational log the human plan edit (enqueue-time; the driver applies it next tick).
        writeGovernanceAudit(input.sessionID, c.goalId, "plan_edit", {
          stepCount: input.plan.steps.length,
          goalChars: input.plan.goal.length,
        })
        glog.info("goal plan hot-edit enqueued", {
          sessionID: input.sessionID,
          goalId: c.goalId,
          stepCount: input.plan.steps.length,
        })
        return true
      })

    return Service.of({ start, pause, resume, stop, status, startable, editPlan })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(SessionPrompt.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(SessionSteer.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(BackgroundJob.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(DeepAgentEventBus.defaultLayer),
    Layer.provide(ApprovalQueue.defaultLayer),
  ),
)

export * as GoalManager from "./goal-manager"
