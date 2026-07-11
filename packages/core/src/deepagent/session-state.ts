import { mkdirSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { writeFileAtomic } from "./atomic-write"
import type { AgentMode } from "./mode"
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
  type PlanLatchState,
  type StaleReason,
  type PlanDoc,
} from "./plan-controller"

export type SessionRunState = {
  sessionId: string
  mode: AgentMode
  roundState: RoundState
  budget: BudgetConfig
  validationCommands: string[]
  lastValidationResults: ValidationResult[]
  lastValidationOutput: string | null
  knowledgeSynthesis: KnowledgeSynthesis | null
  userRequest: string | null
  workspacePath: string | null
  runId: string
  // U1 PlanController: the runtime plan latch (fresh/stale + reason + replan count). The structural
  // plan lives in DocumentStore; only this hot-path value object is carried on session state.
  planLatch: PlanLatchState
  // U1: the live working plan (goal/steps) the model writes via the `plan` tool and the UI renders.
  // Kept on run state (hot path, atomically persisted) — graduated into the durable run-graph as a
  // `plan` doc at run close, mirroring how DESIGN.md is materialized.
  plan: PlanDoc | null
  // U10 step-reporting: count of mutating tool calls since the model last CHANGED a plan step's
  // status. Drives the progress-nudge count backstop (nudgeTrigger). Reset to 0 only when setPlan
  // detects a real status change — a no-op plan re-write must not silence the nudge.
  mutationsSinceReport: number
  // U10 hybrid nudge: set true when a validation run went (back) to all-passing since the last plan
  // update. The SEMANTIC primary trigger for the progress nudge ("a step probably just finished").
  // Reset with the counter on a real status change.
  validationPassedSinceReport: boolean
  // V3.9 §C: whether this conversation has EXPLICITLY toggled the Expert Panel "armed" state from the
  // chat dialog. `null` = never toggled → the effective armed state falls back to the global
  // `expertPanelDefault` setting (resolved server-side, so the UI reflects the server default without a
  // client round-trip guess). Armed means the user may convene a panel (button press) and — when a goal
  // loop is running — the loop may convene the panel at high-risk decision points (§C activation).
  panelArmed: boolean | null
  // V3.9 §D: a lightweight pointer to the goal currently driven for this session (the authoritative
  // loop state lives in the DocumentStore run_context doc — this is only enough to find/resume it and
  // reflect its phase in the UI). Null when no goal is running.
  activeGoal: ActiveGoalPointer | null
  createdAt: string
  completedAt: string | null
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

let stateDir: string | null = null
const sessions = new Map<string, SessionRunState>()

export const configure = (dir: string) => {
  stateDir = dir
  mkdirSync(dir, { recursive: true })
  loadFromDisk()
}

export const getOrCreate = (sessionId: string, mode: AgentMode): SessionRunState => {
  const existing = sessions.get(sessionId)
  if (existing) return normalizeState(existing)
  const state: SessionRunState = {
    sessionId,
    mode,
    roundState: createInitialRoundState(mode),
    budget: defaultBudget(mode),
    validationCommands: [],
    lastValidationResults: [],
    lastValidationOutput: null,
    knowledgeSynthesis: null,
    userRequest: null,
    workspacePath: null,
    runId: `run_${randomUUID()}`,
    planLatch: initialPlanLatch(),
    plan: null,
    mutationsSinceReport: 0,
    validationPassedSinceReport: false,
    panelArmed: null,
    activeGoal: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  }
  sessions.set(sessionId, state)
  saveToDisk()
  return state
}

export const get = (sessionId: string): SessionRunState | undefined => sessions.get(sessionId)

export const update = (sessionId: string, patch: Partial<SessionRunState>): SessionRunState => {
  const state = sessions.get(sessionId)
  if (!state) throw new Error(`No DeepAgent session state for ${sessionId}`)
  Object.assign(state, patch)
  sessions.set(sessionId, state)
  saveToDisk()
  return state
}

export const recordTokenUsage = (sessionId: string, inputTokens: number, outputTokens: number): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.roundState = updateTokenUsage(state.roundState, inputTokens, outputTokens)
  saveToDisk()
}

export const recordCandidate = (sessionId: string, candidate: CandidateRef): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.roundState = addCandidate(state.roundState, candidate)
  saveToDisk()
}

export const recordDiagnosis = (sessionId: string, diagnosis: DiagnosisRef): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.roundState = addDiagnosis(state.roundState, diagnosis)
  saveToDisk()
}

export const recordValidation = (sessionId: string, results: ValidationResult[], output: string): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.lastValidationResults = results
  state.lastValidationOutput = output
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
  const state = sessions.get(sessionId)
  if (!state) return
  state.roundState = advanceRound(state.roundState, decision)
  saveToDisk()
}

// U1 PlanController: the model writes/updates its structural plan via the `plan` tool. Storing a
// plan is exactly the "I updated the plan" event that clears a stale latch (and bumps replan_count
// via clearStale for the escape hatch). Binds the plan id to the latch.
export const setPlan = (sessionId: string, plan: PlanDoc): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  // U10: reset the progress-nudge state ONLY when the model actually moved a step's status (or
  // added a step). A no-op re-write leaves the counter/flag running so the nudge is not silenced by
  // an empty update ("report theater").
  if (planStatusesChanged(state.plan, plan)) {
    state.mutationsSinceReport = 0
    state.validationPassedSinceReport = false
  }
  state.plan = plan
  state.planLatch = clearStale({ ...state.planLatch, plan_id: plan.plan_id })
  saveToDisk()
}

export const getPlan = (sessionId: string): PlanDoc | null => sessions.get(sessionId)?.plan ?? null

// V3.9 §C — Expert Panel per-session arming.
// The raw per-session toggle (null = never explicitly toggled). setPanelArmed writes an explicit
// user choice; resolvePanelArmed resolves the EFFECTIVE state, falling back to the global default when
// the session has no explicit choice. This keeps the global `expertPanelDefault` setting authoritative
// for new conversations while an explicit toggle always wins.
export const setPanelArmed = (sessionId: string, armed: boolean): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.panelArmed = armed
  saveToDisk()
}

/** The raw explicit toggle, or null when the session has never toggled it. */
export const panelArmedChoice = (sessionId: string): boolean | null => sessions.get(sessionId)?.panelArmed ?? null

/**
 * Effective armed state: the explicit per-session choice if set, else the supplied global default. Pass
 * the resolved `expertPanelDefault` setting so the fallback reflects the server's configured default.
 */
export const resolvePanelArmed = (sessionId: string, globalDefault: boolean): boolean => {
  const choice = sessions.get(sessionId)?.panelArmed
  return choice ?? globalDefault
}

/** Back-compat: effective armed state with a hard `false` fallback (no global default available). */
export const isPanelArmed = (sessionId: string): boolean => sessions.get(sessionId)?.panelArmed ?? false

// V3.9 §D — active-goal pointer. The GoalLoop status doc in the DocumentStore is authoritative; this
// pointer is the session-local index the server/UI use to find and reflect the running goal.
export const setActiveGoal = (sessionId: string, pointer: ActiveGoalPointer | null): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.activeGoal = pointer
  saveToDisk()
}

export const getActiveGoal = (sessionId: string): ActiveGoalPointer | null =>
  sessions.get(sessionId)?.activeGoal ?? null

// Patch just the phase of the active-goal pointer (driver transitions running↔paused, terminal states).
// No-op when there is no active goal (a stale transition after stop must not resurrect a pointer).
export const setActiveGoalPhase = (sessionId: string, phase: GoalPointerPhase): void => {
  const state = sessions.get(sessionId)
  if (!state || state.activeGoal == null) return
  state.activeGoal = { ...state.activeGoal, phase }
  saveToDisk()
}

// U10: count one mutating tool call toward the progress-nudge budget. Called after a mutating tool
// executes. No-op when there is no plan (the nudge only applies once the model has a plan to report
// against).
export const recordMutation = (sessionId: string): void => {
  const state = sessions.get(sessionId)
  if (!state || state.plan == null) return
  state.mutationsSinceReport += 1
  saveToDisk()
}

export const mutationsSinceReport = (sessionId: string): number => sessions.get(sessionId)?.mutationsSinceReport ?? 0

export const validationPassedSinceReport = (sessionId: string): boolean =>
  sessions.get(sessionId)?.validationPassedSinceReport ?? false

// U10 / P2-E: a compact summary of the latest validation run, used as step evidence when a step
// moves to `done`. Null when nothing has been validated yet.
export const lastValidationSummary = (sessionId: string): string | null => {
  const state = sessions.get(sessionId)
  if (!state || state.lastValidationResults.length === 0) return null
  const results = state.lastValidationResults
  const passed = results.filter((r) => r.passed).length
  const cmds = results.map((r) => `${r.command}${r.passed ? "✓" : "✗"}`).join(", ")
  return `validation ${passed}/${results.length} passed: ${cmds}`
}

// U1: flip the latch to stale from a RUNTIME signal (never from the model). Idempotent on reason.
export const markPlanStale = (sessionId: string, reason: StaleReason): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  const next = markStale(state.planLatch, reason)
  if (next === state.planLatch) return
  state.planLatch = next
  saveToDisk()
}

// U1: clear the latch directly (used by tests / explicit replan); setPlan is the normal path.
export const clearPlanStale = (sessionId: string): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.planLatch = clearStale(state.planLatch)
  saveToDisk()
}

// U1 anti-deadlock: record that the plan gate just blocked a mutating tool on a stale plan. Advances
// the runtime grace counter so shouldGraceRelease can fire without the model cooperating.
export const recordPlanGateBlock = (sessionId: string): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.planLatch = recordGateBlock(state.planLatch)
  saveToDisk()
}

// U1 anti-deadlock: a mutating tool actually executed (forward progress), so reset the grace counter.
// No-op when already zero to avoid churning disk writes on the hot path.
export const resetPlanGateBlocks = (sessionId: string): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  const next = resetGateBlocks(state.planLatch)
  if (next === state.planLatch) return
  state.planLatch = next
  saveToDisk()
}

export const planLatch = (sessionId: string): PlanLatchState | undefined => sessions.get(sessionId)?.planLatch

export const complete = (sessionId: string): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.roundState = { ...state.roundState, phase: "completed" }
  state.completedAt = new Date().toISOString()
  saveToDisk()
}

export const fail = (sessionId: string): void => {
  const state = sessions.get(sessionId)
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
  const state = sessions.get(sessionId)
  if (!state) return
  return budgetCheck(state.roundState, state.budget)
}

export const cleanup = (sessionId: string): void => {
  sessions.delete(sessionId)
  saveToDisk()
}

export const allSessions = (): ReadonlyMap<string, SessionRunState> => sessions

export const pruneCompleted = (maxAge_ms = 24 * 60 * 60 * 1000): void => {
  const now = Date.now()
  for (const [id, state] of sessions) {
    if (state.completedAt && now - new Date(state.completedAt).getTime() > maxAge_ms) {
      sessions.delete(id)
    }
  }
  saveToDisk()
}

function saveToDisk() {
  if (!stateDir) return
  // P2-G: atomic rewrite so a crash can't truncate sessions.json. P2-D: surface write failures to
  // stderr instead of silently dropping run state (a lost session-state write is a real data loss,
  // not something to swallow). Still non-throwing: persistence failure must not crash the turn.
  try {
    const data = Object.fromEntries(sessions)
    writeFileAtomic(path.join(stateDir, "sessions.json"), JSON.stringify(data, null, 2))
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
      maxTotalTokens: nextBudget.maxTotalTokens,
      maxRounds: nextBudget.maxRounds,
    },
    // Backfill: sessions persisted before U1 have no planLatch/plan on disk. Sessions persisted
    // between U1 and the anti-deadlock change have a planLatch WITHOUT consecutive_blocks — backfill
    // that field to 0 so shouldGraceRelease reads a defined counter (an undefined would make
    // `>= limit` false forever, silently disabling the grace release for older sessions).
    planLatch: state.planLatch
      ? { ...state.planLatch, consecutive_blocks: state.planLatch.consecutive_blocks ?? 0 }
      : initialPlanLatch(),
    plan: state.plan ?? null,
    // Backfill: sessions persisted before U10 have no counter on disk.
    mutationsSinceReport: state.mutationsSinceReport ?? 0,
    validationPassedSinceReport: state.validationPassedSinceReport ?? false,
    // Backfill: sessions persisted before V3.9 §C/§D have neither slot on disk. panelArmed backfills to
    // null (= not explicitly toggled → follows the global default), NOT false.
    panelArmed: state.panelArmed ?? null,
    activeGoal: state.activeGoal ?? null,
  }
  sessions.set(state.sessionId, normalized)
  return normalized
}

function loadFromDisk() {
  if (!stateDir) return
  try {
    const content = readFileSync(path.join(stateDir, "sessions.json"), "utf8")
    const data = JSON.parse(content) as Record<string, SessionRunState>
    for (const [id, state] of Object.entries(data)) {
      if (!state.completedAt) sessions.set(id, normalizeState(state))
    }
  } catch {}
}
