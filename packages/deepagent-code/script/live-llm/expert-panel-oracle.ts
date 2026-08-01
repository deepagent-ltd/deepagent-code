import type { PanelLens, PanelOpinion, PanelVerdict, QuorumPolicy } from "../../src/agent/schema/panel"
import { arbitrate } from "../../src/panel/arbiter"

export function assertPanelArbitrationEvidence(input: {
  opinions: readonly PanelOpinion[]
  verdict: PanelVerdict
  policy: QuorumPolicy
  rounds: number
  expectedLenses: readonly PanelLens[]
}) {
  const actualLenses = input.opinions.map((opinion) => opinion.lens).toSorted()
  const expectedLenses = input.expectedLenses.toSorted()
  if (
    new Set(actualLenses).size !== actualLenses.length ||
    actualLenses.join("\0") !== expectedLenses.join("\0")
  ) {
    throw new Error(
      `D3 Arbiter received the wrong opinion set: expected ${expectedLenses.join(", ")}, received ${actualLenses.join(", ")}`,
    )
  }

  const recomputed = arbitrate(input.opinions, input.policy, input.rounds)
  if (JSON.stringify(recomputed) !== JSON.stringify(input.verdict)) {
    throw new Error(`D3 deterministic arbiter mismatch: ${JSON.stringify({ verdict: input.verdict, recomputed })}`)
  }
  return recomputed
}
