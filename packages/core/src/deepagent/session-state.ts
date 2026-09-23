import { mkdirSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import path from "node:path"
import { writeFileAtomic } from "./atomic-write"
import * as PlanStore from "./plan-store"
import { DocumentStore, documentRevision } from "./document-store"
import type { AgentMode } from "./mode"
import type { OrchestrationTier } from "./orchestration"
import {
  createInitialRoundState,
  advanceRound,
  addCandidate,
  addDiagnosis,
  updateTokenUsage,
  type RoundState,
  type CandidateRef,
  type DiagnosisRef,
  type ValidationResult,
} from "./round-state"
import type { BudgetCheck, BudgetConfig } from "./budget"
import { defaultBudget, check as budgetCheck } from "./budget"
import type { KnowledgeSynthesis } from "./prompt-policy"
import {
  initialPlanLatch,
  markStale,
  clearStale,
  recordGateBlock,
  resetGateBlocks,
  planStatusesChanged,
  planProgressFingerprint,
  buildPlanFromWriteInput,
  PlanValidationError,
  type PlanLatchState,
  type StaleReason,
  type PlanDoc,
} from "./plan-controller"

/**
 * A structured record of a validation failure that the model has explicitly dismissed via the
 * dismiss_validation_failure tool. Replaces the flat `string[]` fingerprint list (v4.0.4) so
 * dismissals carry an audit trail (who dismissed it, why, when) and so command + exitCode are
 * matched by field rather than fragile substring heuristics.
 */
export interface SuppressedValidation {
  /** The shell command that produced the failing result. */
  command: string
  /** The exit code of the failing run (double-confirms the dismissal target). */
  exitCode: number
  /** Composite key: `"${command} ${exitCode}"`. Same scheme as validationFingerprint() per-item. */
  fingerprint: string
  /** Free-text reason supplied by the model (surfaced in audit/logs). */
  reason: string
  /** Unix-ms timestamp of when the dismissal was recorded. */
  suppressedAt: number
}

export type SessionRunState = {
  sessionId: string
  mode: AgentMode
  roundState: RoundState
  budget: BudgetConfig
  validationCommands: string[]
  lastValidationResults: ValidationResult[]
  lastValidationOutput: string | null
  // G2 review fix (round 3): the activity whose provider turns produced lastValidationResults.
  // The finalizer compares against the settling activity — stale evidence from an older
  // activity no longer authorizes delivery. Null = unattributed (legacy callers).
  lastValidationActivityId: string | null
  knowledgeSynthesis: KnowledgeSynthesis | null
  knowledgeSnapshotId: string | null
  userRequest: string | null
  workspacePath: string | null
  runId: string
  // U1 PlanController: the runtime plan latch (fresh/stale + reason + replan count). The structural
  // plan lives in DocumentStore (I33-1, plan-store.ts) as the single authority; only this hot-path
  // value object — the latch, carrying the plan_id pointer — is on session state. The plan body is
  // NOT stored here (getPlan/setPlan delegate to plan-store).
  planLatch: PlanLatchState
  // U10 step-reporting: count of mutating tool calls since the model last CHANGED a plan step's
  // status. Drives the progress-nudge count backstop (nudgeTrigger). Reset to 0 only when setPlan
  // detects a real status change — a no-op plan re-write must not silence the nudge.
  mutationsSinceReport: number
  // U10 hybrid nudge: set true when a validation run went (back) to all-passing since the last plan
  // update. The SEMANTIC primary trigger for the progress nudge ("a step probably just finished").
  // Reset with the counter on a real status change.
  validationPassedSinceReport: boolean
  // Round-context: structured records of validation failures the model has explicitly dismissed
  // (via the dismiss_validation_failure tool). Each entry carries the exact command, exit code,
  // a human-readable reason for audit, and a timestamp. Matching failures are filtered from the
  // round-context injection. Auto-evicted when the same command re-runs with a DIFFERENT exit
  // code (genuine regression), so real regressions are never silently swallowed.
  suppressedValidations: SuppressedValidation[]
  // V3.9 §C: whether this conversation has EXPLICITLY toggled the Expert Panel "armed" state from the
  // chat dialog. `null` = never toggled → the effective armed state falls back to the global
  // `expertPanelDefault` setting (resolved server-side, so the UI reflects the server default without a
  // client round-trip guess). Armed means the user may convene a panel (button press) and — when a goal
  // loop is running — the loop may convene the panel at high-risk decision points (§C activation).
  panelArmed: boolean | null
  // V4.0: the DEBATE DEPTH preference for on-demand convenes from the composer's three-state control
  // (Off / Single-round / Multi-round). Decoupled from `panelArmed` (arm/disarm) on purpose: arming
  // gates WHETHER a panel may convene; this gates HOW MANY rounds a convene runs. `null` = never chosen
  // → defaults to "single". Replaces the former Shift/Alt-click gesture with an explicit, discoverable
  // choice that PERSISTS per session. "multi" requests up to PANEL_MAX_ROUNDS_CEILING debate rounds.
  panelRounds: "single" | "multi" | null
  // V3.9 §D: a lightweight pointer to the goal currently driven for this session (the authoritative
  // loop state lives in the DocumentStore run_context doc — this is only enough to find/resume it and
  // reflect its phase in the UI). Null when no goal is running.
  activeGoal: ActiveGoalPointer | null
  createdAt: string
  completedAt: string | null
  // PR-3: the message ID of the last REAL user admission message observed by
  // buildDeepAgentPromptContext. Used to gate markPlanStale("user_appended") so that synthetic
  // tail-reminder messages (injected by injectTailReminder with a new MessageID.ascending() each
  // call) are never mistaken for genuine new user inputs. undefined = not yet recorded (session
  // created before this field was added; treated as "initial" on first observation).
  lastAdmissionUserMessageId: string | undefined
  // The last soft plan-gate warning claimed by a tool call. A stale latch can span many tool calls;
  // persisting its fingerprint prevents duplicate process-log warnings without touching history.
  lastPlanGateNudgeFingerprint: string | null
  // FEAT-007: the locked active domain pack snapshot id of the LATEST gateway run for this session
  // (`pack_snapshot:<hash>`, or the registry's empty/error sentinels). Recorded by the gateway at the
  // run entry from the SAME activation knowledge retrieval constrains on (single authority, FEAT-002),
  // and read by the session prompt loop to attribute each tool-request receipt's
  // context_active_pack_set_snapshot_id. Null when no gateway run locked a snapshot for the session.
  packSnapshotId: string | null
  // G3 (review fix): the FIRST orchestration complexity estimate for this session, frozen at first
  // computation. The stable system prompt's orchestration section derives from it; recomputing from
  // the latest user request each turn would drift the cached prefix on steer/continue (prompt-cache
  // contract violation). Null until the first decision.
  frozenComplexity: OrchestrationTier | null
  // Capability mode: the last resolution RECORDED for this session (mode + the authority that
  // produced it). Durable so the runner publishes a `session.capability.mode.recorded` fact only
  // when the resolution actually changes, and so a resumed session keeps the mode it was working
  // under instead of silently recomputing a different one from a new request.
  capabilityMode: CapabilityModeResolution | null
  // File-observation ledger: for every file this session has READ or MUTATED, the canonical path ->
  // the version observed then. It exists for the ONE write hazard the read path cannot cover: a
  // blind overwrite (or an overwrite based on a stale read) of a file the session never saw, or saw
  // before someone else changed it. Producers: the `read` tool and the mutating leaves. Consumer:
  // the `write` leaf's staleness check. Bounded by MAX_OBSERVED_FILES (oldest evicted first).
  observedFiles: Record<string, ObservedFileVersion>
}

/**
 * What the session knew about a file at observation time. `mtimeMs` + `size` is the cheap content
 * proxy (the same pair the reference Claude Code gate keys on), not a hash: a false "unchanged" on
 * same-size same-mtime content is a filesystem-resolution question, and a false "stale" costs one
 * re-read — the asymmetry favours the cheap check.
 */
export type ObservedFileVersion = {
  readonly mtimeMs: number
  readonly size: number
}

/** The recorded capability-mode decision (see deepagent/capability-mode.ts). */
export type CapabilityModeResolution = {
  readonly mode: "quick" | "standard" | "deep"
  readonly source: "explicit" | "estimated" | "promoted"
}

// V3.9 §D: session-state pointer to a running goal. The GoalLoop's GoalStatus (persisted in the
// DocumentStore) is the source of truth for ledger/gaps; this pointer just lets the server locate the
// goal, drive its ticks, and lets the UI show a phase without re-reading the store on every render.
export type ActiveGoalPointer = {
  readonly goalId: string
  readonly planDocId: string
  readonly phase: GoalPointerPhase
  readonly startedAt: string
}

// Mirrors goal-loop.ts GoalPhase plus "paused" (a UI/driver-level state that suspends ticking without
// tearing down the loop — the core phase stays "running" and resumes on unpause).
export type GoalPointerPhase = "running" | "paused" | "done" | "needs_human" | "rolled_back" | "stopped"

export type RuntimeState = {
  stateDir: string
  readonly sessions: Map<string, SessionRunState>
}

const runtime = new AsyncLocalStorage<RuntimeState>()
const defaultRuntime: RuntimeState = { stateDir: "", sessions: new Map() }

export const createRuntime = (dir: string): RuntimeState => {
  const state = { stateDir: path.resolve(dir), sessions: new Map<string, SessionRunState>() }
  mkdirSync(state.stateDir, { recursive: true })
  return runtime.run(state, () => {
    loadFromDisk()
    return state
  })
}

export const withRuntime = <A>(state: RuntimeState, operation: () => A): A => runtime.run(state, operation)

const activeRuntime = (): RuntimeState => runtime.getStore() ?? defaultRuntime

export const configure = (dir: string) => {
  defaultRuntime.stateDir = path.resolve(dir)
  mkdirSync(defaultRuntime.stateDir, { recursive: true })
  // I33-1: the structural plan authority (DocumentStore `type:"plan"` doc) roots under the SAME state
  // dir (<dir>/goal/<sid>/graph), so the `plan` tool (via session-state) and the goal path write the
  // same doc. Set the plan-store root here — including for tests that call configure() directly
  // (bypassing the gateway) — so every plan read/write has a configured root.
  // Pointing at a (new) state dir means a fresh session set: clear the in-memory map BEFORE loading, so
  // configure() reflects exactly what's on disk at `dir` and never merges stale sessions from a prior
  // dir. Production calls configure once at gateway init (nothing to lose); tests that configure a fresh
  // tmp dir per case were previously polluted by in-memory sessions surviving across cases/files
  // (loadFromDisk only ADDED entries, never reset), making id-keyed state (e.g. grace counters) leak.
  defaultRuntime.sessions.clear()
  PlanStore.configureRoot(defaultRuntime.stateDir)
  runtime.run(defaultRuntime, loadFromDisk)
}

export const getOrCreate = (sessionId: string, mode: AgentMode): SessionRunState => {
  const existing = activeRuntime().sessions.get(sessionId)
  if (existing) return normalizeState(existing)
  const state: SessionRunState = {
    sessionId,
    mode,
    roundState: createInitialRoundState(mode),
    budget: defaultBudget(mode),
    validationCommands: [],
    lastValidationResults: [],
    lastValidationOutput: null,
    lastValidationActivityId: null,
    knowledgeSynthesis: null,
    knowledgeSnapshotId: null,
    userRequest: null,
    workspacePath: null,
    runId: `run_${randomUUID()}`,
    planLatch: initialPlanLatch(),
    mutationsSinceReport: 0,
    validationPassedSinceReport: false,
    suppressedValidations: [],
    panelArmed: null,
    panelRounds: null,
    activeGoal: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    lastAdmissionUserMessageId: undefined,
    lastPlanGateNudgeFingerprint: null,
    packSnapshotId: null,
    frozenComplexity: null,
    capabilityMode: null,
    observedFiles: {},
  }
  activeRuntime().sessions.set(sessionId, state)
  saveToDisk()
  return state
}

export const get = (sessionId: string): SessionRunState | undefined => activeRuntime().sessions.get(sessionId)

export const update = (sessionId: string, patch: Partial<SessionRunState>): SessionRunState => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) throw new Error(`No DeepAgent session state for ${sessionId}`)
  Object.assign(state, patch)
  activeRuntime().sessions.set(sessionId, state)
  saveToDisk()
  return state
}

export const recordTokenUsage = (sessionId: string, inputTokens: number, outputTokens: number): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.roundState = updateTokenUsage(state.roundState, inputTokens, outputTokens)
  saveToDisk()
}

export const recordCandidate = (sessionId: string, candidate: CandidateRef): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.roundState = addCandidate(state.roundState, candidate)
  saveToDisk()
}

export const recordDiagnosis = (sessionId: string, diagnosis: DiagnosisRef): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.roundState = addDiagnosis(state.roundState, diagnosis)
  saveToDisk()
}

export const recordValidation = (
  sessionId: string,
  results: ValidationResult[],
  output: string,
  activityId?: string,
): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.lastValidationResults = results
  state.lastValidationOutput = output
  // G2 review fix (round 3): bind the evidence to the activity that produced it — the finalizer
  // must not let an OLD activity's all-pass authorize a NEW activity's unvalidated edits.
  state.lastValidationActivityId = activityId ?? null
  // U1: a failing validation is a runtime fact that the current plan no longer matches reality —
  // flip the latch from truth, not from the model's self-report.
  if (results.some((r) => !r.passed)) {
    state.planLatch = markStale(state.planLatch, "validation_failed")
  } else if (results.length > 0) {
    // U10 hybrid nudge: an all-passing validation is the SEMANTIC signal that a step probably just
    // finished. Latch it (cleared on the next real plan status change) so the nudge can fire on this
    // completion boundary rather than waiting for the count backstop.
    state.validationPassedSinceReport = true
  }
  saveToDisk()
}

export const advanceToNextRound = (sessionId: string, decision: import("./mode").RoundDecision): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.roundState = advanceRound(state.roundState, decision)
  saveToDisk()
}

// U1 PlanController: the model writes/updates its structural plan via the `plan` tool. Storing a
// plan is exactly the "I updated the plan" event that clears a stale latch (and bumps replan_count
// via clearStale for the escape hatch). Binds the plan id to the latch.
export const setPlan = (sessionId: string, plan: PlanDoc): void => {
  // Compatibility entry point for legacy callers and migration tests. Production writers must use
  // PlanStore.compareAndCommitPlan followed by bindPlan; this fallback retains the historical API
  // without allowing the new model-tool path to bypass admission.
  const previous = getPlan(sessionId)
  PlanStore.setPlanDoc(sessionId, plan)
  bindPlan(
    sessionId,
    plan,
    previous,
    previous == null || planProgressFingerprint(previous) !== planProgressFingerprint(plan),
  )
}

/**
 * G1 implicit plan: the plan gate registers a single-step plan so a low-risk first edit does not
 * cost a "call the plan tool" provider round. The plan carries runner provenance
 * (runtime_plan_gate) and the same audit trail as a model-written plan — the DocumentStore CAS, the
 * hot-latch bind, and a step the model can advance or replan through the normal `plan` tool.
 * Idempotent: a session that already has ANY plan (model-written or implicit) is left untouched,
 * and a registration race (concurrent plan-tool write) fails closed by refusing to overwrite.
 */
export const registerImplicitPlan = (
  sessionId: string,
  input: { readonly title: string; readonly agentMode: AgentMode },
): { readonly plan_id: string; readonly version: number } | null => {
  if (getPlan(sessionId) != null || PlanStore.planDocRef(sessionId) != null) return null
  const stepId = `step_${randomUUID()}`
  const plan = {
    plan_id: `plan_${randomUUID()}`,
    session_id: sessionId,
    goal: input.title,
    assumptions: [],
    steps: [
      {
        step_id: stepId,
        title: input.title,
        status: "active" as const,
        acceptance: null,
        assigned_agent: null,
        note: "runtime-registered implicit plan (plan gate G1); advance or replan via the plan tool",
      },
    ],
    active_step_id: stepId,
    created_at: new Date().toISOString(),
  }
  try {
    const committed = PlanStore.compareAndCommitPlan({
      sessionId,
      expected: null,
      candidate: plan,
      origin: "runtime_plan_gate",
    })
    bindPlan(sessionId, committed.plan, null, true)
    return { plan_id: committed.plan.plan_id, version: committed.version }
  } catch {
    // A concurrent model plan-write wins; the gate keeps its normal behavior next call.
    return null
  }
}

/** Bind a plan that has already passed PlanStore admission to the hot session latch. */
export const bindPlan = (
  sessionId: string,
  plan: PlanDoc,
  previousPlan: PlanDoc | null = getPlan(sessionId),
  changed = true,
): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  // A semantic no-op may still be the first time a pre-existing authority is adopted into the hot
  // latch. Bind only the pointer in that case; it is not plan progress and must not clear a stale
  // latch, bump replan_count, or reset reporting counters.
  if (!changed) {
    if (state.planLatch.plan_id === plan.plan_id) return
    state.planLatch = { ...state.planLatch, plan_id: plan.plan_id }
    saveToDisk()
    return
  }
  // U10: reset the progress-nudge state ONLY when the model actually moved a step's status (or
  // added a step). A no-op re-write leaves the counter/flag running so the nudge is not silenced by
  // an empty update ("report theater"). The caller passes the pre-commit snapshot because the
  // authoritative store already contains `plan` by the time this hot-state binding runs.
  if (planStatusesChanged(previousPlan, plan)) {
    state.mutationsSinceReport = 0
    state.validationPassedSinceReport = false
  }
  state.planLatch = clearStale({ ...state.planLatch, plan_id: plan.plan_id })
  saveToDisk()
}

// I33-1: read the structural plan from the single DocumentStore authority (plan-store). This is an
// in-memory shared-index lookup + JSON.parse (F30-1 Part 2), safe on the hot path (every tool call).
export const getPlan = (sessionId: string): PlanDoc | null => {
  const planId = activeRuntime().sessions.get(sessionId)?.planLatch.plan_id
  if (!planId) return null
  const plan = PlanStore.getPlanDoc(sessionId)
  return plan?.plan_id === planId ? plan : null
}

// V3.9 §C — Expert Panel per-session arming.
// The raw per-session toggle (null = never explicitly toggled). setPanelArmed writes an explicit
// user choice; resolvePanelArmed resolves the EFFECTIVE state, falling back to the global default when
// the session has no explicit choice. This keeps the global `expertPanelDefault` setting authoritative
// for new conversations while an explicit toggle always wins.
export const setPanelArmed = (sessionId: string, armed: boolean): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.panelArmed = armed
  saveToDisk()
}

/** The raw explicit toggle, or null when the session has never toggled it. */
export const panelArmedChoice = (sessionId: string): boolean | null =>
  activeRuntime().sessions.get(sessionId)?.panelArmed ?? null

/**
 * Effective armed state: the explicit per-session choice if set, else the supplied global default. Pass
 * the resolved `expertPanelDefault` setting so the fallback reflects the server's configured default.
 */
export const resolvePanelArmed = (sessionId: string, globalDefault: boolean): boolean => {
  const choice = activeRuntime().sessions.get(sessionId)?.panelArmed
  return choice ?? globalDefault
}

/** Back-compat: effective armed state with a hard `false` fallback (no global default available). */
export const isPanelArmed = (sessionId: string): boolean => activeRuntime().sessions.get(sessionId)?.panelArmed ?? false

// V4.0 — Expert Panel debate-depth preference (composer three-state control). Decoupled from arming.
export const setPanelRounds = (sessionId: string, rounds: "single" | "multi"): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.panelRounds = rounds
  saveToDisk()
}

/** The chosen debate depth, defaulting to "single" when never explicitly chosen. */
export const panelRounds = (sessionId: string): "single" | "multi" =>
  activeRuntime().sessions.get(sessionId)?.panelRounds ?? "single"

// V3.9 §D — active-goal pointer. The GoalLoop status doc in the DocumentStore is authoritative; this
// pointer is the session-local index the server/UI use to find and reflect the running goal.
export const setActiveGoal = (sessionId: string, pointer: ActiveGoalPointer | null): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.activeGoal = pointer
  saveToDisk()
}

export const getActiveGoal = (sessionId: string): ActiveGoalPointer | null =>
  activeRuntime().sessions.get(sessionId)?.activeGoal ?? null

// Patch just the phase of the active-goal pointer (driver transitions running↔paused, terminal states).
// No-op when there is no active goal (a stale transition after stop must not resurrect a pointer).
export const setActiveGoalPhase = (sessionId: string, phase: GoalPointerPhase): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state || state.activeGoal == null) return
  state.activeGoal = { ...state.activeGoal, phase }
  saveToDisk()
}

// U10: count one mutating tool call toward the progress-nudge budget. Called after a mutating tool
// executes. No-op when there is no plan (the nudge only applies once the model has a plan to report
// against).
export const recordMutation = (sessionId: string): void => {
  const state = activeRuntime().sessions.get(sessionId)
  // I33-1: the nudge only applies once a plan exists — the latch's plan_id is the hot-path pointer
  // (set by setPlan), so we gate on it instead of a stored body.
  if (!state || state.planLatch.plan_id == null) return
  state.mutationsSinceReport += 1
  saveToDisk()
}

export const mutationsSinceReport = (sessionId: string): number =>
  activeRuntime().sessions.get(sessionId)?.mutationsSinceReport ?? 0

export const validationPassedSinceReport = (sessionId: string): boolean =>
  activeRuntime().sessions.get(sessionId)?.validationPassedSinceReport ?? false

// Round-context suppression helpers (v4.0.4 → upgraded PR-4)
// All callers should use suppressValidation / unsuppressValidation / getSuppressedValidations.
// getSuppressedFingerprints is a backward-compat shim for request.ts transition callers.

export const suppressValidation = (sessionId: string, command: string, exitCode: number, reason: string): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  const fingerprint = `${command} ${exitCode}`
  const existing = state.suppressedValidations.findIndex((v) => v.fingerprint === fingerprint)
  if (existing >= 0) {
    // Update reason in-place (idempotent, but refresh audit fields).
    state.suppressedValidations = state.suppressedValidations.map((v, i) =>
      i === existing ? { ...v, reason, suppressedAt: Date.now() } : v,
    )
  } else {
    state.suppressedValidations = [
      ...state.suppressedValidations,
      { command, exitCode, fingerprint, reason, suppressedAt: Date.now() },
    ]
  }
  saveToDisk()
}

export const unsuppressValidation = (sessionId: string, fingerprint: string): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  const next = state.suppressedValidations.filter((v) => v.fingerprint !== fingerprint)
  if (next.length === state.suppressedValidations.length) return
  state.suppressedValidations = next
  saveToDisk()
}

export const getSuppressedValidations = (sessionId: string): readonly SuppressedValidation[] =>
  activeRuntime().sessions.get(sessionId)?.suppressedValidations ?? []

/** Backward-compat shim: returns only the fingerprint strings. Used by request.ts during migration. */
export const getSuppressedFingerprints = (sessionId: string): readonly string[] =>
  getSuppressedValidations(sessionId).map((v) => v.fingerprint)

export const isFingerprintSuppressed = (sessionId: string, fingerprint: string): boolean =>
  getSuppressedValidations(sessionId).some((v) => v.fingerprint === fingerprint)

export const clearSuppressedValidations = (sessionId: string): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state || state.suppressedValidations.length === 0) return
  state.suppressedValidations = []
  saveToDisk()
}

/** @deprecated Use suppressValidation(). Retained as alias for call-sites not yet migrated. */
export const suppressFingerprint = (sessionId: string, fingerprint: string): void => {
  const lastSpace = fingerprint.lastIndexOf(" ")
  const command = lastSpace >= 0 ? fingerprint.slice(0, lastSpace) : fingerprint
  const exitCode = lastSpace >= 0 ? parseInt(fingerprint.slice(lastSpace + 1), 10) : 0
  suppressValidation(sessionId, command, isNaN(exitCode) ? 0 : exitCode, "legacy-call")
}

/** @deprecated Use unsuppressValidation(). Retained as alias. */
export const unsuppressFingerprint = (sessionId: string, fingerprint: string): void =>
  unsuppressValidation(sessionId, fingerprint)

/**
 * Did the latest validation run pass?
 *
 * The predicate `stepCanComplete` is written against, so the plan tool can refuse a step that claims
 * an acceptance criterion it has not met. It reports only what the runtime OBSERVED: `false` when no
 * validation has run at all, which is the honest answer — "nothing failed" is not "it passed".
 *
 * Activity binding matters here for the same reason it does at delivery: an older activity's passing
 * validation must not authorize a newer activity's unvalidated work, so a caller that knows its
 * activity passes `activityId` and gets `false` unless the evidence belongs to it.
 */
export const lastValidationPassed = (sessionId: string, activityId?: string): boolean => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state || state.lastValidationResults.length === 0) return false
  if (activityId !== undefined && state.lastValidationActivityId !== activityId) return false
  return state.lastValidationResults.every((result) => result.passed)
}

// U10 / P2-E: a compact summary of the latest validation run, used as step evidence when a step
// moves to `done`. Null when nothing has been validated yet.
export const lastValidationSummary = (sessionId: string): string | null => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state || state.lastValidationResults.length === 0) return null
  const results = state.lastValidationResults
  const passed = results.filter((r) => r.passed).length
  const cmds = results.map((r) => `${r.command}${r.passed ? "✓" : "✗"}`).join(", ")
  return `validation ${passed}/${results.length} passed: ${cmds}`
}

// U1: flip the latch to stale from a RUNTIME signal (never from the model). Idempotent on reason.
export const markPlanStale = (sessionId: string, reason: StaleReason): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  const next = markStale(state.planLatch, reason)
  if (next === state.planLatch) return
  state.planLatch = next
  saveToDisk()
}

export type UserMessageObservation = "initial" | "same" | "new" | "reopened"

/**
 * Observes a user admission message and returns whether it is the first,
 * same as last time, or genuinely new. Used to gate markPlanStale("user_appended")
 * so that only real user inputs — not synthetic reminders or tool continuations —
 * trigger plan staleness.
 *
 * "initial": first time this session is seen; records the baseline ID, does NOT
 *   mark stale. Old state without lastAdmissionUserMessageId migrates here.
 * "same": same ID as last recorded; this is a tool continuation, skip.
 * "new": different ID while the activity is live; caller should mark its plan stale.
 * "reopened": different ID after completion/failure; starts a fresh activity while retaining
 *   session-scoped preferences and the versioned plan history.
 */
export const observeUserAdmission = (sessionId: string, admissionMessageId: string): UserMessageObservation => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return "initial"
  if (state.lastAdmissionUserMessageId === undefined) {
    state.lastAdmissionUserMessageId = admissionMessageId
    saveToDisk()
    return "initial"
  }
  if (state.lastAdmissionUserMessageId === admissionMessageId) return "same"
  state.lastAdmissionUserMessageId = admissionMessageId
  if (state.completedAt) {
    state.roundState = createInitialRoundState(state.mode)
    state.lastValidationResults = []
    state.lastValidationOutput = null
    state.knowledgeSynthesis = null
    state.knowledgeSnapshotId = null
    state.runId = `run_${randomUUID()}`
    state.planLatch = initialPlanLatch()
    state.mutationsSinceReport = 0
    state.validationPassedSinceReport = false
    state.suppressedValidations = []
    state.completedAt = null
    state.lastPlanGateNudgeFingerprint = null
    saveToDisk()
    return "reopened"
  }
  saveToDisk()
  return "new"
}

// U1: clear the latch directly (used by tests / explicit replan); setPlan is the normal path.
export const clearPlanStale = (sessionId: string): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.planLatch = clearStale(state.planLatch)
  saveToDisk()
}

export const claimPlanGateNudge = (sessionId: string, fingerprint: string): boolean => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state || state.lastPlanGateNudgeFingerprint === fingerprint) return false
  state.lastPlanGateNudgeFingerprint = fingerprint
  saveToDisk()
  return true
}

// U1 anti-deadlock: record that the plan gate just blocked a mutating tool on a stale plan. Advances
// the runtime grace counter so shouldGraceRelease can fire without the model cooperating.
export const recordPlanGateBlock = (sessionId: string): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.planLatch = recordGateBlock(state.planLatch)
  saveToDisk()
}

// U1 anti-deadlock: a mutating tool actually executed (forward progress), so reset the grace counter.
// No-op when already zero to avoid churning disk writes on the hot path.
export const resetPlanGateBlocks = (sessionId: string): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  const next = resetGateBlocks(state.planLatch)
  if (next === state.planLatch) return
  state.planLatch = next
  saveToDisk()
}

export const planLatch = (sessionId: string): PlanLatchState | undefined =>
  activeRuntime().sessions.get(sessionId)?.planLatch

export const complete = (sessionId: string): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.roundState = { ...state.roundState, phase: "completed" }
  state.completedAt = new Date().toISOString()
  saveToDisk()
}

export const fail = (sessionId: string): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  state.roundState = { ...state.roundState, phase: "failed" }
  state.completedAt = new Date().toISOString()
  saveToDisk()
}

export const isBudgetExhausted = (sessionId: string): boolean => {
  const result = budgetStatus(sessionId)
  if (!result) return false
  return result.status === "exhausted" || result.status === "exceeded"
}

export const budgetStatus = (sessionId: string): BudgetCheck | undefined => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  return budgetCheck(state.roundState, state.budget)
}

export const cleanup = (sessionId: string): void => {
  activeRuntime().sessions.delete(sessionId)
  saveToDisk()
}

export const allSessions = (): ReadonlyMap<string, SessionRunState> => activeRuntime().sessions

export const pruneCompleted = (maxAge_ms = 24 * 60 * 60 * 1000): void => {
  const now = Date.now()
  for (const [id, state] of activeRuntime().sessions) {
    if (state.completedAt && now - new Date(state.completedAt).getTime() > maxAge_ms) {
      activeRuntime().sessions.delete(id)
    }
  }
  saveToDisk()
}

// PERF: maximum bytes stored for the userRequest field. The field is used for display/context
// heuristics only — a 10KB cap prevents one large paste from bloating sessions.json by ~800KB.
const MAX_USER_REQUEST_BYTES = 10_000

// This is runtime authority, so each mutation is atomically durable before it returns. A deferred
// process-global debounce can write through the wrong root after another runtime starts or lose the
// final mutation on shutdown.
function saveToDisk() {
  flushToDisk(activeRuntime())
}

function flushToDisk(state: RuntimeState) {
  if (!state.stateDir) return
  // P2-G: atomic rewrite so a crash can't truncate sessions.json. P2-D: surface write failures to
  // stderr instead of silently dropping run state (a lost session-state write is a real data loss,
  // not something to swallow). Still non-throwing: persistence failure must not crash the turn.
  try {
    // Build a serialization-safe snapshot: truncate oversized fields so one large session
    // (e.g. a user pasting a multi-hundred-KB document) does not inflate the whole file.
    const data: Record<string, unknown> = {}
    for (const [id, session] of state.sessions) {
      const serialized: Record<string, unknown> = { ...session }
      if (typeof serialized.userRequest === "string" && serialized.userRequest.length > MAX_USER_REQUEST_BYTES) {
        serialized.userRequest = serialized.userRequest.slice(0, MAX_USER_REQUEST_BYTES)
      }
      data[id] = serialized
    }
    // Compact JSON (no pretty-print): sessions.json is machine-read only; the 2-space indent
    // was adding ~25% bloat to a file that is synchronously read and written on every state change.
    writeFileAtomic(path.join(state.stateDir, "sessions.json"), JSON.stringify(data))
  } catch (error) {
    console.error("deepagent session-state: failed to persist sessions.json", error)
  }
}

function normalizeState(state: SessionRunState): SessionRunState {
  const nextBudget = defaultBudget(state.mode)
  const normalized = {
    ...state,
    budget: {
      ...state.budget,
      // B4 (design §7.3): preserve an explicitly configured token ceiling. The unconditional
      // reset to the null default made maxTotalTokens permanently null, leaving Budget.check's
      // warning/exhausted branches (and the prompt-policy "Token budget remaining" line)
      // unreachable. Deriving a default from the model context window at session start is NOT
      // done here: no initialization caller (getOrCreate / orchestrator.initSession /
      // agent-gateway.ensureSessionStateForRun) carries a context-window value today.
      maxTotalTokens: state.budget?.maxTotalTokens ?? nextBudget.maxTotalTokens,
      maxRounds: nextBudget.maxRounds,
    },
    // Backfill: sessions persisted before U1 have no planLatch/plan on disk. Sessions persisted
    // between U1 and the anti-deadlock change have a planLatch WITHOUT consecutive_blocks — backfill
    // that field to 0 so shouldGraceRelease reads a defined counter (an undefined would make
    // `>= limit` false forever, silently disabling the grace release for older sessions).
    planLatch: state.planLatch
      ? { ...state.planLatch, consecutive_blocks: state.planLatch.consecutive_blocks ?? 0 }
      : initialPlanLatch(PlanStore.getPlanDoc(state.sessionId)?.plan_id ?? null),
    // Backfill: sessions persisted before U10 have no counter on disk.
    mutationsSinceReport: state.mutationsSinceReport ?? 0,
    validationPassedSinceReport: state.validationPassedSinceReport ?? false,
    knowledgeSnapshotId: state.knowledgeSnapshotId ?? null,
    // Backfill: sessions persisted before the G3 review fix have no frozenComplexity on disk.
    frozenComplexity: state.frozenComplexity ?? null,
    // Backfill: sessions persisted before the capability-mode ledger existed.
    capabilityMode: state.capabilityMode ?? null,
    // Backfill: sessions persisted before the file-observation ledger existed.
    observedFiles: state.observedFiles ?? {},
    // Backfill: same for the round-3 validation-activity binding.
    lastValidationActivityId: state.lastValidationActivityId ?? null,
    // Backfill/migration: sessions persisted before v4.0.4 have no suppressedValidations field;
    // sessions persisted between v4.0.4 and this change carry the OLD `suppressedFingerprints:
    // string[]` format. Migrate both cases into the new SuppressedValidation[] shape.
    // Old fingerprint format: "${command} ${exit_code}" — split on the LAST space so commands
    // that contain spaces are handled correctly (exit codes are always digits).
    suppressedValidations: (() => {
      const raw = state as unknown as Record<string, unknown>
      if (Array.isArray(state.suppressedValidations)) return state.suppressedValidations
      const legacy = raw.suppressedFingerprints
      if (!Array.isArray(legacy)) return []
      const now = Date.now()
      return (legacy as string[]).map((fp): SuppressedValidation => {
        const lastSpace = fp.lastIndexOf(" ")
        const command = lastSpace >= 0 ? fp.slice(0, lastSpace) : fp
        const exitCode = lastSpace >= 0 ? parseInt(fp.slice(lastSpace + 1), 10) : 0
        return {
          command,
          exitCode: isNaN(exitCode) ? 0 : exitCode,
          fingerprint: fp,
          reason: "migrated",
          suppressedAt: now,
        }
      })
    })(),
    // Backfill: sessions persisted before V3.9 §C/§D have neither slot on disk. panelArmed backfills to
    // null (= not explicitly toggled → follows the global default), NOT false.
    panelArmed: state.panelArmed ?? null,
    // Backfill: sessions persisted before V4.0 have no panelRounds → null (defaults to "single").
    panelRounds: state.panelRounds ?? null,
    activeGoal: state.activeGoal ?? null,
    lastPlanGateNudgeFingerprint: state.lastPlanGateNudgeFingerprint ?? null,
    // Backfill: sessions persisted before FEAT-007 have no pack snapshot attribution → null.
    packSnapshotId: state.packSnapshotId ?? null,
  }
  // PR-4 migration cleanup: the legacy `suppressedFingerprints: string[]` field is carried through by
  // the `...state` spread above. Once its contents are migrated into `suppressedValidations`, drop the
  // orphan so it is not re-persisted forever as dead data on the next saveToDisk().
  delete (normalized as unknown as Record<string, unknown>).suppressedFingerprints
  activeRuntime().sessions.set(state.sessionId, normalized)
  return normalized
}

function loadFromDisk() {
  const state = activeRuntime()
  if (!state.stateDir) return
  try {
    const content = readFileSync(path.join(state.stateDir, "sessions.json"), "utf8")
    // Legacy sessions.json (pre-I33-1) carried the structural plan body on `state.plan`. Read it as an
    // optional field so we can migrate it into the DocumentStore authority, then drop it from state.
    const data = JSON.parse(content) as Record<string, SessionRunState & { plan?: PlanDoc | null }>
    for (const [id, state] of Object.entries(data)) {
      if (state.completedAt) continue
      // I33-1 migration: if this session still has an inline plan body from before the store became the
      // authority, seed it into the plan-store (idempotent upsert) so nothing is lost, then let it fall
      // away (normalizeState no longer carries `plan`). Only migrate when the store has no plan yet, so
      // a newer store doc (e.g. a goal edit) is never overwritten by a stale inline body.
      if (state.plan && !PlanStore.getPlanDoc(id)) {
        try {
          const admitted = buildPlanFromWriteInput(
            id,
            {
              operation: "create",
              expected_plan_id: null,
              expected_version: null,
              goal: state.plan.goal,
              assumptions: state.plan.assumptions ?? [],
              steps: state.plan.steps.map((step) => ({
                step_id: step.step_id,
                title: step.title,
                status: step.status,
                acceptance: step.acceptance ?? undefined,
                assigned_agent: step.assigned_agent ?? undefined,
                note: step.note ?? undefined,
              })),
              active_step_id: state.plan.active_step_id,
            },
            null,
            null,
          )
          PlanStore.compareAndCommitPlan({
            sessionId: id,
            expected: null,
            candidate: {
              ...admitted,
              plan_id: state.plan.plan_id,
              created_at: state.plan.created_at,
              replan_reason: state.plan.replan_reason ?? null,
              steps: admitted.steps.map((step) => ({
                ...step,
                evidence: [...(state.plan!.steps.find((source) => source.step_id === step.step_id)?.evidence ?? [])],
              })),
            },
            origin: "legacy_migration",
          })
        } catch (error) {
          writeLegacyPlanMigrationDiagnostic(id, state.plan, error)
        }
      }
      activeRuntime().sessions.set(id, normalizeState(state))
    }
  } catch {}
}

const writeLegacyPlanMigrationDiagnostic = (
  sessionId: string,
  plan: PlanDoc | null | undefined,
  error: unknown,
): void => {
  const code = error instanceof PlanValidationError ? error.code : "legacy_plan_migration_failed"
  const message = error instanceof Error ? error.message : String(error)
  const store = DocumentStore.shared(PlanStore.planStoreRoot(sessionId))
  const description = `DeepAgent legacy plan migration diagnostic ${sessionId}`
  const doc = store.upsert({
    type: "diagnosis",
    scope: PlanStore.planScope(sessionId),
    description,
    idSlug: `plan-migration-${sessionId}`,
    body: JSON.stringify({
      schema_version: 1,
      kind: "legacy_plan_migration",
      status: "quarantined",
      session_id: sessionId,
      plan_id: plan?.plan_id ?? null,
      code,
      message,
      observed_at: new Date().toISOString(),
    }),
    provenance: { source: "runner", run_ref: PlanStore.planScope(sessionId) },
    tags: ["bug-010", "plan-migration", "quarantined"],
  })
  store.setStatus(doc.id, "quarantined", documentRevision(doc))
}

/** How many file observations a session keeps before the oldest are evicted. */
const MAX_OBSERVED_FILES = 256

/**
 * Record that this session OBSERVED a file at a version (read, or a mutation it performed).
 * Absent session state is not an error: a tool call outside a DeepAgent session simply cannot arm
 * the write guard for that session.
 */
export const observeFile = (sessionId: string, path: string, version: ObservedFileVersion): void => {
  const state = activeRuntime().sessions.get(sessionId)
  if (!state) return
  const observed = state.observedFiles ?? {}
  const keys = Object.keys(observed)
  if (!(path in observed) && keys.length >= MAX_OBSERVED_FILES) {
    // Oldest-first eviction keeps the ledger bounded without a timestamp per entry: insertion order
    // is the age order, and the write guard only needs the RECENT observations.
    const oldest = keys[0]
    if (oldest !== undefined) delete observed[oldest]
  }
  observed[path] = version
  state.observedFiles = observed
  activeRuntime().sessions.set(sessionId, state)
  saveToDisk()
}

/** The version this session observed for `path`, or undefined when it never observed the file. */
export const observedFile = (sessionId: string, path: string): ObservedFileVersion | undefined => {
  const state = activeRuntime().sessions.get(sessionId)
  return state?.observedFiles?.[path]
}
