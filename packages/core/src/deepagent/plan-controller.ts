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
import { classifyCommand } from "./command-intent"

// Why the plan went stale. Each value maps 1:1 to a signal the live loop already produces, so the
// latch can be flipped from runtime truth without any model cooperation (S1 U1 §plan_stale 触发源).
export type StaleReason =
  | "user_appended" // a new user message arrived mid-run
  | "tool_failed" // a tool/execution step errored
  | "validation_failed" // recordValidation saw a failing command
  | "no_progress" // the no-progress fingerprint repeated (deepagent-multiround)
  | "pack_changed" // the domain-pack snapshot id changed mid-run
  | "diagnostics_error" // L4 (S1-v3.4): post-edit LSP diagnostics surfaced an error (high+ only)

export type PlanLatch = "fresh" | "stale"
// U10: `blocked` is an HONEST terminal state for a step the model cannot finish (missing access,
// external dependency, ambiguous requirement). It is treated as RESOLVED for completion (so it does
// not deadlock finalize the way pending/active do), but it forces the run to needs_human at finalize
// so the operator sees WHY the plan could not be fully executed — this is the "or explain the
// blocker" escape hatch that keeps the model from marking a step falsely `done` to satisfy the gate.
export type PlanStepStatus = "pending" | "active" | "done" | "cancelled" | "blocked"

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
  // U10: why a step is `blocked` (or any short note the model attaches). Surfaced in the completion
  // report so the needs_human handoff explains the blocker instead of just naming the step.
  readonly note?: string | null
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
  // Runtime-driven grace counter (U1 anti-deadlock). Incremented every time the gate BLOCKS a
  // mutating tool while the plan is stale; reset to 0 whenever forward progress happens (the plan is
  // updated with a real status change, or a mutating tool actually executes). Unlike replan_count —
  // which only advances when the MODEL cooperates by calling the plan tool — this advances from the
  // runtime alone, so the grace release can fire even against a model that never repairs the plan.
  readonly consecutive_blocks: number
}

export const initialPlanLatch = (planId: string | null = null): PlanLatchState => ({
  plan_id: planId,
  latch: "fresh",
  stale_reason: null,
  replan_count: 0,
  consecutive_blocks: 0,
})

// Flip to stale (idempotent on reason). Pure: the caller persists. The runtime calls this from the
// five signal points; the model is never asked whether it deviated.
export const markStale = (state: PlanLatchState, reason: StaleReason): PlanLatchState =>
  state.latch === "stale" && state.stale_reason === reason ? state : { ...state, latch: "stale", stale_reason: reason }

// Clear the latch after the plan was updated. Bumps replan_count so the escape hatch can fire if the
// model thrashes (keeps producing a plan that immediately goes stale again). Also resets the runtime
// grace counter, since updating the plan is genuine forward progress.
export const clearStale = (state: PlanLatchState): PlanLatchState =>
  state.latch === "fresh"
    ? state
    : { ...state, latch: "fresh", stale_reason: null, replan_count: state.replan_count + 1, consecutive_blocks: 0 }

// U1 anti-deadlock: record that the gate just BLOCKED a mutating tool on a stale plan. Advances the
// runtime grace counter. Pure; the caller persists.
export const recordGateBlock = (state: PlanLatchState): PlanLatchState => ({
  ...state,
  consecutive_blocks: state.consecutive_blocks + 1,
})

// U1 anti-deadlock: forward progress happened (a mutating tool executed), so the model is not stuck
// hammering a blocked gate. Reset the grace counter without touching the latch/replan bookkeeping.
export const resetGateBlocks = (state: PlanLatchState): PlanLatchState =>
  state.consecutive_blocks === 0 ? state : { ...state, consecutive_blocks: 0 }

// Escape hatch (mirrors the existing no-progress -> needs_human pattern): after too many replans we
// STOP forcing the model to update the plan and hand off to a human, instead of looping forever on a
// model that can't produce a stable plan. Default limit 3 (S1 U1). This is the MODEL-cooperative
// hatch: it only advances when the model actually re-plans.
export const DEFAULT_REPLAN_LIMIT = 3
export const shouldEscapeToHuman = (state: PlanLatchState, limit: number = DEFAULT_REPLAN_LIMIT): boolean =>
  state.replan_count > limit

// U1 anti-deadlock grace release: after the gate has blocked the SAME stale plan this many times
// without any forward progress, stop blocking and let the next mutating tool through (with a strong
// reminder injected by the caller). This is the RUNTIME-driven hatch — it fires without any model
// cooperation, so a model that never repairs the plan (e.g. one that degrades to giving the user
// manual commands instead of calling the plan tool) can never be permanently denied its tools. This
// is the direct fix for the production deadlock where 280 consecutive bash calls were blocked.
export const DEFAULT_GRACE_BLOCK_LIMIT = 3
export const shouldGraceRelease = (state: PlanLatchState, limit: number = DEFAULT_GRACE_BLOCK_LIMIT): boolean =>
  state.consecutive_blocks >= limit

// general/direct take the lightweight path: the soft gate WARNS but never blocks, so ordinary
// implement/debug/chat tasks are never slowed by the plan machinery (docs/38 §9). high+ get the real
// soft block.
export const isLightweightMode = (mode: AgentMode | string): boolean => mode === "general" || mode === "direct"

// Tool intent classification for the soft gate. Mutating tools (write/edit/patch/shell-mutation) are
// soft-blocked while the plan is stale; read/search/diagnosis tools always pass — otherwise a stale
// plan could never be repaired (inspect first, then call `plan` to update, then continue). The
// `plan` tool itself is never mutating, so it always passes the gate.
const MUTATING_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])
const ALWAYS_ALLOWED_TOOLS = new Set(["read", "grep", "glob", "list", "ls", "search", "task", "webfetch"])

export const isMutatingTool = (toolName: string, command?: string | null): boolean => {
  const name = toolName.toLowerCase()
  if (ALWAYS_ALLOWED_TOOLS.has(name)) return false
  if (MUTATING_TOOLS.has(name)) return true
  // bash/shell is mutating UNLESS the command is provably read-only (docs/38 §7.2 read-only default
  // for deterministic queries). A read-only shell command (ls/cat/grep/git status/curl probe/…) is
  // the agent's eyes: it must NEVER be blocked by the plan gate, otherwise a stale plan could never
  // be diagnosed and repaired. The classifier is fail-safe — any ambiguity resolves to mutating —
  // so a missing/empty command (nothing to classify) is treated as mutating.
  if (name === "bash" || name === "shell") {
    if (command == null || command.trim() === "") return true
    return classifyCommand(command) === "mutating"
  }
  return false
}

// Build a fresh structural plan doc (the model fills goal/steps via the plan tool; this is the
// scaffold). idSlug omitted — DocumentStore assigns the stable id.
export const createPlanDoc = (
  sessionId: string,
  goal: string,
  steps: readonly PlanStep[] = [],
  assumptions: readonly string[] = [],
): PlanDoc => ({
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
  readonly note?: string | null
}
export type PlanInput = {
  readonly goal: string
  readonly steps: readonly PlanStepInput[]
  readonly assumptions?: readonly string[]
  readonly active_step_id?: string | null
}

const STEP_STATUSES: ReadonlySet<PlanStepStatus> = new Set(["pending", "active", "done", "cancelled", "blocked"])
const STATUS_ALIASES: Record<string, PlanStepStatus> = {
  completed: "done",
  in_progress: "active",
  in_review: "active",
  skipped: "cancelled",
  stuck: "blocked",
}
const normStatus = (s: string | undefined): PlanStepStatus => {
  const status = s?.trim().toLowerCase()
  if (!status) return "pending"
  if (STEP_STATUSES.has(status as PlanStepStatus)) return status as PlanStepStatus
  return STATUS_ALIASES[status] ?? "pending"
}

// Build a PlanDoc from the tool's loose input. Preserves an existing plan_id/created_at when the
// model is UPDATING (re-writing) the plan rather than creating it, so the run-state plan keeps a
// stable identity across edits. Assigns step ids by index when omitted. Evidence is runtime-owned
// (never taken from tool input): a step carries forward the evidence recorded on the matching
// previous step so re-writing the plan does not wipe accumulated proof.
export const buildPlanFromInput = (sessionId: string, input: PlanInput, previous?: PlanDoc | null): PlanDoc => {
  const priorById = new Map((previous?.steps ?? []).map((s) => [s.step_id, s] as const))
  const steps: PlanStep[] = input.steps.map((s, i) => {
    const stepId = s.step_id ?? `step_${i + 1}`
    const prior = priorById.get(stepId)
    return {
      step_id: stepId,
      title: s.title,
      status: normStatus(s.status),
      acceptance: s.acceptance ?? null,
      assigned_agent: s.assigned_agent ?? null,
      evidence: prior?.evidence ?? [],
      note: s.note ?? prior?.note ?? null,
    }
  })
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
  readonly blocked: readonly string[] // U10: step titles blocked, each with its note if present
  readonly outstanding: readonly string[] // step titles still pending/active
  readonly evidence: readonly string[]
  readonly complete: boolean // true only when nothing outstanding
}

export const buildCompletionReport = (plan: PlanDoc): CompletionReport => {
  const done = plan.steps.filter((s) => s.status === "done").map((s) => s.title)
  const cancelled = plan.steps.filter((s) => s.status === "cancelled").map((s) => s.title)
  // U10: a blocked step is RESOLVED for the purpose of `complete` (it will never finish on its own,
  // so leaving it outstanding would deadlock finalize behind the escape hatch). Its note travels with
  // the title so the needs_human suggestion explains the blocker.
  const blocked = plan.steps
    .filter((s) => s.status === "blocked")
    .map((s) => (s.note && s.note.trim() !== "" ? `${s.title} (${s.note.trim()})` : s.title))
  const outstanding = plan.steps.filter((s) => s.status === "pending" || s.status === "active").map((s) => s.title)
  const evidence = plan.steps.flatMap((s) => s.evidence ?? [])
  return {
    plan_id: plan.plan_id,
    goal: plan.goal,
    done,
    cancelled,
    blocked,
    outstanding,
    evidence,
    complete: outstanding.length === 0,
  }
}

// U10: true when the plan is complete BUT some step is blocked. Finalize is allowed (not deadlocked),
// yet the run must route to needs_human so a human sees the blocker rather than a clean "done".
export const hasBlockedSteps = (plan: PlanDoc | null): boolean =>
  plan != null && plan.steps.some((s) => s.status === "blocked")

// --- U10 step-reporting: status diff, snapshot, nudge, evidence --------------------------------
// These power the "execute a step -> report a step -> update a step" closed loop. The runtime NEVER
// infers a step is done; it only (a) re-surfaces the model's own plan each turn so it can report,
// (b) nudges (soft, never blocks) when many edits happened without a plan update, and (c) computes
// the status DIFF from before/after itself so the summary can't drift from the model's prose.

const STATUS_MARK: Record<PlanStepStatus, string> = {
  done: "x",
  cancelled: "-",
  blocked: "!",
  active: ">",
  pending: " ",
}

// A single status transition, computed by the runtime from prev vs next plan (not model self-report).
export type StepStatusChange = {
  readonly step_id: string
  readonly title: string
  readonly from: PlanStepStatus | null // null when the step is newly added
  readonly to: PlanStepStatus
}

// Diff two plan docs by step_id. Reports steps whose status changed (or that were newly added). Used
// for the tool-output summary and the plan.updated event so logs/UI show WHAT changed, not just the
// new state. A removed step is not reported (the model chose to drop it; cancelled is the honest path).
export const diffStepStatuses = (previous: PlanDoc | null | undefined, next: PlanDoc): readonly StepStatusChange[] => {
  const priorById = new Map((previous?.steps ?? []).map((s) => [s.step_id, s] as const))
  const changes: StepStatusChange[] = []
  for (const s of next.steps) {
    const prior = priorById.get(s.step_id)
    if (!prior) {
      changes.push({ step_id: s.step_id, title: s.title, from: null, to: s.status })
    } else if (prior.status !== s.status) {
      changes.push({ step_id: s.step_id, title: s.title, from: prior.status, to: s.status })
    }
  }
  return changes
}

// True when a plan write actually moved at least one step's status (or added a step). Used to reset
// the "mutations since last report" counter ONLY on a real status change — a no-op plan re-write
// (same statuses) must NOT clear the nudge, otherwise the model could silence the reminder with an
// empty update ("report theater").
export const planStatusesChanged = (previous: PlanDoc | null | undefined, next: PlanDoc): boolean =>
  diffStepStatuses(previous, next).length > 0

// Render a status transition as "Title: from→to" (from omitted for a new step).
export const formatStepChange = (c: StepStatusChange): string =>
  c.from === null ? `${c.title}: →${c.to}` : `${c.title}: ${c.from}→${c.to}`

// Compact, constant-size plan snapshot re-injected into context each turn (high+ only) so the model
// can SEE its own checklist and report against it. One line per step; goal + progress header. We
// deliberately omit acceptance/assumptions/evidence to keep this small (it is re-injected every
// turn, so it must not grow with history).
export const renderPlanSnapshot = (plan: PlanDoc): string => {
  const { done, total } = planProgress(plan)
  const active = plan.steps.find((s) => s.step_id === plan.active_step_id) ?? null
  const lines = plan.steps.map((s) => `[${STATUS_MARK[s.status]}] ${s.title}`)
  const header = `Current plan (${done}/${total} done) — goal: ${plan.goal}`
  const activeLine = active ? `Active step: ${active.title}` : "No step is marked active."
  return `${header}\n${lines.join("\n")}\n${activeLine}`
}

// Progress-nudge budget (the COUNT BACKSTOP of the hybrid trigger). This is deliberately NOT the
// primary signal: raw edit count conflates "the step is genuinely large" with "the model forgot to
// report". The count only guarantees the model is reminded eventually when no semantic boundary
// fires (e.g. a workspace with no validation configured). It scales by mode so stricter modes are
// reminded sooner: xhigh/max/ultra (autonomous, must stay tight) at 4; high (lenient) at 6.
export const NUDGE_MUTATION_STRICT = 4
export const NUDGE_MUTATION_LENIENT = 6
// Back-compat alias (older callers/tests referenced a single constant). Prefer nudgeMutationThreshold.
export const NUDGE_MUTATION_THRESHOLD = NUDGE_MUTATION_STRICT

export const nudgeMutationThreshold = (mode: AgentMode | string): number =>
  hardGateStrict(mode) ? NUDGE_MUTATION_STRICT : NUDGE_MUTATION_LENIENT

// Why the nudge fired this turn — lets the caller phrase the reminder honestly.
export type NudgeTrigger = "validation_passed" | "mutation_backstop" | null

// Hybrid progress-report trigger. Fires ONLY when the plan still has unresolved work
// (pending/active) — a finished plan is never nagged. Given that, it fires on either:
//   (a) SEMANTIC (primary): a validation just went (back) to passing since the last plan update, and
//       the model made at least one edit since — a natural "a step probably just finished" moment
//       the runtime already observes. Precise: it aligns to real completion boundaries, not a count.
//   (b) COUNT BACKSTOP: >= mode-scaled mutating calls since the last status change — the catch-all
//       for runs with no validation signal, so the model is always reminded eventually.
// Advisory only: the caller injects a reminder, never a block (avoids report theater / deadlock).
export const nudgeTrigger = (
  plan: PlanDoc | null,
  input: { mutationsSinceReport: number; validationPassedSinceReport: boolean; mode: AgentMode | string },
): NudgeTrigger => {
  if (plan == null) return null
  const hasOutstanding = plan.steps.some((s) => s.status === "pending" || s.status === "active")
  if (!hasOutstanding) return null
  // Semantic first: a fresh pass + at least one edit since last report is the strongest "step done"
  // signal. Requiring >=1 mutation avoids nagging when the pass merely confirms an already-reported
  // step (no new work happened since the last plan update).
  if (input.validationPassedSinceReport && input.mutationsSinceReport >= 1) return "validation_passed"
  if (input.mutationsSinceReport >= nudgeMutationThreshold(input.mode)) return "mutation_backstop"
  return null
}

// Back-compat boolean wrapper. New callers should use nudgeTrigger (it also says WHY).
export const shouldNudgeReport = (
  plan: PlanDoc | null,
  mutationsSinceReport: number,
  opts?: { validationPassedSinceReport?: boolean; mode?: AgentMode | string },
): boolean =>
  nudgeTrigger(plan, {
    mutationsSinceReport,
    validationPassedSinceReport: opts?.validationPassedSinceReport ?? false,
    // Default to the strict threshold when no mode is supplied (matches the old constant).
    mode: opts?.mode ?? "max",
  }) !== null

export const PROGRESS_NUDGE = (trigger: NudgeTrigger, mutations: number): string => {
  const lead =
    trigger === "validation_passed"
      ? `A validation just passed and you have made ${mutations} change(s) since your last plan update.`
      : `You have made ${mutations} file/command changes without updating your plan.`
  return `${lead} If the active step is complete, call the \`plan\` tool now: mark it \`done\`, set the next step \`active\`. If you are stuck, mark the step \`blocked\` with a note. Do not batch several finished steps into one late update.`
}

// U10 / P2-E: attach runtime evidence to steps that JUST moved to `done`. The model reports the
// status; the runtime supplies the proof (latest validation summary) so the completion report is
// backed by facts, not the model's word. Returns a new plan (pure); only newly-done steps that have
// no evidence yet receive the summary, so re-writes don't duplicate it.
export const attachEvidenceToNewlyDone = (
  previous: PlanDoc | null | undefined,
  next: PlanDoc,
  evidenceSummary: string | null,
): PlanDoc => {
  if (!evidenceSummary || evidenceSummary.trim() === "") return next
  const priorById = new Map((previous?.steps ?? []).map((s) => [s.step_id, s] as const))
  let changed = false
  const steps = next.steps.map((s) => {
    const prior = priorById.get(s.step_id)
    const justDone = s.status === "done" && prior?.status !== "done"
    if (justDone && (s.evidence == null || s.evidence.length === 0)) {
      changed = true
      return { ...s, evidence: [evidenceSummary] }
    }
    return s
  })
  return changed ? { ...next, steps } : next
}


