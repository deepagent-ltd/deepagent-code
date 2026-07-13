export * as TaskPartitioner from "./task-partitioner"

import { DeepAgentEvent } from "./deepagent-event"
import type { AgentDescriptor } from "../im/mention-parser"
import { AutonomyPolicy } from "./autonomy-policy"
import { Identifier } from "../util/identifier"

// V4.0 §C2 — the Task Partitioner. A PURE decomposition: given an event and the available agents, it
// splits a complex event into an ordered set of subtasks, each DECLARING (§C2 contract) its
// dependencies, file scope, required capabilities, and approval level. It does NOT run anything — the
// Multi-Agent Runtime (deepagent-code) takes this plan and schedules the subtasks (respecting deps +
// the Conflict Arbiter). Kept pure (no Effect/DB) so decomposition is deterministic + unit-testable.
//
// The mapping from event → subtasks is RULE-DRIVEN (a declarative table keyed by event type), so new
// event kinds add a rule rather than code. A subtask names its agent by REQUIRED CAPABILITY, not a
// concrete agent id — the runtime binds a capable agent from the registry at schedule time (so the plan
// survives registry changes). §C2 examples encoded as the default rules:
//   ci.failure     → CodeFix (code_edit) then TestAgent (test_run), test depends on the fix.
//   pr.comment(perf)→ Perf analyze → Code change → Review, a linear pipeline.
//   monitor.alert  → Diagnosis (locate) then CodeFix (propose), propose depends on diagnosis.
//
// LAYERING: `core`. No runtime imports. Reuses AutonomyPolicy for the per-subtask approval level.

// A subtask id — `tsk_` prefix, ascending-monotonic (stable ordering for debugging).
export const newTaskID = (at?: number): string => "tsk_" + Identifier.create(false, at)

// One decomposed unit of work. `dependsOn` references other subtasks BY their `id` within the same
// partition (a DAG; the runtime topologically schedules). `capability` is what the executing agent must
// have (§C2 "所需能力"). `fileScope` is the declared write scope (§C2 "文件范围" — feeds the Conflict
// Arbiter's branch/lock isolation). `requiredAutonomy` is the minimum autonomy level to execute it
// (§C2 "审批等级" → §D gate).
export interface Subtask {
  readonly id: string
  readonly capability: string
  // human-facing intent, e.g. "fix failing tests", "add regression test".
  readonly intent: string
  readonly dependsOn: ReadonlyArray<string>
  // declared write scope: glob-ish paths this subtask expects to modify (may be empty = unknown/broad).
  readonly fileScope: ReadonlyArray<string>
  readonly requiredAutonomy: AutonomyPolicy.ActionRisk
}

export interface Partition {
  readonly event: DeepAgentEvent.Event
  readonly subtasks: ReadonlyArray<Subtask>
}

// A partition RULE step: a capability + intent + which prior steps (by index within the rule) it
// depends on + its autonomy requirement. `fileScope` is derived from the event payload by `scopeOf`.
interface RuleStep {
  readonly capability: string
  readonly intent: string
  readonly dependsOnIdx: ReadonlyArray<number>
  readonly requiredAutonomy: AutonomyPolicy.ActionRisk
}

// Matches an event type (exact or `prefix.*`, mirroring EventRouter.matches semantics) to an ordered
// list of rule steps.
interface PartitionRule {
  readonly match: string
  readonly steps: ReadonlyArray<RuleStep>
}

const matchesType = (pattern: string, eventType: string): boolean => {
  if (pattern === eventType || pattern === "*") return true
  if (pattern.endsWith(".*")) return eventType.startsWith(pattern.slice(0, -1))
  return false
}

// §C2 default decomposition rules. Ordered; the FIRST matching rule wins. Autonomy levels follow §D:
// analysis/diagnosis = level_1 (read-only), edits/tests/lint = level_2 (low-risk), review = level_1.
export const DEFAULT_RULES: ReadonlyArray<PartitionRule> = [
  {
    match: "ci.failure",
    steps: [
      { capability: "code_edit", intent: "fix the failing build/tests", dependsOnIdx: [], requiredAutonomy: "level_2" },
      { capability: "test_run", intent: "add/verify regression tests", dependsOnIdx: [0], requiredAutonomy: "level_2" },
    ],
  },
  {
    match: "pr.comment",
    steps: [
      { capability: "analyze", intent: "analyze the requested change", dependsOnIdx: [], requiredAutonomy: "level_1" },
      { capability: "code_edit", intent: "implement the change", dependsOnIdx: [0], requiredAutonomy: "level_2" },
      { capability: "review", intent: "review the change", dependsOnIdx: [1], requiredAutonomy: "level_1" },
    ],
  },
  {
    match: "monitor.alert",
    steps: [
      { capability: "diagnose", intent: "locate the root cause", dependsOnIdx: [], requiredAutonomy: "level_1" },
      { capability: "code_edit", intent: "propose a fix", dependsOnIdx: [0], requiredAutonomy: "level_2" },
    ],
  },
  {
    // A push → read-only review pass (§A1 CodeReviewAgent covers `review`). level_1 (no edits). Without
    // this rule git.push fell through to fallbackStep()'s "handle" capability, which no built-in declares
    // → no_capable_agent. Emitting the concrete `review` capability lets CodeReviewAgent bind.
    match: "git.push",
    steps: [{ capability: "review", intent: "review the pushed changes", dependsOnIdx: [], requiredAutonomy: "level_1" }],
  },
  {
    // A scheduled scan → read-only maintenance analysis (§A1 MaintenanceAgent covers `maintain`). level_1.
    match: "schedule.scan",
    steps: [
      { capability: "maintain", intent: "run the scheduled maintenance scan", dependsOnIdx: [], requiredAutonomy: "level_1" },
    ],
  },
  {
    // An explicit repair request → same fix→test DAG as ci.failure (§A1 CodeFixAgent covers both caps).
    match: "ci.repair.requested",
    steps: [
      { capability: "code_edit", intent: "apply the requested repair", dependsOnIdx: [], requiredAutonomy: "level_2" },
      { capability: "test_run", intent: "verify the repair with tests", dependsOnIdx: [0], requiredAutonomy: "level_2" },
    ],
  },
]

// A single-subtask fallback for events with no matching rule: one generic handler subtask requiring the
// conservative level_0 (context/suggest only), so an unknown event never silently escalates.
const fallbackStep = (): RuleStep => ({
  capability: "handle",
  intent: "handle the event",
  dependsOnIdx: [],
  requiredAutonomy: "level_0",
})

// Derive the declared file scope from the event payload if it carries one. The bus payload is Unknown;
// we defensively read a `files: string[]` field when present (producers of git/ci/pr events include it).
export const scopeOf = (event: DeepAgentEvent.Event): ReadonlyArray<string> => {
  const payload = event.payload
  if (payload && typeof payload === "object" && "files" in payload) {
    const files = (payload as { files?: unknown }).files
    if (Array.isArray(files) && files.every((f) => typeof f === "string")) return files as string[]
  }
  return []
}

/**
 * §C2 — decompose an event into a subtask DAG. `rules` defaults to DEFAULT_RULES; pass a custom table
 * to extend. The returned subtasks preserve rule order; `dependsOn` holds the concrete ids of the
 * referenced earlier subtasks.
 *
 * IDs: by default each subtask gets a fresh ascending id (`idAt` injects the clock for tests). Pass
 * `stableIDPrefix` to make ids DETERMINISTIC — `${prefix}:${stepIndex}` — so re-partitioning the SAME
 * event (e.g. the dispatcher's retry pump re-driving a nacked delivery) yields identical subtask ids.
 * The Multi-Agent Runtime uses `event.id` as the prefix so coordination-event idempotency keys are
 * stable across retries (no duplicate agent.task.* / duplicate execution).
 */
export const partition = (
  event: DeepAgentEvent.Event,
  options?: { rules?: ReadonlyArray<PartitionRule>; idAt?: number; stableIDPrefix?: string },
): Partition => {
  const rules = options?.rules ?? DEFAULT_RULES
  const rule = rules.find((r) => matchesType(r.match, event.type))
  const steps = rule ? rule.steps : [fallbackStep()]
  const fileScope = scopeOf(event)

  // assign ids first so dependsOnIdx can resolve to concrete ids. A stable prefix makes them
  // deterministic per (event, step) for idempotent re-dispatch.
  const ids = steps.map((_, i) =>
    options?.stableIDPrefix != null
      ? `tsk_${options.stableIDPrefix}:${i}`
      : newTaskID(options?.idAt != null ? options.idAt + i : undefined),
  )
  const subtasks: Subtask[] = steps.map((step, i) => ({
    id: ids[i],
    capability: step.capability,
    intent: step.intent,
    // VALIDATE deps: every dependency must reference a STRICTLY EARLIER step (0 <= idx < i). This makes
    // the DAG acyclic + topologically sorted BY CONSTRUCTION — a custom rule (the documented extension
    // path) can't smuggle in a forward ref (dangling id), an out-of-range idx, or a cycle that would
    // deadlock the runtime's dependency scheduler. Throws on violation rather than emitting a broken plan.
    dependsOn: step.dependsOnIdx.map((idx) => {
      if (!Number.isInteger(idx) || idx < 0 || idx >= i) {
        throw new Error(
          `TaskPartitioner: rule for "${event.type}" step ${i} has invalid dependsOnIdx ${idx} (must be an earlier step index 0..${i - 1})`,
        )
      }
      return ids[idx]
    }),
    fileScope,
    requiredAutonomy: step.requiredAutonomy,
  }))

  return { event, subtasks }
}

// Which available agents can execute a subtask (declare its required capability). Returns them in
// registry order; empty ⇒ the runtime must block the subtask (agent.task.blocked, no capable agent).
export const capableAgents = (
  subtask: Subtask,
  agents: ReadonlyArray<AgentDescriptor>,
): ReadonlyArray<AgentDescriptor> => agents.filter((a) => (a.capabilities ?? []).includes(subtask.capability))
