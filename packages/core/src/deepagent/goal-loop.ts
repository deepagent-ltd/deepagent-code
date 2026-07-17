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

// §D.7 关键决策点召集 panel，非每轮: the two gates that SPAWN subagents (a reviewer turn, a whole panel
// fan-out) are expensive; the rest are cheap local checks. Ordering criteria cheap-first and skipping
// the expensive ones once a cheaper gate has already failed means the panel/reviewer run ONLY at the
// key decision point — when everything cheap already passes — instead of on every tick. Lower rank =
// evaluated earlier.
const CRITERION_COST_RANK: Record<CompletionCriterion["kind"], number> = {
  plan_complete: 0,
  no_diagnostics: 1,
  tests_pass: 2,
  reviewer_clean: 3, // spawns a reviewer subagent turn
  panel_approves: 4, // spawns a full Expert Panel fan-out
}
const isExpensiveCriterion = (kind: CompletionCriterion["kind"]): boolean =>
  kind === "reviewer_clean" || kind === "panel_approves"

/**
 * §D.3 Grader.evaluate — ALL criteria must be met (AND). `gaps` lists every unmet criterion. Pure with
 * respect to its ports: same ports + same plan → same result.
 *
 * With `{ deferExpensive: true }` (the Controller default) the criteria are evaluated cheap-first and
 * the SUBAGENT-SPAWNING gates (reviewer_clean, panel_approves) are SKIPPED once any cheaper criterion is
 * already unmet — the goal cannot be `met` this tick regardless, so spending a panel/reviewer turn to
 * enumerate a gap we will not act on is pure waste (§D.7 非每轮). This never changes the met/unmet
 * verdict (a cheap gap already forces met=false); it only avoids convening the panel except at the key
 * decision point when everything cheaper passes. Direct callers (tests) default to the full evaluation.
 */
export const evaluateCriteria = (
  criteria: readonly CompletionCriterion[],
  ports: GraderPorts,
  plan: PlanDoc | null,
  options: { readonly deferExpensive?: boolean } = {},
): Effect.Effect<GraderResult> =>
  Effect.gen(function* () {
    const deferExpensive = options.deferExpensive ?? false
    const ordered = deferExpensive
      ? [...criteria].sort((a, b) => CRITERION_COST_RANK[a.kind] - CRITERION_COST_RANK[b.kind])
      : criteria
    const gaps: string[] = []
    for (const c of ordered) {
      // Defer the expensive, subagent-spawning gates until every cheaper criterion has passed.
      if (deferExpensive && gaps.length > 0 && isExpensiveCriterion(c.kind)) {
        gaps.push(`${c.kind}: deferred — a cheaper criterion is unmet (panel/reviewer not convened this tick)`)
        continue
      }
      const gap = yield* evaluateOne(c, ports, plan)
      if (gap != null) gaps.push(gap)
    }
    return { met: gaps.length === 0, gaps }
  })

// The Controller's view of grading: the spec GraderResult PLUS whether a gate ACTIVELY rejected (as
// opposed to merely being unmet). A panel `block` / `needs_human` verdict is an active rejection — the
// panel is telling us to stop and get a human, not "try again" — so the loop escalates on the FIRST
// such verdict rather than re-convening the panel every tick until the stall threshold. `revise` stays
// a soft gap (keep iterating). This extended shape is internal to the loop; the persisted/spec
// GraderResult remains exactly { met, gaps }.
export type GraderDecision = {
  readonly result: GraderResult
  readonly escalate: boolean
  readonly escalateReason: string | null
}

// Evaluate for the Controller: same AND-gate + cheap-first deferral as evaluateCriteria, but also flags
// an active panel rejection for immediate escalation. Only `panel_approves` can escalate (the panel is
// the human-in-the-loop decision point, §D.7); a `revise` verdict is a soft gap.
export const evaluateForController = (
  criteria: readonly CompletionCriterion[],
  ports: GraderPorts,
  plan: PlanDoc | null,
): Effect.Effect<GraderDecision> =>
  Effect.gen(function* () {
    const ordered = [...criteria].sort((a, b) => CRITERION_COST_RANK[a.kind] - CRITERION_COST_RANK[b.kind])
    const gaps: string[] = []
    let escalate = false
    let escalateReason: string | null = null
    for (const c of ordered) {
      if (gaps.length > 0 && isExpensiveCriterion(c.kind)) {
        gaps.push(`${c.kind}: deferred — a cheaper criterion is unmet (panel/reviewer not convened this tick)`)
        continue
      }
      if (c.kind === "panel_approves") {
        const { decision } = yield* ports.panelApproves()
        if (decision === "approve") continue
        gaps.push(`panel_approves: panel decision was ${decision}, not approve`)
        // block / needs_human = active rejection → escalate; revise = soft (keep iterating).
        if (decision === "block" || decision === "needs_human") {
          escalate = true
          escalateReason = `panel returned ${decision}`
        }
        continue
      }
      const gap = yield* evaluateOne(c, ports, plan)
      if (gap != null) gaps.push(gap)
    }
    return { result: { met: gaps.length === 0, gaps }, escalate, escalateReason }
  })

export const Grader = { evaluate: evaluateCriteria, evaluateForController }

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
  readonly lastDoneCount: number
  readonly lastEvidenceCount: number
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

// The count of steps that have reached a resolved (done) state. Forward progress is measured as this
// count INCREASING — a status regression (done→active) or a flap (active↔pending) is NOT progress, so
// a thrashing worker cannot evade the stall guard by merely churning statuses (which would bump the raw
// fingerprint). Combined with the fingerprint, "progress" = fingerprint changed in the FORWARD direction.
const doneStepCount = (plan: PlanDoc | null): number =>
  plan == null ? 0 : plan.steps.filter((s) => s.status === "done").length

// Total evidence entries accumulated across all plan steps. Evidence is runtime-supplied ground truth
// (a command run, a test that passed — attached by the plan tool, never the model's prose), so a
// GROWING evidence count is honest forward progress even when NO step has flipped to `done` yet. This
// is what prevents a stall FALSE-POSITIVE on a legitimately hard step that spans several ticks (a big
// refactor): each tick that records new evidence counts as progress. Because evidence is ground-truth
// (not a status the worker can flip at will), it cannot be gamed the way a raw status flap could.
const evidenceCount = (plan: PlanDoc | null): number =>
  plan == null ? 0 : plan.steps.reduce((n, s) => n + (s.evidence?.length ?? 0), 0)

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
      const parsed = JSON.parse(doc.body) as GoalRuntimeState
      // Backfill fields added after a goal may have been persisted (restart-across-upgrade safety):
      // a state written before lastEvidenceCount existed reads as undefined; default it to 0 so the
      // first post-upgrade tick treats any existing evidence as the baseline (never a spurious stall
      // reset, never a crash on the arithmetic comparison).
      return { ...parsed, lastEvidenceCount: parsed.lastEvidenceCount ?? 0 }
    } catch {
      return null
    }
  }
  return null
}

// V4.1 §N — durable command cursor. Weight ticks by one more than the maximum continuing stall count so
// resetting stallCount after progress cannot repeat or decrease the cursor. A replay advances stallCount;
// an executed tick advances ledger.ticks; every continuing transition therefore produces a fresh key.
export const readGoalTickCursor = (
  store: DocumentStore,
  sessionId: string,
  goalId: string,
): { readonly seq: number; readonly planVersion: number; readonly phase: GoalPhase } | null => {
  for (const ref of store.list({ type: "run_context", scope: planScope(sessionId) })) {
    const doc = store.get(ref.id)
    if (!doc) continue
    if (doc.extensions?.goal_id !== goalId) continue
    try {
      const state = JSON.parse(doc.body) as GoalRuntimeState
      const stallThreshold =
        state.spec?.stallThreshold && state.spec.stallThreshold > 0 ? state.spec.stallThreshold : 3
      const seq = (state.ledger?.ticks ?? 0) * (stallThreshold + 1) + (state.stallCount ?? 0)
      const planVersion = readPlan(store, state.planDocId).version
      return { seq, planVersion, phase: state.phase }
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

// Post-execution breach: did THIS tick's own spend push the ledger PAST a cap? Uses strict `>` because
// the ledger here already includes the just-finished tick — a run configured for maxTicks=N is allowed
// to COMPLETE its Nth tick (ticks==N is fine), and only tick N+1 would be over. The pre-execution gate
// (atOrOverLimit) prevents that N+1 tick from ever executing.
// §D.3 可观测: on a `done` outcome write a completion_report doc summarizing the finished goal (reusing
// U9's buildCompletionReport for the plan-side summary). Idempotent via idSlug; best-effort.
const writeCompletionReport = (deps: ControllerDeps, state: GoalRuntimeState, plan: PlanDoc | null): void => {
  const report = plan ? buildCompletionReport(plan) : null
  // Reuses the existing `decision` DocType (a terminal, non-knowledge audit record — no confidence
  // required) rather than expanding the core DocType union; the `report_kind: "completion"` extension
  // marks it as the goal completion report so a projector can surface it distinctly.
  deps.store.upsert({
    type: "decision",
    scope: planScope(state.sessionId),
    description: `goal ${state.goalId} completion report`,
    idSlug: `goal-completion-${state.goalId}`,
    body: JSON.stringify(
      {
        goalId: state.goalId,
        planDocId: state.planDocId,
        ticks: state.ledger.ticks,
        ledger: state.ledger,
        criteriaMet: true,
        plan: report,
      },
      null,
      2,
    ),
    provenance: { source: "runner", run_ref: planScope(state.sessionId) },
    extensions: { goal_id: state.goalId, tick: state.ledger.ticks, outcome: "done", report_kind: "completion" },
  })
}

const overLimit = (ledger: BudgetLedger, limits: GoalLimits): string | null => {
  if (ledger.ticks > limits.maxTicks) return `maxTicks (${limits.maxTicks}) exceeded`
  if (ledger.tokens > limits.maxTokens) return `maxTokens (${limits.maxTokens}) exceeded`
  if (ledger.wallclockMs > limits.maxWallclockMs) return `maxWallclockMs (${limits.maxWallclockMs}) exceeded`
  if (limits.maxCost != null && ledger.cost > limits.maxCost) return `maxCost (${limits.maxCost}) exceeded`
  return null
}

// Pre-execution ceiling: has the ledger ALREADY reached a cap, such that running one more step turn
// would exceed it? Uses `>=` on ticks (already ran maxTicks turns → do not run another) and on the
// resource caps (already at/over budget → do not spend more). This is the guard that makes the limit a
// TRUE ceiling: it runs BEFORE the executor, so no unbounded turn is spent past the declared maximum.
const atOrOverLimit = (ledger: BudgetLedger, limits: GoalLimits): string | null => {
  if (ledger.ticks >= limits.maxTicks) return `maxTicks (${limits.maxTicks}) reached`
  if (ledger.tokens >= limits.maxTokens) return `maxTokens (${limits.maxTokens}) reached`
  if (ledger.wallclockMs >= limits.maxWallclockMs) return `maxWallclockMs (${limits.maxWallclockMs}) reached`
  if (limits.maxCost != null && ledger.cost >= limits.maxCost) return `maxCost (${limits.maxCost}) reached`
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
  // A tests_pass criterion with no commands is not objectively decidable (nothing to run) — reject it
  // at start rather than let it pass/fail vacuously at grade time.
  for (const c of spec.criteria) {
    if (c.kind === "tests_pass" && c.commands.length === 0)
      return "tests_pass criterion must list at least one command — an empty command set is not decidable"
  }
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
        lastDoneCount: doneStepCount(initial.plan),
        lastEvidenceCount: evidenceCount(initial.plan),
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

      // 有界性 (pre-execution ceiling): if a HARD limit is ALREADY reached, STOP before running the
      // executor — never spend one more (unbounded) step turn past the cap. This makes the limit a true
      // ceiling at tick granularity: a single tick maps to at most one agent turn, and no turn runs once
      // the budget is exhausted. (The post-execution check below still catches a limit crossed BY this
      // tick's own spend.) Persist the terminal state so a re-tick replays rather than re-checks.
      const preBreach = atOrOverLimit(state.ledger, state.spec.limits)
      if (preBreach != null) {
        state = { ...state, phase: "needs_human", lastOutcome: "needs_human", gaps: [preBreach, ...state.gaps] }
        persistState(deps, state)
        return "needs_human"
      }

      const { plan, version } = readPlan(deps.store, state.planDocId)

      // 幂等: dedup on the ENTRY plan version. A repeated tick that finds the plan STILL at the version
      // we last processed replays the last outcome with NO side effects (no double execute / double
      // budget). This makes a NO-PROGRESS replay idempotent. IMPORTANT (honesty about the guarantee): a
      // tick that DID advance the plan (bumped the version) and then crashes BEFORE persistState is NOT
      // covered — the re-tick sees the new version and executes again. Full crash-mid-tick idempotency
      // requires an idempotencyKey checkpoint, reserved for the V4.0 `goal.tick` event; within V3.9 the
      // dedup guarantees "a repeated no-progress tick has no side effects", not "every tick is exactly-
      // once under a mid-tick crash". The driver must therefore treat tick as at-least-once.
      if (state.lastProcessedVersion === version && state.lastOutcome != null) {
        return state.lastOutcome
      }

      // 不越权: execute the active step via the injected executor (normal perms; Loop never elevates).
      // A DEFECT in the injected executor (it lives on `never`, but a wired port could still die) must
      // not escape tick's never-fail contract — degrade a defect to a critical result so the loop rolls
      // back rather than crashing the driver.
      const execResult = yield* deps
        .executor({
          goalId: state.goalId,
          sessionId: state.sessionId,
          planDocId: state.planDocId,
          activeStepId: plan?.active_step_id ?? null,
        })
        .pipe(Effect.catchCause(() => Effect.succeed({ tokensUsed: 0, critical: true } as StepExecutorResult)))

      // Re-read the plan AFTER execution (the executor may have advanced steps / bumped the version).
      const after = readPlan(deps.store, state.planDocId)
      // Controller grading: cheap-first + defer the subagent-spawning gates (§D.7 非每轮), and surface an
      // active panel rejection (block/needs_human) for immediate escalation.
      const decision = yield* evaluateForController(state.spec.criteria, deps.ports, after.plan)
      const grader = decision.result

      // Budget Ledger accumulation (injected clock for wallclock → deterministic + restart-exact).
      // Guard BOTH tokens and cost against a non-finite port result: `Math.max(0, Math.trunc(NaN))`
      // is NaN, which would poison the ledger permanently and silently disable the token cap forever
      // (`NaN > maxTokens` is always false). Coerce a non-finite / negative token count to 0.
      const addTokens = Number.isFinite(execResult.tokensUsed) ? Math.max(0, Math.trunc(execResult.tokensUsed)) : 0
      const ledger: BudgetLedger = {
        ticks: state.ledger.ticks + 1,
        tokens: state.ledger.tokens + addTokens,
        cost: state.ledger.cost + (Number.isFinite(execResult.cost) ? (execResult.cost as number) : 0),
        wallclockMs: Math.max(0, deps.now() - state.ledger.startedAtMs),
        startedAtMs: state.ledger.startedAtMs,
      }

      // Progress = FORWARD movement only, by any of three ground-truth signals since last tick:
      //   (a) more steps resolved to `done`, (b) new EVIDENCE recorded on the plan (a command run / test
      //   passed — honest incremental progress on a hard multi-tick step that hasn't finished yet), or
      //   (c) a new completion criterion became met. A status regression / flap changes the raw
      //   fingerprint but is NOT progress (so a thrashing worker can't evade the stall guard), while a
      //   legitimately hard step that spans several ticks is NOT falsely stalled as long as it keeps
      //   producing evidence. (The fingerprint is kept in state for observability only.)
      const fingerprint = planFingerprint(after.plan)
      const doneCount = doneStepCount(after.plan)
      const evidence = evidenceCount(after.plan)
      const metCount = state.spec.criteria.length - grader.gaps.length
      const madeProgress =
        doneCount > state.lastDoneCount || evidence > state.lastEvidenceCount || metCount > state.lastMetCount
      const stallCount = madeProgress ? 0 : state.stallCount + 1

      // §D.3 step 6 — stop decision, in safety precedence order:
      //   critical → done → panel-rejection escalation → limit → stall → continue.
      // The panel-rejection escalation sits just below `done` (an approve can't co-occur with a block)
      // and above limit/stall: when the panel actively says block/needs_human, get a human on the FIRST
      // such verdict instead of re-convening the panel each tick until the stall threshold.
      let outcome: TickOutcome
      const limitBreach = overLimit(ledger, state.spec.limits)
      if (execResult.critical === true) {
        outcome = "rolled_back"
      } else if (grader.met) {
        outcome = "done"
      } else if (decision.escalate) {
        outcome = "needs_human"
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
        lastDoneCount: doneCount,
        lastEvidenceCount: evidence,
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

      // §D.3 step 6 — on `done`, emit a completion_report doc (reuse U9 buildCompletionReport) so a
      // completed goal leaves an auditable summary in the Document Graph, not just a worklog.
      if (outcome === "done") {
        writeCompletionReport(deps, state, after.plan)
      }

      if (outcome === "rolled_back") {
        writeDiagnosis(
          deps,
          state,
          `critical failure at tick ${ledger.ticks}; rolling back. gaps: ${grader.gaps.join("; ") || "none"}`,
        )
        // A DEFECT in the injected rollback port must not escape tick's never-fail contract — the audit
        // trail above is already durable, so swallow a rollback defect (best-effort / never fatal).
        yield* deps
          .rollback({
            goalId: state.goalId,
            sessionId: state.sessionId,
            reason: `critical failure at tick ${ledger.ticks}`,
          })
          .pipe(Effect.catchCause(() => Effect.void))
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
