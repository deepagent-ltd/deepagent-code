import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import type { DocumentStore } from "./document-store"
import {
  type PlanDoc,
  buildCompletionReport,
  planScope,
} from "./plan-controller"

// V3.9 §D — Goal Loop（自主长跑原语）. A supervised, cross-tick control loop: given an OBJECTIVELY
// decidable completion criterion, the loop drives 计划→执行→验证→迭代 until the criteria are met or a
// HARD stop limit is hit. This is NOT a new execution paradigm — it strings existing assets (plan doc
// = criterion carrier, evidence-gate/reviewer/Panel = Grader, existing session loop / BackgroundJob =
// tick driver, existing isolation/rollback = failsafe) into one bounded, recoverable, observable
// control loop.
//
// LAYERING (§A/§B/§C constraint): this file lives in `core` and CANNOT import LSP / panel / reviewer /
// task-tool (all deepagent-code). Therefore the Grader takes INJECTED evaluator PORTS — production
// wires them to the real validation runner / LSP diagnostics / reviewer subagent / Panel; tests wire
// deterministic stubs. The Controller likewise NEVER executes tools itself and NEVER elevates
// permissions (§D.6 不越权): step execution is an injected `StepExecutor` port that runs through the
// normal session/tool permission path in the driver.
//
// §D.6 invariants enforced here (each has a §G-D test):
//   判据客观性  : start rejects a goal with NO criteria (no objective judge) — InvalidGoalError.
//   有界性      : start rejects a goal missing any of maxTicks/maxTokens/maxWallclockMs.
//   不越权      : tick delegates execution to the injected StepExecutor (normal perms); Loop never
//                 executes tools or elevates permission.
//   无进展即停  : stallThreshold consecutive no-progress ticks → needs_human (never infinite retry).
//   可恢复      : ALL loop state (Budget Ledger + stall + last processed plan version + fingerprint)
//                 persists to a run_context doc (scope run:<sessionId>); a fresh Controller over the
//                 same store recovers and resumes.
//   幂等        : tick dedups on the plan doc VERSION at entry — a repeated tick at the same version
//                 replays the recorded outcome with NO side effects (no double execute / double
//                 budget). (An `idempotencyKey` concept is reserved for the V4.0 `goal.tick` event.)
//   可观测      : every tick writes a worklog doc (tick #, outcome, grader result, ledger) and a
//                 critical failure writes a diagnosis doc, into the Document Graph.
//   可接管/回滚 : stop() flips the goal to a terminal `stopped` at any time; a critical executor
//                 failure invokes the injected rollback port → rolled_back.

// ---------------------------------------------------------------------------------------------------
// §D.2 core schema — MUST match the spec exactly.
// ---------------------------------------------------------------------------------------------------

// 完成判据: an OBJECTIVELY verifiable expression referencing tests / diagnostics / reviewer / Panel /
// plan results. Subjective criteria are never accepted — every kind maps to a decidable port or the
// pure plan-completion report.
export const CompletionCriterion = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("tests_pass"), commands: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("no_diagnostics"), severityAtMost: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("reviewer_clean"), maxSeverity: Schema.String }), // 无 high+ 发现
  Schema.Struct({ kind: Schema.Literal("panel_approves") }), // Expert Panel verdict=approve
  Schema.Struct({ kind: Schema.Literal("plan_complete") }), // 所有 plan step 已解决（复用 U9）
]).annotate({ identifier: "CompletionCriterion" })
export type CompletionCriterion = Schema.Schema.Type<typeof CompletionCriterion>

export const GoalLimits = Schema.Struct({
  maxTicks: Schema.Int,
  maxTokens: Schema.Int,
  maxWallclockMs: Schema.Int,
  maxCost: Schema.optional(Schema.Number),
}).annotate({ identifier: "GoalLimits" })
export type GoalLimits = Schema.Schema.Type<typeof GoalLimits>

export const GoalSpec = Schema.Struct({
  planDocId: Schema.String, // 复用 plan DocType 作为 Goal 载体
  criteria: Schema.Array(CompletionCriterion), // 全部满足才算完成（AND）
  limits: GoalLimits, // 硬上限：缺失则拒绝启动
  stallThreshold: Schema.Int, // 连续 K 轮无进展 → 停并升级人类
}).annotate({ identifier: "GoalSpec" })
export type GoalSpec = Schema.Schema.Type<typeof GoalSpec>

export const GraderResult = Schema.Struct({
  met: Schema.Boolean,
  gaps: Schema.Array(Schema.String), // 未满足的判据 + 差距描述
}).annotate({ identifier: "GraderResult" })
export type GraderResult = Schema.Schema.Type<typeof GraderResult>

export const TickOutcome = Schema.Literals(["continue", "done", "needs_human", "rolled_back"])
export type TickOutcome = Schema.Schema.Type<typeof TickOutcome>

// A stable reference to a started goal. `sessionId` scopes every persisted doc; `goalId` disambiguates
// multiple goals in one session.
export const GoalHandle = Schema.Struct({
  goalId: Schema.String,
  planDocId: Schema.String,
  sessionId: Schema.String,
}).annotate({ identifier: "GoalHandle" })
export type GoalHandle = Schema.Schema.Type<typeof GoalHandle>

// The observable Budget Ledger — per-goal accumulation, persisted so a restart recovers it.
export const BudgetLedger = Schema.Struct({
  ticks: Schema.Int,
  tokens: Schema.Int,
  cost: Schema.Number,
  wallclockMs: Schema.Int,
  startedAtMs: Schema.Int,
}).annotate({ identifier: "BudgetLedger" })
export type BudgetLedger = Schema.Schema.Type<typeof BudgetLedger>

export const GoalPhase = Schema.Literals(["running", "done", "needs_human", "rolled_back", "stopped"])
export type GoalPhase = Schema.Schema.Type<typeof GoalPhase>

export const GoalStatus = Schema.Struct({
  goalId: Schema.String,
  planDocId: Schema.String,
  sessionId: Schema.String,
  phase: GoalPhase,
  ledger: BudgetLedger,
  stallCount: Schema.Int,
  lastOutcome: Schema.NullOr(TickOutcome),
  gaps: Schema.Array(Schema.String),
}).annotate({ identifier: "GoalStatus" })
export type GoalStatus = Schema.Schema.Type<typeof GoalStatus>

// §D.4 — rejected at start when the goal is not objectively decidable / not bounded.
export class InvalidGoalError extends Schema.TaggedErrorClass<InvalidGoalError>()("GoalLoop.InvalidGoalError", {
  reason: Schema.String,
}) {}

// ---------------------------------------------------------------------------------------------------
// §D.3 Grader — maps each CompletionCriterion to an INJECTED, deterministic evaluator port. Does NOT
// invent a scoring model. `plan_complete` is evaluated PURELY in-core via buildCompletionReport.
// ---------------------------------------------------------------------------------------------------

/**
 * The injected evaluator ports. Production wires these in deepagent-code (tests_pass → the validation
 * command runner, no_diagnostics → LSP diagnostics, reviewer_clean → the reviewer subagent,
 * panel_approves → `runPanel`); tests wire deterministic stubs. All ports live on the `never` error
 * channel — a port must resolve to a concrete result, never fail the loop.
 */
export type GraderPorts = {
  /** Run the given validation commands; `pass` iff ALL succeeded. */
  readonly runTests: (commands: readonly string[]) => Effect.Effect<{ readonly pass: boolean }>
  /** Highest diagnostic severity currently present, or null when there are none. */
  readonly diagnostics: () => Effect.Effect<{ readonly maxSeverity: string | null }>
  /** Reviewer subagent verdict: `pass` iff no finding exceeds `maxSeverity`. */
  readonly reviewerClean: (maxSeverity: string) => Effect.Effect<{ readonly pass: boolean }>
  /** Expert Panel verdict (§D.7 key decision point) — `decision` is approve/revise/block/needs_human. */
  readonly panelApproves: () => Effect.Effect<{ readonly decision: string }>
}

// Severity ordering shared by no_diagnostics (LSP severities) and reviewer (review severities). Higher
// number = more severe. Unknown labels rank as the most severe so an unrecognized diagnostic never
// silently passes a threshold gate.
const SEVERITY_RANK: Record<string, number> = {
  hint: 0,
  note: 0,
  info: 1,
  information: 1,
  low: 1,
  warning: 2,
  warn: 2,
  medium: 2,
  high: 3,
  error: 3,
  critical: 4,
}
const rankSeverity = (s: string): number => SEVERITY_RANK[s.trim().toLowerCase()] ?? 99

// Evaluate ONE criterion. `plan` is supplied for the pure plan_complete branch. Returns a gap string
// when unmet (null when met). Kept small + total: no throws, no clock, no randomness.
const evaluateOne = (
  criterion: CompletionCriterion,
  ports: GraderPorts,
  plan: PlanDoc | null,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    switch (criterion.kind) {
      case "tests_pass": {
        const { pass } = yield* ports.runTests(criterion.commands)
        return pass ? null : `tests_pass: one or more of [${criterion.commands.join(", ")}] failed`
      }
      case "no_diagnostics": {
        const { maxSeverity } = yield* ports.diagnostics()
        if (maxSeverity == null) return null // no diagnostics at all → always met
        // With no severityAtMost, ANY diagnostic is a gap (strict "no diagnostics"). With a bound, a
        // diagnostic is a gap only when it is strictly more severe than the allowed ceiling.
        if (criterion.severityAtMost == null)
          return `no_diagnostics: diagnostics present (highest: ${maxSeverity})`
        return rankSeverity(maxSeverity) <= rankSeverity(criterion.severityAtMost)
          ? null
          : `no_diagnostics: highest severity ${maxSeverity} exceeds allowed ${criterion.severityAtMost}`
      }
      case "reviewer_clean": {
        const { pass } = yield* ports.reviewerClean(criterion.maxSeverity)
        return pass ? null : `reviewer_clean: reviewer reported findings exceeding ${criterion.maxSeverity}`
      }
      case "panel_approves": {
        const { decision } = yield* ports.panelApproves()
        return decision === "approve" ? null : `panel_approves: panel decision was ${decision}, not approve`
      }
      case "plan_complete": {
        if (plan == null) return "plan_complete: plan document not found"
        const report = buildCompletionReport(plan)
        return report.complete
          ? null
          : `plan_complete: outstanding steps [${report.outstanding.join(", ")}]`
      }
    }
  })

/**
 * §D.3 Grader.evaluate — ALL criteria must be met (AND). `gaps` lists every unmet criterion. Pure with
 * respect to its ports: same ports + same plan → same result.
 */
export const evaluateCriteria = (
  criteria: readonly CompletionCriterion[],
  ports: GraderPorts,
  plan: PlanDoc | null,
): Effect.Effect<GraderResult> =>
  Effect.gen(function* () {
    const gaps: string[] = []
    for (const c of criteria) {
      const gap = yield* evaluateOne(c, ports, plan)
      if (gap != null) gaps.push(gap)
    }
    return { met: gaps.length === 0, gaps }
  })

export const Grader = { evaluate: evaluateCriteria }

// ---------------------------------------------------------------------------------------------------
// Controller — the tick state machine. State lives entirely in a run_context doc so a restart recovers.
// ---------------------------------------------------------------------------------------------------

/** Result of executing the active step. Feeds the Budget Ledger; `critical` triggers rollback. */
export type StepExecutorResult = {
  readonly tokensUsed: number
  readonly cost?: number
  /** A critical / unrecoverable failure — the tick rolls back rather than continuing. */
  readonly critical?: boolean
}

/**
 * §D.6 不越权: the injected step executor runs the plan's active step through the NORMAL session/tool
 * permission path (production wires this to SessionPrompt). The Controller never executes tools itself
 * and never elevates permission. Lives on `never` — a failure is reported as `critical`, not thrown.
 */
export type StepExecutor = (input: {
  readonly goalId: string
  readonly sessionId: string
  readonly planDocId: string
  readonly activeStepId: string | null
}) => Effect.Effect<StepExecutorResult>

/** §D.6 可回滚: injected rollback (production wires the existing revert). Best-effort, never fatal. */
export type RollbackPort = (input: {
  readonly goalId: string
  readonly sessionId: string
  readonly reason: string
}) => Effect.Effect<void>

/**
 * All Controller dependencies. `store` is the core DocumentStore (plan + persisted loop state + audit
 * docs). `now` is an INJECTED wallclock so tests are deterministic and restart-recovery is exact — the
 * pure controller never calls Date.now directly.
 */
export type ControllerDeps = {
  readonly store: DocumentStore
  readonly ports: GraderPorts
  readonly executor: StepExecutor
  readonly rollback: RollbackPort
  readonly now: () => number
}

// The full persisted runtime state. Serialized to the run_context state doc body as JSON.
type GoalRuntimeState = {
  readonly goalId: string
  readonly spec: GoalSpec
  readonly planDocId: string
  readonly sessionId: string
  readonly phase: GoalPhase
  readonly ledger: BudgetLedger
  readonly stallCount: number
  readonly lastFingerprint: string | null
  readonly lastMetCount: number
  readonly lastProcessedVersion: number | null
  readonly lastOutcome: TickOutcome | null
  readonly gaps: readonly string[]
}

const stateSlug = (goalId: string): string => `goal-state-${goalId}`

// The plan doc body is the JSON-serialized PlanDoc (the goal carrier). Parse defensively — a malformed
// / absent body yields null so plan_complete reports a gap rather than crashing the loop.
const readPlan = (store: DocumentStore, planDocId: string): { plan: PlanDoc | null; version: number } => {
  const doc = store.get(planDocId)
  if (!doc) return { plan: null, version: 0 }
  try {
    return { plan: JSON.parse(doc.body) as PlanDoc, version: doc.version }
  } catch {
    return { plan: null, version: doc.version }
  }
}

// Step-status fingerprint drives no-progress / stall detection (independent of the doc version used
// for idempotency dedup). A plan whose step statuses are unchanged AND no new criterion met = stall.
const planFingerprint = (plan: PlanDoc | null): string =>
  plan == null ? "∅" : plan.steps.map((s) => `${s.step_id}:${s.status}`).join("|")

const persistState = (deps: ControllerDeps, state: GoalRuntimeState): void => {
  deps.store.upsert({
    type: "run_context",
    scope: planScope(state.sessionId),
    description: `goal loop state ${state.goalId}`,
    idSlug: stateSlug(state.goalId),
    body: JSON.stringify(state, null, 2),
    provenance: { source: "runner", run_ref: planScope(state.sessionId) },
    extensions: {
      goal_id: state.goalId,
      phase: state.phase,
      ticks: state.ledger.ticks,
      tokens: state.ledger.tokens,
      stall_count: state.stallCount,
      last_outcome: state.lastOutcome,
    },
  })
}

const loadState = (deps: ControllerDeps, handle: GoalHandle): GoalRuntimeState | null => {
  // The state doc id is deterministic (idSlug) — but allocateId adds the type/scope prefix, so scan.
  for (const ref of deps.store.list({ type: "run_context", scope: planScope(handle.sessionId) })) {
    const doc = deps.store.get(ref.id)
    if (!doc) continue
    if (doc.extensions?.goal_id !== handle.goalId) continue
    try {
      return JSON.parse(doc.body) as GoalRuntimeState
    } catch {
      return null
    }
  }
  return null
}

// §D.6 可观测: one worklog doc per tick (audit trail into the Document Graph).
const writeWorklog = (deps: ControllerDeps, state: GoalRuntimeState, grader: GraderResult): void => {
  deps.store.upsert({
    type: "worklog",
    scope: planScope(state.sessionId),
    description: `goal ${state.goalId} tick ${state.ledger.ticks}`,
    idSlug: `goal-worklog-${state.goalId}-tick-${state.ledger.ticks}`,
    body: JSON.stringify(
      {
        tick: state.ledger.ticks,
        outcome: state.lastOutcome,
        met: grader.met,
        gaps: grader.gaps,
        ledger: state.ledger,
        stallCount: state.stallCount,
      },
      null,
      2,
    ),
    provenance: { source: "runner", run_ref: planScope(state.sessionId) },
    extensions: { goal_id: state.goalId, tick: state.ledger.ticks, outcome: state.lastOutcome },
  })
}

const writeDiagnosis = (deps: ControllerDeps, state: GoalRuntimeState, detail: string): void => {
  deps.store.upsert({
    type: "diagnosis",
    scope: planScope(state.sessionId),
    description: `goal ${state.goalId} critical failure`,
    idSlug: `goal-diagnosis-${state.goalId}-tick-${state.ledger.ticks}`,
    body: detail,
    provenance: { source: "runner", run_ref: planScope(state.sessionId) },
    extensions: { goal_id: state.goalId, tick: state.ledger.ticks },
  })
}

const overLimit = (ledger: BudgetLedger, limits: GoalLimits): string | null => {
  if (ledger.ticks > limits.maxTicks) return `maxTicks (${limits.maxTicks}) exceeded`
  if (ledger.tokens > limits.maxTokens) return `maxTokens (${limits.maxTokens}) exceeded`
  if (ledger.wallclockMs > limits.maxWallclockMs) return `maxWallclockMs (${limits.maxWallclockMs}) exceeded`
  if (limits.maxCost != null && ledger.cost > limits.maxCost) return `maxCost (${limits.maxCost}) exceeded`
  return null
}

const toStatus = (state: GoalRuntimeState): GoalStatus => ({
  goalId: state.goalId,
  planDocId: state.planDocId,
  sessionId: state.sessionId,
  phase: state.phase,
  ledger: state.ledger,
  stallCount: state.stallCount,
  lastOutcome: state.lastOutcome,
  gaps: state.gaps,
})

const phaseForOutcome = (outcome: TickOutcome): GoalPhase => {
  switch (outcome) {
    case "done":
      return "done"
    case "needs_human":
      return "needs_human"
    case "rolled_back":
      return "rolled_back"
    case "continue":
      return "running"
  }
}

const isTerminalPhase = (phase: GoalPhase): boolean => phase !== "running"

// ---------------------------------------------------------------------------------------------------
// §D.4 service — GoalLoop.
// ---------------------------------------------------------------------------------------------------

export interface GoalLoop {
  readonly start: (spec: GoalSpec) => Effect.Effect<GoalHandle, InvalidGoalError>
  readonly tick: (handle: GoalHandle) => Effect.Effect<TickOutcome>
  readonly status: (handle: GoalHandle) => Effect.Effect<GoalStatus>
  readonly stop: (handle: GoalHandle) => Effect.Effect<void>
}

// §D.4 start validation — HARD, no defaults that bypass. criteria empty → not objectively decidable;
// any missing/non-positive limit → not bounded; non-positive stallThreshold → no stall guard.
const validateSpec = (spec: GoalSpec): string | null => {
  if (spec.criteria.length === 0) return "goal has no completion criteria — not objectively decidable"
  const { maxTicks, maxTokens, maxWallclockMs } = spec.limits
  if (!Number.isFinite(maxTicks) || maxTicks <= 0) return "limits.maxTicks must be a positive integer"
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return "limits.maxTokens must be a positive integer"
  if (!Number.isFinite(maxWallclockMs) || maxWallclockMs <= 0)
    return "limits.maxWallclockMs must be a positive integer"
  if (spec.limits.maxCost != null && (!Number.isFinite(spec.limits.maxCost) || spec.limits.maxCost < 0))
    return "limits.maxCost must be a non-negative number when present"
  if (!Number.isFinite(spec.stallThreshold) || spec.stallThreshold <= 0)
    return "stallThreshold must be a positive integer"
  return null
}

export const makeGoalLoop = (deps: ControllerDeps): GoalLoop => {
  const start: GoalLoop["start"] = (spec) =>
    Effect.gen(function* () {
      const invalid = validateSpec(spec)
      if (invalid != null) return yield* Effect.fail(new InvalidGoalError({ reason: invalid }))

      // sessionId is derived from the plan doc's scope ("run:<sessionId>") so all goal docs co-locate.
      const planDoc = deps.store.get(spec.planDocId)
      const sessionId = planDoc?.scope.startsWith("run:") ? planDoc.scope.slice("run:".length) : spec.planDocId
      const goalId = `goal_${randomUUID()}`
      // Seed the no-progress baseline with the plan's CURRENT step-status fingerprint so the FIRST tick
      // that changes nothing counts as no-progress (stall accrues from tick 1, not from tick 2).
      const initial = readPlan(deps.store, spec.planDocId)
      const state: GoalRuntimeState = {
        goalId,
        spec,
        planDocId: spec.planDocId,
        sessionId,
        phase: "running",
        ledger: { ticks: 0, tokens: 0, cost: 0, wallclockMs: 0, startedAtMs: deps.now() },
        stallCount: 0,
        lastFingerprint: planFingerprint(initial.plan),
        lastMetCount: 0,
        lastProcessedVersion: null,
        lastOutcome: null,
        gaps: [],
      }
      persistState(deps, state)
      return { goalId, planDocId: spec.planDocId, sessionId }
    })

  const tick: GoalLoop["tick"] = (handle) =>
    Effect.gen(function* () {
      const loaded = loadState(deps, handle)
      // A tick against an unknown/unstarted goal is a no-op needs_human (never silently proceeds).
      if (loaded == null) return "needs_human" as TickOutcome
      let state = loaded

      // 可接管: once terminal, replay the recorded terminal outcome. Never re-executes.
      if (isTerminalPhase(state.phase)) return (state.lastOutcome ?? "needs_human") as TickOutcome

      const { plan, version } = readPlan(deps.store, state.planDocId)

      // 幂等: dedup on the ENTRY plan version. A repeated tick that finds the plan STILL at the version
      // we last processed replays the last outcome with NO side effects (no double execute / double
      // budget). A real loop advances the plan during the tick (the executor bumps the version), so the
      // next tick enters at a NEW version and proceeds — only a true no-progress replay is deduped.
      if (state.lastProcessedVersion === version && state.lastOutcome != null) {
        return state.lastOutcome
      }

      // 不越权: execute the active step via the injected executor (normal perms; Loop never elevates).
      const execResult = yield* deps.executor({
        goalId: state.goalId,
        sessionId: state.sessionId,
        planDocId: state.planDocId,
        activeStepId: plan?.active_step_id ?? null,
      })

      // Re-read the plan AFTER execution (the executor may have advanced steps / bumped the version).
      const after = readPlan(deps.store, state.planDocId)
      const grader = yield* evaluateCriteria(state.spec.criteria, deps.ports, after.plan)

      // Budget Ledger accumulation (injected clock for wallclock → deterministic + restart-exact).
      const ledger: BudgetLedger = {
        ticks: state.ledger.ticks + 1,
        tokens: state.ledger.tokens + Math.max(0, Math.trunc(execResult.tokensUsed)),
        cost: state.ledger.cost + (Number.isFinite(execResult.cost) ? (execResult.cost as number) : 0),
        wallclockMs: Math.max(0, deps.now() - state.ledger.startedAtMs),
        startedAtMs: state.ledger.startedAtMs,
      }

      // Progress = step-status fingerprint changed OR a new criterion became met since last tick.
      const fingerprint = planFingerprint(after.plan)
      const metCount = state.spec.criteria.length - grader.gaps.length
      const madeProgress = fingerprint !== state.lastFingerprint || metCount > state.lastMetCount
      const stallCount = madeProgress ? 0 : state.stallCount + 1

      // §D.3 step 6 — stop decision, in safety precedence order.
      let outcome: TickOutcome
      const limitBreach = overLimit(ledger, state.spec.limits)
      if (execResult.critical === true) {
        outcome = "rolled_back"
      } else if (grader.met) {
        outcome = "done"
      } else if (limitBreach != null) {
        outcome = "needs_human"
      } else if (stallCount >= state.spec.stallThreshold) {
        outcome = "needs_human"
      } else {
        outcome = "continue"
      }

      state = {
        ...state,
        phase: phaseForOutcome(outcome),
        ledger,
        stallCount,
        lastFingerprint: fingerprint,
        lastMetCount: metCount,
        // Dedup key = the version we ENTERED this tick at. If a subsequent tick still sees this version
        // (executor made no plan change), it replays; a normal tick advanced it, so it proceeds.
        lastProcessedVersion: version,
        lastOutcome: outcome,
        gaps: grader.gaps,
      }

      // 可观测: persist state + audit BEFORE side-effecting rollback so the trail is durable even if the
      // rollback port itself throws (it is best-effort / never fatal).
      persistState(deps, state)
      writeWorklog(deps, state, grader)

      if (outcome === "rolled_back") {
        writeDiagnosis(
          deps,
          state,
          `critical failure at tick ${ledger.ticks}; rolling back. gaps: ${grader.gaps.join("; ") || "none"}`,
        )
        yield* deps.rollback({
          goalId: state.goalId,
          sessionId: state.sessionId,
          reason: `critical failure at tick ${ledger.ticks}`,
        })
      }

      return outcome
    })

  const status: GoalLoop["status"] = (handle) =>
    Effect.sync(() => {
      const state = loadState(deps, handle)
      if (state != null) return toStatus(state)
      // Unknown goal → a benign, non-running status (never throws).
      return {
        goalId: handle.goalId,
        planDocId: handle.planDocId,
        sessionId: handle.sessionId,
        phase: "needs_human" as GoalPhase,
        ledger: { ticks: 0, tokens: 0, cost: 0, wallclockMs: 0, startedAtMs: 0 },
        stallCount: 0,
        lastOutcome: null,
        gaps: ["goal state not found"],
      }
    })

  const stop: GoalLoop["stop"] = (handle) =>
    Effect.sync(() => {
      const state = loadState(deps, handle)
      if (state == null || isTerminalPhase(state.phase)) return
      persistState(deps, { ...state, phase: "stopped", lastOutcome: state.lastOutcome })
    })

  return { start, tick, status, stop }
}

export * as GoalLoop from "./goal-loop"
