import { Effect, Layer, Context, SynchronizedRef, Option, Schedule } from "effect"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalControlSchema } from "@deepagent-code/core/deepagent/goal-control.schema"
import { initializeGoal } from "@deepagent-code/core/deepagent/goal-loop"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { Hash } from "@deepagent-code/core/util/hash"
import { GoalControlDispatcher } from "./goal-control-dispatcher"
import path from "node:path"
import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { Global } from "@deepagent-code/core/global"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { DeepAgentLearningGeneration } from "@deepagent-code/core/deepagent/learning-generation"
import {
  buildPlanFromWriteInput,
  createPlanDoc,
  PlanConflictError,
  PlanValidationError,
  type PlanDoc,
  type PlanWriteInput,
} from "@deepagent-code/core/deepagent/plan-controller"
import { decodePlanDoc } from "@deepagent-code/core/deepagent/plan-store"
import {
  PlanEditBusyError,
  PlanEditChallengeError,
  PlanEditMailboxConflictError,
  PlanEditProtocolCorruptionError,
  PlanEditRequestConflictError,
  PlanEditTargetUnavailableError,
  admitPlanEditCommand,
  createPlanEditCommand,
  issuePlanEditChallenge,
  readPendingPlanEditCommand,
  readPlanEditReceiptByRequest,
  settlePlanEditCommand,
  type PlanEditReceipt,
} from "@deepagent-code/core/deepagent/plan-edit-protocol"
import { parseGoalPlanFile, GOAL_PLAN_FILE, type ParsedGoalPlan } from "@deepagent-code/core/deepagent/goal-plan-file"
import type { GoalStatus, GoalLimits, CompletionCriterion } from "@deepagent-code/core/deepagent/goal-loop"
import { InvalidGoalError } from "@deepagent-code/core/deepagent/goal-loop"
import { RuntimeFlags } from "../effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@deepagent-code/core/database/database"
import { BackgroundJob } from "@/background/job"
import { SessionV2 } from "@deepagent-code/core/session"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Snapshot } from "../snapshot"
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
  liveRollbackNotice,
  makeTaskSubagentRunner,
  type PanelQuestionInput,
} from "./goal-loop-wiring"
import { GoalDriver, type GoalDriverPorts } from "./goal-driver"
import { writeGovernanceAudit } from "./goal-governance-audit"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { readGoalTickCursor } from "@deepagent-code/core/deepagent/goal-loop"
import { makeGoalStatusPublisher } from "./goal-status-publisher"
import { GoalTickConsumer } from "./goal-tick-consumer"
import { GoalTickExecution } from "./goal-tick-execution"
import { GoalTickProjection } from "./goal-tick-projection"

/**
 * Goal commands commit to SQL before advisory notification or event publication. A stable preparation
 * identity initializes the existing GoalLoop DocumentStore, then atomically activates its receipt and
 * wake obligation. Production ticks require a durable permit; process-local maps are UI mirrors only.
 * This first slice pins event mode and does not adopt legacy resident Goals or claim strong child stop.
 */

// The DocumentStore holding a session's goal docs. Co-located with the run graph under the agent data
// root, keyed by session id, so a restart re-opens the same store (the loop state is restart-recoverable).
export const goalStoreRoot = (sessionID: string): string =>
  path.join(Global.Path.agent.data, "state", "goal", sessionID, "graph")

const glog = Log.create({ service: "session.goal" })

// DESIGN mode's plan source: read the human-authored `.deepagent-code/plans/goal+plan.md` from the
// session's working directory and parse it into a PlanDoc (+ any declared criteria). Default-safe — a
// missing/unreadable/malformed file returns null so `start` falls through to the next plan source and
// never throws. The parser (core) is pure; the fs read lives here at the wiring seam.
export const readGoalPlanFile = (cwd: string, sessionID: string): ParsedGoalPlan | null => {
  try {
    const root = fs.realpathSync(cwd)
    const file = path.join(root, GOAL_PLAN_FILE)
    const paths = [cwd, root, path.dirname(path.dirname(file)), path.dirname(file)]
    const parents = paths.map((directory) => fs.lstatSync(directory, { bigint: true }))
    if (parents.some((stat) => !stat.isDirectory() || stat.isSymbolicLink())) return null
    const actual = fs.realpathSync(file)
    if (actual !== file || path.relative(root, actual).startsWith(`..${path.sep}`)) return null
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const before = fs.fstatSync(fd, { bigint: true })
      if (!before.isFile() || before.size < 0n || before.size > 262144n) return null
      const bytes = Buffer.alloc(Number(before.size) + 1)
      let offset = 0
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, Math.min(32768, bytes.length - offset), offset)
        if (count === 0) break
        offset += count
      }
      const after = fs.fstatSync(fd, { bigint: true })
      const current = fs.lstatSync(file, { bigint: true })
      const same = (left: fs.BigIntStats, right: fs.BigIntStats) =>
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
      if (
        offset !== Number(before.size) ||
        !same(before, after) ||
        !same(after, current) ||
        paths.some((directory, index) => !same(parents[index]!, fs.lstatSync(directory, { bigint: true }))) ||
        fs.realpathSync(cwd) !== root ||
        fs.realpathSync(file) !== file
      )
        return null
      const content = bytes.subarray(0, offset)
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content)
      if (!Buffer.from(text).equals(content)) return null
      return parseGoalPlanFile(sessionID, text)
    } finally {
      fs.closeSync(fd)
    }
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

// Compatibility cache for local plan-edit/UI projections. SQL owns lifecycle control and tick admission.
type GoalMirror = {
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
}

export type StartGoalInput = {
  readonly requestID: string
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

export type GoalSnapshot = GoalControlSchema.Snapshot

// Whether a goal can be started for a session RIGHT NOW, and where its plan would come from. The client
// gates the "convert plan → goal" affordance on this instead of guessing from session_plan alone —
// session_plan is only populated by the plan TOOL, but loop/design modes author the plan as the repo
// file `.deepagent-code/plans/goal+plan.md`, which start() also accepts. `source` lets the UI phrase
// the action correctly (existing in-session plan vs the authored repo file).
export type GoalStartable = {
  readonly startable: boolean
  readonly source: "plan" | "file" | "none"
}

export class GoalPlanEditUnavailableError extends Error {
  readonly _tag = "GoalPlanEditUnavailableError"
  override readonly name = "GoalPlanEditUnavailableError"

  constructor(readonly reason: string) {
    super(`Goal plan edit admission is unavailable: ${reason}`)
  }
}

export type GoalPlanEditAdmissionError =
  | PlanValidationError
  | PlanConflictError
  | PlanEditBusyError
  | PlanEditChallengeError
  | PlanEditMailboxConflictError
  | PlanEditProtocolCorruptionError
  | PlanEditRequestConflictError
  | PlanEditTargetUnavailableError
  | GoalPlanEditUnavailableError

export interface Interface {
  readonly start: (
    input: StartGoalInput,
  ) => Effect.Effect<GoalControlSchema.Snapshot, InvalidGoalError | GoalControlSchema.Error>
  readonly pause: (
    input: GoalControlSchema.ControlInput,
  ) => Effect.Effect<GoalControlSchema.Snapshot, GoalControlSchema.Error>
  readonly resume: (
    input: GoalControlSchema.ControlInput,
  ) => Effect.Effect<GoalControlSchema.Snapshot, GoalControlSchema.Error>
  readonly stop: (
    input: GoalControlSchema.ControlInput,
  ) => Effect.Effect<GoalControlSchema.Snapshot, GoalControlSchema.Error>
  readonly status: (sessionID: string) => Effect.Effect<GoalControlSchema.Snapshot | null, GoalControlSchema.Error>
  readonly startable: (sessionID: string) => Effect.Effect<GoalStartable>
  /**
   * V4.1 §S2 — apply a USER plan edit to a RUNNING or PAUSED goal. The revised plan (a PlanInput) is
   * enqueued on the control channel and admitted by the driver BETWEEN ticks (via its own store handle,
   * with exact identity checks and runtime-owned evidence), which also RE-BASELINES the
   * Controller's stall/version tracking so the revision gets a fresh runway. Returns false when no goal
   * is running for the session OR the goal reached a terminal phase (no orphan edit). Takes effect on the
   * next tick (or on resume, if paused).
   */
  readonly editPlan: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly planWrite: PlanWriteInput
    readonly qualityChallengeID?: string
  }) => Effect.Effect<PlanEditReceipt, GoalPlanEditAdmissionError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/GoalManager") {}

const DEFAULT_LIMITS: GoalLimits = { maxTicks: 50, maxTokens: 500_000, maxWallclockMs: 60 * 60 * 1000 }
const DEFAULT_CRITERIA: readonly CompletionCriterion[] = [{ kind: "plan_complete" }, { kind: "no_diagnostics" }]

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const revert = yield* SessionRevert.Service
    // §S1.3 — the durable steer buffer the goal driver drains between ticks (goal-directed steering).
    const steerBuffer = yield* SessionSteer.Service
    const events = yield* EventV2Bridge.Service
    const background = yield* BackgroundJob.Service
    const provider = yield* Provider.Service
    const lsp = yield* LSP.Service
    const flags = yield* RuntimeFlags.Service
    // Capture the V2 owner explicitly — it is REQUIRED (the legacy SessionPrompt subagent fallback is
    // deleted), so a composition without the SessionV2 stack fails at layer build, not on first turn.
    // A sibling layer is not an input dependency.
    const v2Session = yield* SessionV2.Service
    const v2Snapshot = yield* Snapshot.Service
    // V4.0 §N — the event bus + Approval Queue the goal loop escalates through. Only used when the
    // event-driven runtime flag is on (default OFF → behavior byte-identical to V3.9).
    const eventBus = yield* DeepAgentEventBus.Service
    const approvalQueue = yield* ApprovalQueue.Service
    const { db } = yield* Database.Service
    const flock = yield* EffectFlock.Service
    const ownedFrames = yield* Effect.serviceOption(GoalTickExecution.Service)
    if (flags.v4MultiAgentRuntime || flags.v4GoalTickEventDriven) {
      yield* GoalControlDispatcher.drain(db, eventBus).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.repeat(Schedule.spaced("2 seconds")),
        Effect.forkScoped,
      )
    }

    // Diagnostics accessor with LSP already provided, so the goal-loop wiring stays free of LSP in its
    // requirement channel (liveDiagnostics needs LSP.Service; we satisfy it here at construction).
    const diagnostics = () => liveDiagnostics().pipe(Effect.provideService(LSP.Service, lsp))

    // Rollback port shared by start + resume (best-effort revert to the last message + the B5
    // one-shot rollback notice published to the reverted session).
    const rollback = liveRollback(
      revert,
      (sid) =>
        sessions.messages({ sessionID: SessionID.make(sid) }).pipe(
          Effect.map((msgs) => msgs.at(-1)?.info.id ?? null),
          Effect.catchCause(() => Effect.succeed(null)),
        ),
      liveRollbackNotice(events, db),
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

    // Resolve the model the goal loop should run with. Prefer the SESSION's selected model (what the
    // user picked in the composer — e.g. GLM-5.2), since a goal is a continuation of that conversation;
    // fall back to the config default. If NEITHER resolves, fail with a clean InvalidGoalError instead
    // of dying — otherwise a workspace with no config-default model turns the whole request into an
    // opaque 500 ("[object Object]") even though the user has a working model selected.
    const resolveGoalModel = (session: { model?: { providerID: string; id: string } }) =>
      Effect.gen(function* () {
        if (session.model) {
          return { providerID: session.model.providerID, modelID: session.model.id }
        }
        const fallback = yield* provider.defaultModel().pipe(Effect.option)
        if (Option.isNone(fallback)) {
          return yield* Effect.fail(
            new InvalidGoalError({
              reason: "no model is configured for this session — select a model, then start the goal",
            }),
          )
        }
        return { providerID: fallback.value.providerID, modelID: fallback.value.modelID }
      })

    // Per-session control state, observed by the running driver's ports.
    const controls = yield* SynchronizedRef.make(new Map<string, GoalMirror>())

    // §S2 — both warm and cold drivers drain and settle the SAME durable activity mailbox. Admission is
    // complete only after the queued receipt is fsync-backed; there is no in-memory fallback and no LWW slot.
    const goalPlanEditPort = (sessionID: string): Pick<GoalDriverPorts, "pendingPlanEdit" | "settlePlanEdit"> => ({
      pendingPlanEdit: () =>
        getControl(sessionID).pipe(
          Effect.map((control) =>
            control == null
              ? null
              : readPendingPlanEditCommand(DocumentStore.shared(goalStoreRoot(sessionID)), sessionID, control.goalId),
          ),
        ),
      settlePlanEdit: (command, settlement) =>
        Effect.sync(() => {
          settlePlanEditCommand(DocumentStore.shared(goalStoreRoot(sessionID)), command, settlement)
        }),
    })

    const getControl = (sessionID: string) =>
      SynchronizedRef.get(controls).pipe(Effect.map((m) => m.get(sessionID) ?? null))

    const setControl = (sessionID: string, control: GoalMirror | null) =>
      SynchronizedRef.update(controls, (m) => {
        const next = new Map(m)
        if (control) next.set(sessionID, control)
        else next.delete(sessionID)
        return next
      })

    const mutateControl = (sessionID: string, f: (c: GoalMirror) => void) =>
      SynchronizedRef.update(controls, (m) => {
        const c = m.get(sessionID)
        if (c) f(c)
        return m
      })

    // V4.1 §N — the SHARED status publisher. publishGoalEvent (raw goal.updated) + publishStatus (the
    // full onStatus port: mirror plan → session-state, publish goal.updated, flag-on mirror to bus +
    // approval queue). Extracted to goal-status-publisher.ts so the event-driven cold consumer's port
    // (makeGoalTickPort) runs the IDENTICAL logic — no drift. The only goal-manager-specific step is
    // caching the tick's ledger on the in-memory control (so pause/resume/stop publish the real ledger);
    // that rides the optional `cacheStatus` callback here and is simply omitted on the cold path.
    const statusPublisher = makeGoalStatusPublisher({
      controlDB: db,
      events,
      sessions,
      eventBus,
      approvalQueue,
      v4MultiAgentRuntime: flags.v4MultiAgentRuntime,
      v4GoalTickEventDriven: flags.v4GoalTickEventDriven,
      goalStoreRoot,
      cacheStatus: (sessionID, cached) =>
        mutateControl(sessionID, (ctrl) => {
          ctrl.ledger = cached.ledger
          ctrl.stallCount = cached.stallCount
          ctrl.gaps = cached.gaps
        }),
    })
    const publishGoalEvent = statusPublisher.publishGoalEvent
    const publishStatus = statusPublisher.publishStatus

    // Publish an IMMEDIATE goal.updated for a control transition (pause/resume/stop). Reuses the control's
    // cached ledger/stall/gaps so the UI keeps its live budget readout while only the phase changes.
    const publishControlPhase = (sessionID: string, control: GoalMirror, phase: string) =>
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

    const initializePrepared = (row: GoalControl.Row, requestID: string, requestHash: string) =>
      flock
        .withLock(
          Effect.gen(function* () {
            if (row.initialization.executionContract === "owned-goal-v2")
              return yield* GoalTickProjection.initialize(db, {
                row,
                requestID,
                requestHash,
                directory: goalStoreRoot(row.session_id),
              })
            const store = DocumentStore.shared(goalStoreRoot(row.session_id))
            store.rebuildIndex()
            const plan = store.get(row.plan_doc_id)
            if (
              !plan ||
              plan.version !== row.initialization.planVersion ||
              Hash.sha256(plan.body) !== row.initialization.planHash
            )
              return yield* new GoalControlSchema.Error({
                code: "recovery_required",
                message: "Goal plan changed during durable initialization",
              })
            const existing = store
              .list({ type: "run_context", scope: GoalDriver.goalPlanScope(row.session_id) })
              .filter((ref) => store.get(ref.id)?.extensions?.goal_id === row.goal_id)
            const cursor = readGoalTickCursor(store, row.session_id, row.goal_id)
            if (
              existing.length &&
              (!cursor ||
                cursor.seq !== 0 ||
                cursor.phase !== "running" ||
                cursor.planVersion !== row.initialization.planVersion)
            )
              return yield* new GoalControlSchema.Error({
                code: "recovery_required",
                message: "Goal preparation has an unreadable or advanced initialization record",
              })
            yield* initializeGoal(
              { store, now: () => row.created_at, netTokenBudget: row.initialization.netTokenBudget },
              row.initialization.spec,
              row.goal_id,
            )
            return yield* GoalControl.activate(db, {
              sessionID: row.session_id,
              goalId: row.goal_id,
              requestID,
              requestHash,
            })
          }),
          `goal-initialize-${row.goal_id}`,
          goalStoreRoot(row.session_id),
        )
        .pipe(
          Effect.catchTag(
            "SqlError",
            () =>
              new GoalControlSchema.Error({
                code: "recovery_required",
                message: "Goal initialization transaction could not be confirmed",
              }),
          ),
          Effect.catchTag(["LockCompromisedError", "LockTimeoutError"], () =>
            Effect.fail(
              new GoalControlSchema.Error({ code: "unavailable", message: "Goal initialization lock is unavailable" }),
            ),
          ),
        )

    const start: Interface["start"] = (input) =>
      Effect.gen(function* () {
        if (!input.requestID)
          return yield* new GoalControlSchema.Error({
            code: "invalid_request",
            message: "Goal start requires a stable requestID",
          })
        if (!flags.experimentalGoalLoop || !(flags.v4MultiAgentRuntime || flags.v4GoalTickEventDriven))
          return yield* new GoalControlSchema.Error({
            code: "unsupported",
            message: "Durable event Goal control is disabled; resident mode is not adopted",
          })
        const sessionID = input.sessionID
        const requestHash = GoalControl.fingerprint(input)
        const source = yield* GoalControl.session(db, sessionID)
        const previous = yield* GoalControl.command(db, sessionID, input.requestID)
        if (previous) {
          if (previous.request_hash !== requestHash || previous.action !== "start")
            return yield* new GoalControlSchema.Error({
              code: "request_conflict",
              message: "Goal start requestID has different content",
            })
          if (previous.receipt) return { ...previous.receipt, replayed: true }
          const row = yield* GoalControl.get(db, previous.goal_id)
          if (!row)
            return yield* new GoalControlSchema.Error({
              code: "recovery_required",
              message: "Goal preparation authority is missing",
            })
          return yield* initializePrepared(row, input.requestID, requestHash)
        }
        const active = yield* GoalControl.current(db, sessionID)
        if (
          active &&
          (!GoalControl.isTerminal(active.requested_phase) || (yield* GoalControl.snapshot(db, active)).inFlight)
        )
          return yield* new GoalControlSchema.Error({
            code: "busy",
            message: "The Session already has an active or unresolved Goal",
          })
        const legacy = AgentGateway.DeepAgentSessionState.getActiveGoal(sessionID)
        if (legacy && !GoalControl.isTerminal(legacy.phase) && !(yield* GoalControl.current(db, sessionID)))
          return yield* new GoalControlSchema.Error({
            code: "recovery_required",
            message: "Legacy Goal must be explicitly reconciled before a new Goal starts",
          })
        const session = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.orDie)
        const cwd = source.directory
        const existing = yield* Effect.try({
          try: () => GoalTickProjection.readPlan(goalStoreRoot(sessionID), sessionID)?.plan ?? null,
          catch: () =>
            new GoalControlSchema.Error({
              code: "recovery_required",
              message: "Goal plan source is conflicting or unavailable",
            }),
        })
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
        if (!plan) return yield* new InvalidGoalError({ reason: "Goal requires a plan or objective" })
        const initialization = yield* GoalTickProjection.prepare(db, {
          directory: goalStoreRoot(sessionID),
          sessionID,
          requestID: input.requestID,
          plan,
          spec: {
            criteria: input.criteria ?? (fromFile?.criteria.length ? fromFile.criteria : DEFAULT_CRITERIA),
            limits: { ...DEFAULT_LIMITS, ...input.limits },
            stallThreshold: input.stallThreshold ?? 3,
          },
          model: yield* resolveGoalModel(session),
          netTokenBudget: flags.goalNetTokenBudget,
          panel: input.panelQuestion ?? {
            question: "Is the current change safe and correct enough to complete this goal?",
            codeRefs: [],
            lenses: ["correctness", "security", "architecture"],
            maxRounds: 3,
          },
        })
        const planDocId = initialization.spec.planDocId
        const prepared = yield* GoalControl.reserveStart(db, {
          sessionID,
          requestID: input.requestID,
          requestHash,
          planDocId,
          driverMode: "event",
          initialization,
        })
        const receipt = yield* initializePrepared(prepared.row, input.requestID, requestHash)
        // These projections are advisory. Their failure cannot erase the committed command receipt.
        yield* Effect.gen(function* () {
          AgentGateway.DeepAgentSessionState.setActiveGoal(sessionID, {
            goalId: receipt.goalId,
            planDocId,
            phase: "running",
            startedAt: new Date().toISOString(),
          })
          yield* setControl(sessionID, {
            goalId: receipt.goalId,
            planDocId,
            jobId: "",
            paused: false,
            stopped: false,
            ledger: { ticks: 0, tokens: 0, cost: 0, wallclockMs: 0 },
            stallCount: 0,
            gaps: [],
          })
          yield* publishGoalEvent(sessionID, {
            goalId: receipt.goalId,
            planDocId,
            phase: receipt.phase,
            ledger: { ticks: 0, tokens: 0, cost: 0, wallclockMs: 0 },
            stallCount: 0,
            gaps: [],
          })
        }).pipe(Effect.catchCause(() => Effect.void))
        yield* GoalControlDispatcher.drain(db, eventBus).pipe(Effect.catchCause(() => Effect.void))
        return receipt
      }).pipe(
        (effect) =>
          GoalControl.session(db, input.sessionID).pipe(
            Effect.flatMap(() => GoalControl.requireOrdinary(db, input.sessionID)),
            Effect.flatMap(() =>
              flock.withLock(effect, `goal-start-${Hash.sha256(input.sessionID)}`, goalStoreRoot(input.sessionID)),
            ),
          ),
        Effect.catchTag(["LockCompromisedError", "LockTimeoutError"], () =>
          Effect.fail(new GoalControlSchema.Error({ code: "unavailable", message: "Goal start lock is unavailable" })),
        ),
      )

    const applyControl = (action: GoalControlSchema.Action, input: GoalControlSchema.ControlInput) =>
      Effect.gen(function* () {
        const receipt = yield* GoalControl.control(db, { ...input, action })
        // The SQL control lock has been released. Revoke and interrupt only captured old frames.
        if (Option.isSome(ownedFrames)) yield* ownedFrames.value.control(input.goalId, receipt.revision)
        yield* Effect.gen(function* () {
          const row = yield* GoalControl.current(db, input.sessionID)
          if (row?.goal_id !== input.goalId) return
          AgentGateway.DeepAgentSessionState.setActiveGoalPhase(input.sessionID, row.requested_phase)
          yield* mutateControl(input.sessionID, (control) => {
            control.paused = row.requested_phase === "paused"
            control.stopped = row.requested_phase === "stopped"
          })
        }).pipe(Effect.catchCause(() => Effect.void))
        if (action === "resume")
          yield* GoalControlDispatcher.drain(db, eventBus).pipe(Effect.catchCause(() => Effect.void))
        // inFlight remains explicit. This slice does not claim that a remote/cold child was interrupted.
        return receipt
      })
    const pause: Interface["pause"] = (input) => applyControl("pause", input)
    const resume: Interface["resume"] = (input) => applyControl("resume", input)
    const stop: Interface["stop"] = (input) => applyControl("stop", input)
    const status: Interface["status"] = (sessionID) =>
      Effect.gen(function* () {
        const row = yield* GoalControl.current(db, sessionID)
        if (row) return yield* GoalControl.snapshot(db, row)
        const legacy = AgentGateway.DeepAgentSessionState.getActiveGoal(sessionID)
        if (!legacy) return null
        return {
          goalId: legacy.goalId,
          planDocId: legacy.planDocId,
          phase: legacy.phase,
          running: false,
          revision: 0,
          requestedPhase: legacy.phase,
          preparation: "recovery_required" as const,
          inFlight: false,
          recoveryRequired: true,
          wakeState: "none" as const,
          replayed: false,
        }
      })

    // Whether start() would find a plan to run — mirrors its plan-resolution precedence WITHOUT side
    // effects (no doc materialized, no driver started). Flag-gated: a disabled goal loop is never
    // startable. session_plan (loop-tool authored) wins; else the repo goal+plan.md (loop/design file);
    // else none. Used by the client to gate the convert-to-goal affordance in the modes where it applies.
    const startable: Interface["startable"] = (sessionID) =>
      Effect.gen(function* () {
        if (!flags.experimentalGoalLoop || !(flags.v4MultiAgentRuntime || flags.v4GoalTickEventDriven))
          return { startable: false, source: "none" as const }
        const existing = yield* Effect.try({
          try: () => GoalTickProjection.readPlan(goalStoreRoot(sessionID), sessionID),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null))
        if (existing != null) return { startable: true, source: "plan" as const }
        const session = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.orDie)
        const cwd = session.directory ?? process.cwd()
        const fromFile = readGoalPlanFile(cwd, sessionID)
        if (fromFile?.plan != null) return { startable: true, source: "file" as const }
        return { startable: false, source: "none" as const }
      })

    const editPlan: Interface["editPlan"] = (input) =>
      Effect.gen(function* () {
        const current = yield* GoalControl.current(db, input.sessionID).pipe(Effect.orDie)
        if (current?.initialization.executionContract === "owned-goal-v2")
          return yield* Effect.fail(
            new GoalPlanEditUnavailableError(
              "Owned Goals use the authenticated plan-rebase begin/apply protocol with exact control, plan and document revisions. The legacy edit-plan mailbox cannot edit their plan.",
            ),
          )
        const c = yield* getControl(input.sessionID)
        if (!c || c.stopped) return yield* Effect.fail(new PlanEditTargetUnavailableError("no live goal driver"))
        const ptr = AgentGateway.DeepAgentSessionState.getActiveGoal(input.sessionID)
        if (!ptr || ptr.goalId !== c.goalId || ptr.planDocId !== c.planDocId || isTerminalGoalPhase(ptr.phase)) {
          return yield* Effect.fail(
            new PlanEditTargetUnavailableError("active goal pointer does not match a live goal"),
          )
        }
        const store = DocumentStore.shared(goalStoreRoot(input.sessionID))
        const command = createPlanEditCommand({
          requestID: input.requestID,
          sessionID: input.sessionID,
          goalID: c.goalId,
          planWrite: input.planWrite,
          confirmedChallengeID: input.qualityChallengeID,
        })
        const prior = yield* planEditAdmission(() =>
          readPlanEditReceiptByRequest(store, input.sessionID, c.goalId, input.requestID),
        )
        if (prior) {
          if (prior.command.candidate_hash !== command.candidate_hash) {
            return yield* Effect.fail(new PlanEditRequestConflictError(input.requestID))
          }
          return prior
        }
        const existing = store.get(c.planDocId)
        if (!existing)
          return yield* Effect.fail(new PlanEditTargetUnavailableError("authoritative plan document not found"))
        const previous = decodePlanDoc(existing.body)
        if (!previous) return yield* Effect.fail(new PlanEditTargetUnavailableError("authoritative plan is malformed"))
        const validated = yield* planEditAdmission(() =>
          buildPlanFromWriteInput(input.sessionID, input.planWrite, previous, {
            plan_id: previous.plan_id,
            doc_id: existing.id,
            version: existing.version,
          }),
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: () => ({ ok: true as const }),
          }),
        )
        if (validated.ok) {
          return yield* planEditAdmission(() => admitPlanEditCommand(store, command))
        }
        if (
          !(validated.error instanceof PlanValidationError) ||
          validated.error.code !== "suspicious_quality_regression"
        ) {
          return yield* Effect.fail(validated.error)
        }
        const qualityError = validated.error
        const receipt = yield* input.qualityChallengeID
          ? planEditAdmission(() => {
              buildPlanFromWriteInput(
                input.sessionID,
                input.planWrite,
                previous,
                { plan_id: previous.plan_id, doc_id: existing.id, version: existing.version },
                { allowQualityRegression: true },
              )
              return admitPlanEditCommand(store, command)
            })
          : planEditAdmission(() => issuePlanEditChallenge(store, command, qualityError.challenge_id ?? randomUUID()))

        writeGovernanceAudit(input.sessionID, c.goalId, "plan_edit", {
          activityId: receipt.command.activity_id,
          requestId: receipt.command.request_id,
          candidateHash: receipt.command.candidate_hash,
          state: receipt.state,
          stepCount: input.planWrite.steps.length,
          goalChars: input.planWrite.goal.length,
        })
        glog.info("goal plan hot-edit admitted", {
          sessionID: input.sessionID,
          goalId: c.goalId,
          activityId: receipt.command.activity_id,
          state: receipt.state,
          stepCount: input.planWrite.steps.length,
        })
        return receipt
      })

    return Service.of({ start, pause, resume, stop, status, startable, editPlan })
  }),
)

const planEditAdmission = <A>(operation: () => A): Effect.Effect<A, GoalPlanEditAdmissionError> =>
  Effect.try({
    try: operation,
    catch: (error) => {
      if (
        error instanceof PlanValidationError ||
        error instanceof PlanConflictError ||
        error instanceof PlanEditBusyError ||
        error instanceof PlanEditChallengeError ||
        error instanceof PlanEditMailboxConflictError ||
        error instanceof PlanEditProtocolCorruptionError ||
        error instanceof PlanEditRequestConflictError ||
        error instanceof PlanEditTargetUnavailableError
      ) {
        return error
      }
      return new GoalPlanEditUnavailableError(error instanceof Error ? error.message : "unknown persistence failure")
    },
  })

export const productionLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(SessionSteer.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(BackgroundJob.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(DeepAgentEventBus.defaultLayer),
    Layer.provide(ApprovalQueue.defaultLayer),
  ),
)

/** Standalone default. Production roots must provide one shared SessionV2 runtime to productionLayer. */
export const testLayer = productionLayer.pipe(Layer.provide(SessionV2.liveLayer))

export * as GoalManager from "./goal-manager"
