import { mkdirSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { writeFileAtomic } from "./atomic-write"
import * as PlanStore from "./plan-store"
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
  // Round-context: fingerprints (command + " " + exit_code) of validation failures the model has
  // acknowledged as false positives or already-handled. Matching failures are suppressed (not
  // re-injected next round). Empty set = no change in behaviour. Cleared when a genuinely new
  // result for the same command arrives, so real regressions are never silently swallowed.
  suppressedFingerprints: string[]
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
  // I33-1: the structural plan authority (DocumentStore `type:"plan"` doc) roots under the SAME state
  // dir (<dir>/goal/<sid>/graph), so the `plan` tool (via session-state) and the goal path write the
  // same doc. Set the plan-store root here — including for tests that call configure() directly
  // (bypassing the gateway) — so every plan read/write has a configured root.
  PlanStore.configureRoot(dir)
  // Pointing at a (new) state dir means a fresh session set: clear the in-memory map BEFORE loading, so
  // configure() reflects exactly what's on disk at `dir` and never merges stale sessions from a prior
  // dir. Production calls configure once at gateway init (nothing to lose); tests that configure a fresh
  // tmp dir per case were previously polluted by in-memory sessions surviving across cases/files
  // (loadFromDisk only ADDED entries, never reset), making id-keyed state (e.g. grace counters) leak.
  sessions.clear()
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
    mutationsSinceReport: 0,
    validationPassedSinceReport: false,
    suppressedFingerprints: [],
    panelArmed: null,
    panelRounds: null,
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
  // an empty update ("report theater"). Compare against the CURRENT structural plan in the store.
  const previous = PlanStore.getPlanDoc(sessionId)
  if (planStatusesChanged(previous, plan)) {
    state.mutationsSinceReport = 0
    state.validationPassedSinceReport = false
  }
  // I33-1: the plan body is written to the single DocumentStore authority (plan-store); session state
  // keeps only the latch pointer (plan_id). The store upsert is content-addressed + CAS-protected.
  PlanStore.setPlanDoc(sessionId, plan)
  state.planLatch = clearStale({ ...state.planLatch, plan_id: plan.plan_id })
  saveToDisk()
}

// I33-1: read the structural plan from the single DocumentStore authority (plan-store). This is an
// in-memory shared-index lookup + JSON.parse (F30-1 Part 2), safe on the hot path (every tool call).
export const getPlan = (sessionId: string): PlanDoc | null => PlanStore.getPlanDoc(sessionId)

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

// V4.0 — Expert Panel debate-depth preference (composer three-state control). Decoupled from arming.
export const setPanelRounds = (sessionId: string, rounds: "single" | "multi"): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  state.panelRounds = rounds
  saveToDisk()
}

/** The chosen debate depth, defaulting to "single" when never explicitly chosen. */
export const panelRounds = (sessionId: string): "single" | "multi" =>
  sessions.get(sessionId)?.panelRounds ?? "single"

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
  // I33-1: the nudge only applies once a plan exists — the latch's plan_id is the hot-path pointer
  // (set by setPlan), so we gate on it instead of a stored body.
  if (!state || state.planLatch.plan_id == null) return
  state.mutationsSinceReport += 1
  saveToDisk()
}

export const mutationsSinceReport = (sessionId: string): number => sessions.get(sessionId)?.mutationsSinceReport ?? 0

export const validationPassedSinceReport = (sessionId: string): boolean =>
  sessions.get(sessionId)?.validationPassedSinceReport ?? false

// Round-context suppression helpers (v4.0.4)
export const suppressFingerprint = (sessionId: string, fingerprint: string): void => {
  const state = sessions.get(sessionId)
  if (!state || state.suppressedFingerprints.includes(fingerprint)) return
  state.suppressedFingerprints = [...state.suppressedFingerprints, fingerprint]
  saveToDisk()
}
export const unsuppressFingerprint = (sessionId: string, fingerprint: string): void => {
  const state = sessions.get(sessionId)
  if (!state) return
  const next = state.suppressedFingerprints.filter((f) => f !== fingerprint)
  if (next.length === state.suppressedFingerprints.length) return
  state.suppressedFingerprints = next
  saveToDisk()
}
export const isFingerprintSuppressed = (sessionId: string, fingerprint: string): boolean =>
  sessions.get(sessionId)?.suppressedFingerprints.includes(fingerprint) ?? false
export const clearSuppressedFingerprints = (sessionId: string): void => {
  const state = sessions.get(sessionId)
  if (!state || state.suppressedFingerprints.length === 0) return
  state.suppressedFingerprints = []
  saveToDisk()
}
export const getSuppressedFingerprints = (sessionId: string): readonly string[] =>
  sessions.get(sessionId)?.suppressedFingerprints ?? []

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
    // Backfill: sessions persisted before U10 have no counter on disk.
    mutationsSinceReport: state.mutationsSinceReport ?? 0,
    validationPassedSinceReport: state.validationPassedSinceReport ?? false,
    // Backfill: sessions persisted before round-context suppression feature have no set on disk.
    suppressedFingerprints: state.suppressedFingerprints ?? [],
    // Backfill: sessions persisted before V3.9 §C/§D have neither slot on disk. panelArmed backfills to
    // null (= not explicitly toggled → follows the global default), NOT false.
    panelArmed: state.panelArmed ?? null,
    // Backfill: sessions persisted before V4.0 have no panelRounds → null (defaults to "single").
    panelRounds: state.panelRounds ?? null,
    activeGoal: state.activeGoal ?? null,
  }
  sessions.set(state.sessionId, normalized)
  return normalized
}

function loadFromDisk() {
  if (!stateDir) return
  try {
    const content = readFileSync(path.join(stateDir, "sessions.json"), "utf8")
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
          PlanStore.setPlanDoc(id, state.plan)
        } catch {
          /* best-effort migration: a store hiccup must not block loading session state */
        }
      }
      sessions.set(id, normalizeState(state))
    }
  } catch {}
}
