import { describe, expect, test } from "bun:test"
import { MODE_ORDER, modeRank, downgradeOneLevel, type AgentMode } from "../../src/deepagent/mode"

// Pure tier-arithmetic helpers backing "child agent downgrade inheritance" (V3.2 strength ladder).
describe("agent-strength tier arithmetic", () => {
  test("MODE_ORDER is the 5-strength ladder, weakest -> strongest", () => {
    expect(MODE_ORDER).toHaveLength(5)
    expect(MODE_ORDER).toEqual(["general", "high", "xhigh", "max", "ultra"])
  })

  test("modeRank returns the ladder index for each mode", () => {
    expect(modeRank("general")).toBe(0)
    expect(modeRank("high")).toBe(1)
    expect(modeRank("xhigh")).toBe(2)
    expect(modeRank("max")).toBe(3)
    expect(modeRank("ultra")).toBe(4)
  })

  test("downgradeOneLevel steps exactly one strength below the parent", () => {
    expect(downgradeOneLevel("ultra")).toBe("max")
    expect(downgradeOneLevel("max")).toBe("xhigh")
    expect(downgradeOneLevel("xhigh")).toBe("high")
    expect(downgradeOneLevel("high")).toBe("general")
  })

  test("downgradeOneLevel floors at general (cannot descend further)", () => {
    expect(downgradeOneLevel("general")).toBe("general")
  })

  test("downgradeOneLevel fails safe to general for unknown input", () => {
    expect(downgradeOneLevel("bogus" as AgentMode)).toBe("general")
  })
})
