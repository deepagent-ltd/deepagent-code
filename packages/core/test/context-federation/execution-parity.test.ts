import { describe, expect, test } from "bun:test"
import { ContextFederationExecutionParity } from "../../src/context-federation/execution-parity"

describe("ContextFederationExecutionParity", () => {
  test("fails closed for missing, duplicate, or mismatched evidence", () => {
    expect(ContextFederationExecutionParity.evaluate([])).toMatchObject({
      verified: false,
      missing: ContextFederationExecutionParity.Case.literals,
    })
    const duplicate = evidence("admission_activity")
    expect(ContextFederationExecutionParity.evaluate([duplicate, duplicate])).toMatchObject({
      verified: false,
      duplicate: ["admission_activity"],
    })
    expect(ContextFederationExecutionParity.evaluate([
      { ...duplicate, coreV2OutcomeHash: "different" },
    ])).toMatchObject({
      verified: false,
      mismatched: ["admission_activity"],
    })
  })

  test("opens the gate only for the complete production evidence matrix", () => {
    const observations = ContextFederationExecutionParity.Case.literals.map((item) => evidence(item))
    observations[0] = { ...observations[0]!, evidence: ["shadow_snapshot", "recorded_provider"] }
    observations[1] = { ...observations[1]!, evidence: ["shadow_snapshot", "real_session_replay"] }

    expect(ContextFederationExecutionParity.evaluate(observations)).toEqual({
      verified: true,
      missing: [],
      mismatched: [],
      duplicate: [],
      missingEvidence: [],
    })
  })
})

function evidence(caseName: ContextFederationExecutionParity.Case): ContextFederationExecutionParity.Observation {
  return {
    case: caseName,
    legacyRequestHash: `request:${caseName}`,
    coreV2RequestHash: `request:${caseName}`,
    legacyOutcomeHash: `outcome:${caseName}`,
    coreV2OutcomeHash: `outcome:${caseName}`,
    evidence: ["shadow_snapshot"],
  }
}
