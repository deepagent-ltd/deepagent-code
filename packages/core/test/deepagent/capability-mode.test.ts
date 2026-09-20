import { describe, expect, test } from "bun:test"
import {
  CAPABILITY_MODES,
  autoDetectEnabled,
  capabilityModeForAgentMode,
  complexityOf,
  estimatedModeFor,
  promoteFor,
  resolveMode,
  tierForCapabilityMode,
} from "../../src/deepagent/capability-mode"

// Capability mode — the decision that says how much runtime machinery a session is worth.
//
// The design constraint these tests pin: the EXPLICIT tier (the user's or deployment's AgentMode) is
// the default authority, exactly as the reference agents route by user/config effort tier, and the
// runtime's own estimate may only RAISE the mode when the experimental flag is on. An unmeasurable
// decision cannot be tuned, so every resolution reports its authority — including the estimates that
// did NOT win.

describe("capability mode resolution", () => {
  test("the explicit tier is the authority while auto-detection is off", () => {
    for (const mode of CAPABILITY_MODES) {
      const resolution = resolveMode({
        explicitMode: mode,
        complexity: 3,
        autoDetect: false,
        promotion: { mode: "deep", reasons: ["files_mutated>=4"] },
      })
      expect(resolution.mode).toBe(mode)
      expect(resolution.source).toBe("explicit")
      // The estimate is still reported, so an off-flag session measures the estimate's accuracy.
      expect(resolution.estimatedMode).toBe("deep")
      expect(resolution.reasons).toEqual([])
    }
  })

  test("auto-detection raises the mode but never lowers it", () => {
    // A deep-configured session on a trivial request stays deep: lowering mid-flight would drop
    // machinery a session may already have recorded plan/validation state for.
    const stays = resolveMode({ explicitMode: "deep", complexity: 0, autoDetect: true })
    expect(stays.mode).toBe("deep")
    expect(stays.source).toBe("explicit")

    const raised = resolveMode({ explicitMode: "quick", complexity: 2, autoDetect: true })
    expect(raised.mode).toBe("deep")
    expect(raised.source).toBe("estimated")
    expect(raised.explicitMode).toBe("quick")
    expect(raised.estimatedMode).toBe("deep")
  })

  test("observed work promotes and names the signals that promoted it", () => {
    const promotion = promoteFor({ filesMutated: 5, validationFailures: 0, gateBlocks: 0 })
    expect(promotion).toEqual({ mode: "deep", reasons: ["files_mutated>=4"] })
    const resolution = resolveMode({
      explicitMode: "quick",
      complexity: 0,
      autoDetect: true,
      promotion,
    })
    expect(resolution.mode).toBe("deep")
    expect(resolution.source).toBe("promoted")
    expect(resolution.reasons).toEqual(["files_mutated>=4"])
  })

  test("promotion needs clear evidence, and promotion is one-way", () => {
    expect(promoteFor({ filesMutated: 3, validationFailures: 1, gateBlocks: 2 })).toBeNull()
    expect(promoteFor({ filesMutated: 0, validationFailures: 2, gateBlocks: 0 })?.reasons).toEqual([
      "validation_failures>=2",
    ])
    expect(promoteFor({ filesMutated: 0, validationFailures: 0, gateBlocks: 3 })?.reasons).toEqual(["gate_blocks>=3"])
    // A promotion cannot pull a deep session down even when hand-constructed as "quick".
    const resolution = resolveMode({
      explicitMode: "deep",
      complexity: 0,
      autoDetect: true,
      promotion: { mode: "quick", reasons: [] },
    })
    expect(resolution.mode).toBe("deep")
  })

  test("complexity maps onto the mode scale and onto the orchestration tier", () => {
    expect([0, 1, 2, 3].map((value) => estimatedModeFor(value as 0 | 1 | 2 | 3))).toEqual([
      "quick",
      "standard",
      "deep",
      "deep",
    ])
    expect(CAPABILITY_MODES.map(tierForCapabilityMode)).toEqual([0, 1, 3])
    expect(complexityOf(undefined)).toBe(0)
    expect(complexityOf({ complexity: 2 } as never)).toBe(2)
  })

  test("AgentMode maps onto capability modes without a new user-facing knob", () => {
    expect(capabilityModeForAgentMode("general")).toBe("quick")
    expect(capabilityModeForAgentMode("high")).toBe("standard")
    expect(capabilityModeForAgentMode("xhigh")).toBe("standard")
    expect(capabilityModeForAgentMode("max")).toBe("deep")
    expect(capabilityModeForAgentMode("ultra")).toBe("deep")
  })

  test("auto-detection is off unless the experimental flag is explicitly on", () => {
    expect(autoDetectEnabled(undefined)).toBe(false)
    expect(autoDetectEnabled("")).toBe(false)
    expect(autoDetectEnabled("false")).toBe(false)
    expect(autoDetectEnabled("0")).toBe(false)
    expect(autoDetectEnabled("true")).toBe(true)
    expect(autoDetectEnabled("1")).toBe(true)
  })
})
