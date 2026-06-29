// U1 PlanController (S1 §P0): a runtime plan state machine. This is NOT a second execution loop —
// it is a plan dimension layered onto the existing DeepAgentSessionState + RoundState. The plan doc
// here is the STRUCTURAL artifact (goal/steps/active_step) persisted in the single DocumentStore as
// a `type: "plan"`, `scope: "run:<sessionId>"` document; the runtime LATCH (fresh/stale), the
// stale_reason and the replan_count live on SessionRunState (the hot path the tool gate reads every
// call), so flipping the latch never churns plan-doc versions.
//
// Core principle (docs/38): the runtime DERIVES "the plan is stale" from facts it already observes
// (new user message, tool failure, validation failure, no-progress fingerprint, pack change) — it
// does NOT trust the model to report that it deviated. That is what makes the gate robust on MoE
// models whose self-reporting is unreliable.
import { randomUUID } from "node:crypto"
import type { AgentMode } from "./mode"

// Why the plan went stale. Each value maps 1:1 to a signal the live loop already produces, so the
// latch can be flipped from runtime truth without any model cooperation (S1 U1 §plan_stale 触发源).
export type StaleReason =
  | "user_appended" // a new user message arrived mid-run
  | "tool_failed" // a tool/execution step errored
  | "validation_failed" // recordValidation saw a failing command
  | "no_progress" // the no-progress fingerprint repeated (deepagent-multiround)
  | "pack_changed" // the domain-pack snapshot id changed mid-run

export type PlanLatch = "fresh" | "stale"
export type PlanStepStatus = "pending" | "active" | "done" | "cancelled"

export type PlanStep = {
  readonly step_id: string
  readonly title: string
  readonly status: PlanStepStatus
  // Acceptance criterion for the step. P0 leaves it optional; U9 (hard gate, high+) enforces that a
  // step cannot move to `done` until its acceptance validation ran.
  readonly acceptance?: string | null
  // U4 reserve: a step may be delegated to a subagent; evidence is the subagent's returned summary.
  readonly assigned_agent?: string | null
  readonly evidence?: readonly string[]
}

// The structural plan. Persisted in DocumentStore (type "plan", scope "run:<sessionId>"). Its
// version history IS the plan change history surfaced by U2 — no plan_events.jsonl, no plan.json.
export type PlanDoc = {
  readonly plan_id: string
  readonly session_id: string
  readonly goal: string
  readonly assumptions: readonly string[]
  readonly steps: readonly PlanStep[]
  // null in P0 (coarse-grained latch only); U9 makes it authoritative for high+ per-step binding.
  readonly active_step_id: string | null
  readonly created_at: string
}

// Runtime plan latch carried on SessionRunState. Separate from PlanDoc so the hot path (every tool
// call) reads/writes a tiny value object, not the persisted document.
export type PlanLatchState = {
  readonly plan_id: string | null
  readonly latch: PlanLatch
  readonly stale_reason: StaleReason | null
  readonly replan_count: number
}

export const initialPlanLatch = (planId: string | null = null): PlanLatchState => ({
  plan_id: planId,
  latch: "fresh",
  stale_reason: null,
  replan_count: 0,
})

// Flip to stale (idempotent on reason). Pure: the caller persists. The runtime calls this from the
// five signal points; the model is never asked whether it deviated.
export const markStale = (state: PlanLatchState, reason: StaleReason): PlanLatchState =>
  state.latch === "stale" && state.stale_reason === reason ? state : { ...state, latch: "stale", stale_reason: reason }

// Clear the latch after the plan was updated. Bumps replan_count so the escape hatch can fire if the
// model thrashes (keeps producing a plan that immediately goes stale again).
export const clearStale = (state: PlanLatchState): PlanLatchState =>
  state.latch === "fresh" ? state : { ...state, latch: "fresh", stale_reason: null, replan_count: state.replan_count + 1 }

// Escape hatch (mirrors the existing no-progress -> needs_human pattern): after too many replans we
// STOP forcing the model to update the plan and hand off to a human, instead of looping forever on a
// model that can't produce a stable plan. Default limit 3 (S1 U1).
export const DEFAULT_REPLAN_LIMIT = 3
export const shouldEscapeToHuman = (state: PlanLatchState, limit: number = DEFAULT_REPLAN_LIMIT): boolean =>
  state.replan_count > limit

// general/direct take the lightweight path: the soft gate WARNS but never blocks, so ordinary
// implement/debug/chat tasks are never slowed by the plan machinery (docs/38 §9). high+ get the real
// soft block.
export const isLightweightMode = (mode: AgentMode | string): boolean => mode === "general" || mode === "direct"

// Tool intent classification for the soft gate. Mutating tools (write/edit/patch/shell-mutation) are
// soft-blocked while the plan is stale; read/search/diagnosis and `todowrite` (used to UPDATE the
// plan) always pass — otherwise a stale plan could never be repaired.
const MUTATING_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])
const ALWAYS_ALLOWED_TOOLS = new Set(["read", "grep", "glob", "list", "ls", "search", "todowrite", "task", "webfetch"])

export const isMutatingTool = (toolName: string): boolean => {
  const name = toolName.toLowerCase()
  if (ALWAYS_ALLOWED_TOOLS.has(name)) return false
  if (MUTATING_TOOLS.has(name)) return true
  // bash/shell is mutating UNLESS the caller already classified it read-only (docs/38 §7.2 read-only
  // default for deterministic queries). The payload may carry readOnly:true for `git status` etc.
  if (name === "bash" || name === "shell") return true
  return false
}

// Build a fresh structural plan doc (the model fills goal/steps via the plan tool; this is the
// scaffold). idSlug omitted — DocumentStore assigns the stable id.
export const createPlanDoc = (sessionId: string, goal: string, steps: readonly PlanStep[] = [], assumptions: readonly string[] = []): PlanDoc => ({
  plan_id: `plan_${randomUUID()}`,
  session_id: sessionId,
  goal,
  assumptions,
  steps,
  active_step_id: steps.find((s) => s.status === "active")?.step_id ?? null,
  created_at: new Date().toISOString(),
})

// DocumentStore scope for a session-scoped plan. Reuses the existing run scope — no new scope type.
export const planScope = (sessionId: string): string => `run:${sessionId}`

// Loose input the `plan` tool accepts (machine-read structured, docs/38 §2.1). step_id is optional —
// the model usually omits it and we assign a stable one; status defaults to pending.
export type PlanStepInput = {
  readonly step_id?: string
  readonly title: string
  readonly status?: string
  readonly acceptance?: string | null
  readonly assigned_agent?: string | null
}
export type PlanInput = {
  readonly goal: string
  readonly steps: readonly PlanStepInput[]
  readonly assumptions?: readonly string[]
  readonly active_step_id?: string | null
}

const STEP_STATUSES: ReadonlySet<PlanStepStatus> = new Set(["pending", "active", "done", "cancelled"])
const normStatus = (s: string | undefined): PlanStepStatus => (s && STEP_STATUSES.has(s as PlanStepStatus) ? (s as PlanStepStatus) : "pending")

// Build a PlanDoc from the tool's loose input. Preserves an existing plan_id/created_at when the
// model is UPDATING (re-writing) the plan rather than creating it, so the run-state plan keeps a
// stable identity across edits. Assigns step ids by index when omitted.
export const buildPlanFromInput = (sessionId: string, input: PlanInput, previous?: PlanDoc | null): PlanDoc => {
  const steps: PlanStep[] = input.steps.map((s, i) => ({
    step_id: s.step_id ?? `step_${i + 1}`,
    title: s.title,
    status: normStatus(s.status),
    acceptance: s.acceptance ?? null,
    assigned_agent: s.assigned_agent ?? null,
    evidence: [],
  }))
  const active = input.active_step_id ?? steps.find((s) => s.status === "active")?.step_id ?? null
  return {
    plan_id: previous?.plan_id ?? `plan_${randomUUID()}`,
    session_id: sessionId,
    goal: input.goal,
    assumptions: input.assumptions ?? [],
    steps,
    active_step_id: active,
    created_at: previous?.created_at ?? new Date().toISOString(),
  }
}

// Progress summary for the UI / tool output.
export const planProgress = (plan: PlanDoc): { done: number; total: number } => ({
  done: plan.steps.filter((s) => s.status === "done").length,
  total: plan.steps.length,
})

// --- U9 hard gate (S1 §P2) --------------------------------------------------------------------
// The hard gate is the strong-mode (high/xhigh/max) version of the soft gate. It adds per-step
// binding (a mutating tool must map to an active step) and a completion_report requirement at
// finalize. general/direct NEVER see the hard gate (lightweight path, docs/38 §9). To keep MoE
// failure modes graceful, binding violations escalate by tier: high warns + auto-replans, xhigh/max
// hard-block. The replan escape hatch (shouldEscapeToHuman) still applies so the hard gate can never
// deadlock a weak model.
export type GateStrength = "off" | "soft" | "hard"

// general/direct -> off (handled by isLightweightMode at the soft layer); high -> hard-but-lenient
// (warn on binding miss); xhigh/max -> hard-strict; ultra -> hard-strict (autonomous, must be tight).
export const hardGateEnabled = (mode: AgentMode | string): boolean =>
  mode === "high" || mode === "xhigh" || mode === "max" || mode === "ultra"

// xhigh/max/ultra hard-block on a binding violation; high warns (and the runtime auto-replans).
export const hardGateStrict = (mode: AgentMode | string): boolean =>
  mode === "xhigh" || mode === "max" || mode === "ultra"

// A mutating tool is "bound" when the plan has an active step. Per-step binding is only meaningful
// once the model declared which step it's on (active_step_id). Missing active step on a mutating
// tool under a strict hard gate -> block; under high -> warn.
export const hasActiveStep = (plan: PlanDoc | null): boolean => plan?.active_step_id != null

// Before a step may move to `done` under the hard gate, its acceptance criterion (if declared) must
// have a corresponding passing validation. The runtime supplies whether validation passed; this is
// the pure predicate.
export const stepCanComplete = (step: PlanStep, validationPassed: boolean): boolean =>
  step.acceptance == null || step.acceptance.trim() === "" || validationPassed

// completion_report (S1 §U9): generated at finalize for high+ modes. Summarizes which steps were
// done/cancelled and the evidence. Required before finalize under the hard gate (the stop gate
// blocks finalize if a high+ run has no report). general never needs it.
export type CompletionReport = {
  readonly plan_id: string
  readonly goal: string
  readonly done: readonly string[] // step titles completed
  readonly cancelled: readonly string[] // step titles cancelled
  readonly outstanding: readonly string[] // step titles still pending/active
  readonly evidence: readonly string[]
  readonly complete: boolean // true only when nothing outstanding
}

export const buildCompletionReport = (plan: PlanDoc): CompletionReport => {
  const done = plan.steps.filter((s) => s.status === "done").map((s) => s.title)
  const cancelled = plan.steps.filter((s) => s.status === "cancelled").map((s) => s.title)
  const outstanding = plan.steps.filter((s) => s.status === "pending" || s.status === "active").map((s) => s.title)
  const evidence = plan.steps.flatMap((s) => s.evidence ?? [])
  return { plan_id: plan.plan_id, goal: plan.goal, done, cancelled, outstanding, evidence, complete: outstanding.length === 0 }
}
