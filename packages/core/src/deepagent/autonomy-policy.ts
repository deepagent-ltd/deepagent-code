export * as AutonomyPolicy from "./autonomy-policy"

import { AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from "../im/mention-parser"
import type { AgentDescriptor } from "../im/mention-parser"

// V4.0 §D1 — the autonomy-level POLICY. This is a PURE, deterministic decision function: given an
// agent's configured autonomy ceiling and the autonomy level an action REQUIRES to execute, it decides
// whether the action is allowed and — when allowed — which Human Gate must be enforced before/after the
// action runs. It reads NOTHING at runtime; no Effect, no DB, no IO. The wiring in deepagent-code
// resolves the agent descriptor + the action's required level, calls `decide`, and enforces the gate.
//
// LAYERING: lives in `core` and imports only the AutonomyLevel schema literals from mention-parser
// (§C1/§D). Everything else is derived from the §D1 table below, so this module stays unit-testable.
//
// §D1 table (docs/deepagentcore-v4.0.md L294-303), mapped to GATE_FOR_LEVEL:
//   Level 0 — read context / explain / suggest         → gate: none
//   Level 1 — read-only diagnostics / tests / format   → gate: post_hoc_log       (事后日志)
//   Level 2 — low-risk edits / add tests / fix lint     → gate: auto_pr_or_digest  (自动 PR 或每日摘要)
//   Level 3 — bug fixes / limited code changes          → gate: pr_approval        (PR 审批)
//   Level 4 — architecture refactor / multi-module      → gate: plan_and_pr_approval (方案审批 + PR 审批)
//   Level 5 — tech direction / large deletions          → gate: suggestion_only    (仅建议)
//
// KEY RULE (L303 — "Agent 配置不能把风险等级降级；只能收紧"): an agent's configured autonomy is a
// CEILING that can only TIGHTEN. An action requiring a level ABOVE the ceiling is refused
// (exceeds_ceiling); it can NEVER be escalated to run. An agent capable of MORE than an action requires
// still runs that action under the ACTION's own (lower) gate — capability does not relax the gate.
//
// LEVEL 5 CONTRACT ("仅建议 / suggestion_only"): a level_5 action is NEVER auto-executed. When the
// ceiling is below level_5, a level_5 action is refused (exceeds_ceiling). When the ceiling IS level_5,
// decide() returns `{ allowed: true, gate: "suggestion_only" }` — but "allowed" here means "the agent may
// PRODUCE A SUGGESTION". The CALLER MUST treat a `suggestion_only` gate as "emit a suggestion, do not
// execute the action". No path in this module ever green-lights auto-execution of a level_5 action.

// Ordinal rank for each level, for ordering comparisons. level_0=0 … level_5=5.
export const LEVEL_RANK: Record<AutonomyLevel, number> = {
  level_0: 0,
  level_1: 1,
  level_2: 2,
  level_3: 3,
  level_4: 4,
  level_5: 5,
}

// The KIND of Human Gate a level demands per the §D1 table. One literal per row.
export type HumanGate =
  | "none"
  | "post_hoc_log"
  | "auto_pr_or_digest"
  | "pr_approval"
  | "plan_and_pr_approval"
  | "suggestion_only"

// §D1 mapping: each autonomy level → the Human Gate that must be enforced for an action at that level.
export const GATE_FOR_LEVEL: Record<AutonomyLevel, HumanGate> = {
  level_0: "none",
  level_1: "post_hoc_log",
  level_2: "auto_pr_or_digest",
  level_3: "pr_approval",
  level_4: "plan_and_pr_approval",
  level_5: "suggestion_only",
}

// The autonomy level an ACTION requires to execute — i.e. the action "needs at least level_N". Reuses
// the AutonomyLevel literals: an action's risk IS the minimum level a capable agent must be at.
export type ActionRisk = AutonomyLevel

// The gate demanded by a given level. Small indirection so callers resolve gates in one place.
export const gateForLevel = (level: AutonomyLevel): HumanGate => GATE_FOR_LEVEL[level]

export type AutonomyDecision =
  // action within the ceiling → allowed; `gate` is the ACTION's own gate to enforce (see decide).
  | { readonly allowed: true; readonly gate: HumanGate }
  // action requires more autonomy than the agent's ceiling → refused; carries both levels for the trace.
  | {
      readonly allowed: false
      readonly reason: "exceeds_ceiling"
      readonly ceiling: AutonomyLevel
      readonly required: AutonomyLevel
    }

/**
 * §D1 — the pure autonomy decision.
 *
 *   - If the action requires a rank ABOVE the agent's ceiling → NOT allowed (`exceeds_ceiling`). This
 *     enforces "config can only tighten": a level_2-capped agent can never perform a level_3 action.
 *   - Otherwise allowed, and `gate` = the gate of the ACTION's required level (GATE_FOR_LEVEL[actionRequires]),
 *     NOT the ceiling's gate — a level_4 agent doing a level_2 edit still only owes the level_2 gate.
 *   - level_5 ("仅建议 / suggestion_only"): a level_5 action is never auto-executed. If ceiling < 5 it is
 *     refused; if ceiling IS level_5 it returns `{ allowed: true, gate: "suggestion_only" }`, which the
 *     CALLER must treat as "produce a suggestion, do not execute". `allowed:true` here == "may suggest".
 */
export const decide = (input: {
  readonly agentCeiling: AutonomyLevel
  readonly actionRequires: AutonomyLevel
}): AutonomyDecision => {
  const ceiling = input.agentCeiling
  const required = input.actionRequires

  if (LEVEL_RANK[required] > LEVEL_RANK[ceiling]) {
    return { allowed: false, reason: "exceeds_ceiling", ceiling, required }
  }

  return { allowed: true, gate: GATE_FOR_LEVEL[required] }
}

// The agent's autonomy ceiling, defaulting to the conservative DEFAULT_AUTONOMY_LEVEL (level_0 — fully
// manual) when unset. Keeps the default resolution in one place.
export const resolveCeiling = (descriptor: Pick<AgentDescriptor, "autonomy">): AutonomyLevel =>
  descriptor.autonomy ?? DEFAULT_AUTONOMY_LEVEL
