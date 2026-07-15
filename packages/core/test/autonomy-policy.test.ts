import { describe, expect, test } from "bun:test"
import { AutonomyPolicy } from "@deepagent-code/core/deepagent/autonomy-policy"
import type { AutonomyLevel } from "@deepagent-code/core/im/mention-parser"

// AutonomyPolicy.decide is a PURE function — no Effect/DB, so these are plain unit tests.

const LEVELS: ReadonlyArray<AutonomyLevel> = [
  "level_0",
  "level_1",
  "level_2",
  "level_3",
  "level_4",
  "level_5",
]

describe("AutonomyPolicy.LEVEL_RANK", () => {
  test("levels rank 0..5 in ascending order", () => {
    expect(LEVELS.map((l) => AutonomyPolicy.LEVEL_RANK[l])).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe("AutonomyPolicy.GATE_FOR_LEVEL", () => {
  test("§D1 table: each level maps to its Human Gate", () => {
    expect(AutonomyPolicy.GATE_FOR_LEVEL).toEqual({
      level_0: "none",
      level_1: "post_hoc_log",
      level_2: "auto_pr_or_digest",
      level_3: "pr_approval",
      level_4: "plan_and_pr_approval",
      level_5: "suggestion_only",
    })
  })

})

describe("AutonomyPolicy.decide", () => {
  test("§D1 action at the ceiling is allowed with the ACTION's gate", () => {
    const d = AutonomyPolicy.decide({ agentCeiling: "level_3", actionRequires: "level_3" })
    expect(d).toEqual({ allowed: true, gate: "pr_approval" })
  })

  test("§D1 action below the ceiling uses the ACTION's gate, not the ceiling's", () => {
    // a level_4 agent doing a level_2 edit still only owes the level_2 gate.
    const d = AutonomyPolicy.decide({ agentCeiling: "level_4", actionRequires: "level_2" })
    expect(d).toEqual({ allowed: true, gate: "auto_pr_or_digest" })
  })

  test("§D1 config can only tighten: an action above the ceiling is refused", () => {
    // a level_2-capped agent can never perform a level_3 action.
    const d = AutonomyPolicy.decide({ agentCeiling: "level_2", actionRequires: "level_3" })
    expect(d).toEqual({
      allowed: false,
      reason: "exceeds_ceiling",
      ceiling: "level_2",
      required: "level_3",
    })
  })

  test("§D1 level_5 suggestion_only: ceiling 5 + action 5 → allowed as suggestion only", () => {
    const d = AutonomyPolicy.decide({ agentCeiling: "level_5", actionRequires: "level_5" })
    expect(d).toEqual({ allowed: true, gate: "suggestion_only" })
  })

  test("§D1 level_5 is never escalated: ceiling 4 + action 5 → refused", () => {
    const d = AutonomyPolicy.decide({ agentCeiling: "level_4", actionRequires: "level_5" })
    expect(d).toEqual({
      allowed: false,
      reason: "exceeds_ceiling",
      ceiling: "level_4",
      required: "level_5",
    })
  })

  test("level_0 agent may still run level_0 actions with no gate", () => {
    const d = AutonomyPolicy.decide({ agentCeiling: "level_0", actionRequires: "level_0" })
    expect(d).toEqual({ allowed: true, gate: "none" })
  })
})

describe("AutonomyPolicy.resolveCeiling", () => {
  test("defaults to the conservative level_0 when autonomy is unset", () => {
    expect(AutonomyPolicy.resolveCeiling({})).toBe("level_0")
    expect(AutonomyPolicy.resolveCeiling({ autonomy: undefined })).toBe("level_0")
  })

  test("returns the explicit ceiling when set", () => {
    expect(AutonomyPolicy.resolveCeiling({ autonomy: "level_3" })).toBe("level_3")
  })
})
