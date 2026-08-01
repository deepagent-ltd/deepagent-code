import { describe, expect, test } from "bun:test"
import {
  DEFAULT_QUORUM_POLICY,
  SECURITY_AUDIT_QUORUM_POLICY,
  type PanelLens,
  type PanelOpinion,
} from "../../src/agent/schema/panel"
import { arbitrate } from "../../src/panel/arbiter"
import { assertPanelArbitrationEvidence } from "../../script/live-llm/expert-panel-oracle"

const opinion = (lens: PanelLens, verdict: PanelOpinion["verdict"], confidence: number): PanelOpinion => ({
  lens,
  verdict,
  confidence,
  findings: [
    {
      severity: "high",
      category: lens === "security" ? "security" : "correctness",
      file: `fixtures/${lens}.ts`,
      summary: `${lens} evidence`,
      failureScenario: `${lens} failure`,
      confidence,
    },
  ],
})

describe("D3 Expert Panel hard Oracle", () => {
  const opinions = [
    opinion("correctness", "revise", 0.95),
    opinion("security", "block", 0.5),
    opinion("architecture", "revise", 0.95),
  ]
  const verdict = arbitrate(opinions, DEFAULT_QUORUM_POLICY, 1)

  test("recomputes the verdict from the exact opinion set and policy", () => {
    expect(
      assertPanelArbitrationEvidence({
        opinions,
        verdict,
        policy: DEFAULT_QUORUM_POLICY,
        rounds: 1,
        expectedLenses: ["correctness", "security", "architecture"],
      }),
    ).toEqual(verdict)
  })

  test("rejects opinion, policy, round, and lens-set mutations", () => {
    expect(() =>
      assertPanelArbitrationEvidence({
        opinions: opinions.slice(0, 2),
        verdict,
        policy: DEFAULT_QUORUM_POLICY,
        rounds: 1,
        expectedLenses: ["correctness", "security", "architecture"],
      }),
    ).toThrow("wrong opinion set")
    expect(() =>
      assertPanelArbitrationEvidence({
        opinions,
        verdict,
        policy: SECURITY_AUDIT_QUORUM_POLICY,
        rounds: 1,
        expectedLenses: ["correctness", "security", "architecture"],
      }),
    ).toThrow("arbiter mismatch")
    expect(() =>
      assertPanelArbitrationEvidence({
        opinions,
        verdict,
        policy: DEFAULT_QUORUM_POLICY,
        rounds: 2,
        expectedLenses: ["correctness", "security", "architecture"],
      }),
    ).toThrow("arbiter mismatch")
    expect(() =>
      assertPanelArbitrationEvidence({
        opinions: [opinions[0]!, opinions[0]!, opinions[2]!],
        verdict,
        policy: DEFAULT_QUORUM_POLICY,
        rounds: 1,
        expectedLenses: ["correctness", "security", "architecture"],
      }),
    ).toThrow("wrong opinion set")
  })
})
