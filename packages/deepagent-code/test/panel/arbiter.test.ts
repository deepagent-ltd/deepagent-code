import { describe, expect, test } from "bun:test"
import { arbitrate, opinionWeight, clampConfidence, lensWeight } from "../../src/panel/arbiter"
import {
  type PanelOpinion,
  type QuorumPolicy,
  DEFAULT_QUORUM_POLICY,
  SECURITY_AUDIT_QUORUM_POLICY,
} from "../../src/agent/schema/panel"
import type { ReviewFinding } from "../../src/agent/schema/orchestration"

/**
 * §G-C — Panel Arbiter tests. These are PURE (no LLM, no Effect layers): the Arbiter is a pure
 * deterministic function, so every property below is asserted directly and runs fast.
 */

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  severity: "high",
  category: "correctness",
  file: "src/foo.ts",
  line: 10,
  summary: "a problem",
  failureScenario: "given input X, returns wrong Y",
  confidence: 0.9,
  ...over,
})

const opinion = (over: Partial<PanelOpinion> = {}): PanelOpinion => ({
  lens: "correctness",
  verdict: "approve",
  findings: [],
  confidence: 0.8,
  ...over,
})

describe("Panel Arbiter — determinism (§C.8)", () => {
  test("same opinions + same policy → identical PanelVerdict", () => {
    const opinions: PanelOpinion[] = [
      opinion({ lens: "security", verdict: "block", confidence: 0.95, findings: [finding({ severity: "critical" })] }),
      opinion({ lens: "correctness", verdict: "revise", confidence: 0.6, findings: [finding()] }),
      opinion({ lens: "performance", verdict: "approve", confidence: 0.7 }),
    ]
    const a = arbitrate(opinions, DEFAULT_QUORUM_POLICY, 2)
    const b = arbitrate(opinions, DEFAULT_QUORUM_POLICY, 2)
    expect(a).toEqual(b)
    // Deep-equal a fresh serialize/parse to prove no hidden non-determinism (dates/refs).
    expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)))
  })

  test("input order does not change the verdict (opinions collected concurrently)", () => {
    const o1 = opinion({ lens: "correctness", verdict: "revise", confidence: 0.6, findings: [finding()] })
    const o2 = opinion({ lens: "security", verdict: "approve", confidence: 0.7 })
    const o3 = opinion({ lens: "performance", verdict: "revise", confidence: 0.65, findings: [finding()] })
    const a = arbitrate([o1, o2, o3], DEFAULT_QUORUM_POLICY)
    const b = arbitrate([o3, o1, o2], DEFAULT_QUORUM_POLICY)
    expect(a.decision).toBe(b.decision)
    expect(a.dissent).toEqual(b.dissent)
    expect(a.evidence).toEqual(b.evidence)
  })

  test("does not mutate its inputs", () => {
    const opinions: PanelOpinion[] = [
      opinion({ lens: "security", verdict: "block", confidence: 0.9, findings: [finding()] }),
      opinion({ lens: "correctness", verdict: "approve", confidence: 0.8 }),
    ]
    const snapshot = JSON.stringify(opinions)
    arbitrate(opinions, DEFAULT_QUORUM_POLICY)
    expect(JSON.stringify(opinions)).toBe(snapshot)
  })
})

describe("Panel Arbiter — fail-closed / 阻断优先 (§C.6)", () => {
  test("any high-confidence block → decision block", () => {
    const opinions: PanelOpinion[] = [
      opinion({ lens: "correctness", verdict: "approve", confidence: 0.95 }),
      opinion({ lens: "performance", verdict: "approve", confidence: 0.95 }),
      opinion({ lens: "security", verdict: "block", confidence: 0.8, findings: [finding()] }),
    ]
    const v = arbitrate(opinions, DEFAULT_QUORUM_POLICY)
    expect(v.decision).toBe("block")
  })

  test("a LOW-confidence block does NOT trip fail-closed (below threshold)", () => {
    const opinions: PanelOpinion[] = [
      opinion({ lens: "correctness", verdict: "approve", confidence: 0.9 }),
      opinion({ lens: "performance", verdict: "approve", confidence: 0.9 }),
      opinion({ lens: "security", verdict: "block", confidence: 0.4, findings: [finding()] }),
    ]
    const v = arbitrate(opinions, DEFAULT_QUORUM_POLICY)
    expect(v.decision).not.toBe("block")
  })

  test("security-audit policy: ANY block (even low confidence) → block", () => {
    const opinions: PanelOpinion[] = [
      opinion({ lens: "correctness", verdict: "approve", confidence: 0.99 }),
      opinion({ lens: "security", verdict: "block", confidence: 0.2, findings: [finding({ category: "security" })] }),
    ]
    const v = arbitrate(opinions, SECURITY_AUDIT_QUORUM_POLICY)
    expect(v.decision).toBe("block")
  })
})

describe("Panel Arbiter — 少数派保留 (dissent preservation, §C.6/§C.8)", () => {
  test("overruled opinions appear in dissent[]", () => {
    const dissenter = opinion({ lens: "correctness", verdict: "approve", confidence: 0.9 })
    const opinions: PanelOpinion[] = [
      dissenter,
      opinion({ lens: "security", verdict: "block", confidence: 0.9, findings: [finding()] }),
    ]
    const v = arbitrate(opinions, DEFAULT_QUORUM_POLICY)
    expect(v.decision).toBe("block")
    expect(v.dissent).toContainEqual(dissenter)
  })

  test("weighted-majority winner: losers go to dissent, no opinion is dropped", () => {
    const a1 = opinion({ lens: "correctness", verdict: "revise", confidence: 0.9, findings: [finding()] })
    const a2 = opinion({ lens: "performance", verdict: "revise", confidence: 0.9, findings: [finding()] })
    const loser = opinion({ lens: "architecture", verdict: "approve", confidence: 0.5 })
    const v = arbitrate([a1, a2, loser], DEFAULT_QUORUM_POLICY)
    expect(v.decision).toBe("revise")
    expect(v.dissent).toContainEqual(loser)
    // No information loss: winners + dissent = all opinions.
    expect(v.dissent.length + [a1, a2].length).toBe(3)
  })
})

describe("Panel Arbiter — quorum floor / 优雅降级 (§C.8)", () => {
  test("survivors < minQuorum → needs_human, never silent approve", () => {
    const only = opinion({ lens: "correctness", verdict: "approve", confidence: 0.95 })
    const v = arbitrate([only], DEFAULT_QUORUM_POLICY) // minQuorum = 2
    expect(v.decision).toBe("needs_human")
  })

  test("zero survivors → needs_human", () => {
    const v = arbitrate([], DEFAULT_QUORUM_POLICY, 0)
    expect(v.decision).toBe("needs_human")
    expect(v.rounds).toBe(0)
  })
})

describe("Panel Arbiter — 平票 → conservative + needs_human (§C.6)", () => {
  test("revise vs approve tie → revise + needs_human", () => {
    // Equal effective weight on both sides; both supported so no down-weighting distorts it.
    const opinions: PanelOpinion[] = [
      opinion({ lens: "correctness", verdict: "approve", confidence: 0.8 }),
      opinion({ lens: "performance", verdict: "revise", confidence: 0.8, findings: [finding()] }),
    ]
    const v = arbitrate(opinions, DEFAULT_QUORUM_POLICY)
    expect(v.decision).toBe("needs_human")
  })
})

describe("Panel Arbiter — critical dissent escalation (§C.6)", () => {
  test("majority approve but a dissenter raised a critical finding → needs_human", () => {
    const opinions: PanelOpinion[] = [
      opinion({ lens: "correctness", verdict: "approve", confidence: 0.9 }),
      opinion({ lens: "performance", verdict: "approve", confidence: 0.9 }),
      // A low-confidence block (does not trip fail-closed) carrying a CRITICAL finding.
      opinion({ lens: "security", verdict: "block", confidence: 0.3, findings: [finding({ severity: "critical" })] }),
    ]
    const v = arbitrate(opinions, DEFAULT_QUORUM_POLICY)
    expect(v.decision).toBe("needs_human")
  })
})

describe("Panel Arbiter — evidence down-weighting / 证据要求 (§C.6)", () => {
  test("a block with empty failureScenario is down-weighted vs one with evidence", () => {
    const supported = opinion({
      lens: "security",
      verdict: "block",
      confidence: 0.5,
      findings: [finding({ failureScenario: "attacker sends X ⇒ auth bypass", file: "src/auth.ts", line: 3 })],
    })
    const unsupported = opinion({
      lens: "security",
      verdict: "block",
      confidence: 0.5,
      findings: [finding({ failureScenario: "   ", file: "" })],
    })
    // Same base inputs; the only difference is evidence. Supported must weigh strictly more.
    expect(opinionWeight(supported, DEFAULT_QUORUM_POLICY)).toBeGreaterThan(
      opinionWeight(unsupported, DEFAULT_QUORUM_POLICY),
    )
  })

  test("down-weighting can flip a tally: evidence-less revise loses to supported approve", () => {
    // Two revise votes with NO evidence (each down-weighted ×0.5 ⇒ 0.45 each = 0.9 total) vs two
    // approve votes fully supported (0.6 each = 1.2 total). Approve wins on weight.
    const policy: QuorumPolicy = { ...DEFAULT_QUORUM_POLICY, criticalDissentNeedsHuman: false }
    const opinions: PanelOpinion[] = [
      opinion({ lens: "correctness", verdict: "revise", confidence: 0.9, findings: [finding({ failureScenario: "", file: "" })] }),
      opinion({ lens: "architecture", verdict: "revise", confidence: 0.9, findings: [finding({ failureScenario: "", file: "" })] }),
      opinion({ lens: "performance", verdict: "approve", confidence: 0.6 }),
      opinion({ lens: "repro", verdict: "approve", confidence: 0.6 }),
    ]
    const v = arbitrate(opinions, policy)
    expect(v.decision).toBe("approve")
  })

  test("approve votes are never down-weighted (no failure to reproduce)", () => {
    const approve = opinion({ lens: "correctness", verdict: "approve", confidence: 0.5, findings: [] })
    expect(opinionWeight(approve, DEFAULT_QUORUM_POLICY)).toBeCloseTo(0.5, 10)
  })
})

describe("Panel Arbiter — helpers", () => {
  test("clampConfidence clamps out-of-range + non-finite to [0,1]", () => {
    expect(clampConfidence(-0.5)).toBe(0)
    expect(clampConfidence(1.5)).toBe(1)
    expect(clampConfidence(Number.NaN)).toBe(0)
    expect(clampConfidence(0.42)).toBe(0.42)
  })

  test("lensWeight defaults to 1 for unweighted lens, floors negatives to 0", () => {
    expect(lensWeight("architecture", DEFAULT_QUORUM_POLICY)).toBe(1)
    expect(lensWeight("security", SECURITY_AUDIT_QUORUM_POLICY)).toBe(2)
    expect(lensWeight("security", { ...DEFAULT_QUORUM_POLICY, lensWeights: { security: -3 } })).toBe(0)
  })

  test("a malformed (out-of-range) confidence cannot break determinism", () => {
    const opinions: PanelOpinion[] = [
      opinion({ lens: "security", verdict: "block", confidence: 99, findings: [finding()] }),
      opinion({ lens: "correctness", verdict: "approve", confidence: -5 }),
    ]
    const a = arbitrate(opinions, DEFAULT_QUORUM_POLICY)
    const b = arbitrate(opinions, DEFAULT_QUORUM_POLICY)
    expect(a).toEqual(b)
    // confidence 99 clamps to 1 ≥ blockThreshold ⇒ fail-closed block.
    expect(a.decision).toBe("block")
    expect(a.confidence).toBeLessThanOrEqual(1)
    expect(a.confidence).toBeGreaterThanOrEqual(0)
  })
})
