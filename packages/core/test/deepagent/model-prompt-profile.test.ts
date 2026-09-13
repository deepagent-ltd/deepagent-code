import { describe, expect, test } from "bun:test"
import {
  clampReasoningEffort,
  eventPrompt,
  profileFor,
  profileKeyFor,
} from "../../src/deepagent/model-prompt-profile"

// G3 model prompt profiles (§3.2): three channels — stable short constraint (cache prefix),
// event-triggered prompts, runtime-only params. No vendor prompt text anywhere.

describe("model prompt profile", () => {
  test("unknown provider/model gets the empty default (no constraint, no clamp)", () => {
    const profile = profileFor("unknown", "model-x")
    expect(profile.stableConstraint).toBe("")
    expect(profile.params.maxReasoningEffort).toBeUndefined()
    expect(profileKeyFor("unknown", "model-x")).toBe("default")
  })

  test("deepseek profiles carry the validate-immediately constraint and a medium effort cap", () => {
    const profile = profileFor("deepseek", "deepseek-chat")
    expect(profile.stableConstraint).toContain("验证")
    expect(profile.params.maxReasoningEffort).toBe("medium")
    expect(profileKeyFor("deepseek", "deepseek-chat")).toBe("deepseek/deepseek-chat")
  })

  test("clampReasoningEffort caps without raising", () => {
    expect(clampReasoningEffort("max", "medium")).toBe("medium")
    expect(clampReasoningEffort("low", "medium")).toBe("low")
    expect(clampReasoningEffort("high", undefined)).toBe("high")
    expect(clampReasoningEffort("max", undefined)).toBe("max")
  })

  test("event channel: validation_failed prompt resolves for every profile", () => {
    expect(eventPrompt(profileFor("deepseek", "deepseek-flash"), "validation_failed")).toContain("Validation failed")
    expect(eventPrompt(profileFor("unknown", "x"), "validation_failed")).toBeDefined()
    expect(eventPrompt(profileFor("unknown", "x"), "no_such_event")).toBeUndefined()
  })

  test("env override replaces a profile wholesale and is observable via the key", () => {
    const prev = process.env["DEEPAGENT_CODE_MODEL_PROFILES"]
    process.env["DEEPAGENT_CODE_MODEL_PROFILES"] = JSON.stringify({
      "test/co-model": { stableConstraint: "custom line", params: { maxToolBatch: 4 } },
    })
    try {
      const profile = profileFor("test", "co-model")
      expect(profile.stableConstraint).toBe("custom line")
      expect(profile.params.maxToolBatch).toBe(4)
      expect(profileKeyFor("test", "co-model")).toContain("override")
    } finally {
      if (prev === undefined) delete process.env["DEEPAGENT_CODE_MODEL_PROFILES"]
      else process.env["DEEPAGENT_CODE_MODEL_PROFILES"] = prev
    }
  })

  test("malformed env JSON degrades to the default profile", () => {
    const prev = process.env["DEEPAGENT_CODE_MODEL_PROFILES"]
    process.env["DEEPAGENT_CODE_MODEL_PROFILES"] = "{not json"
    try {
      expect(profileFor("deepseek", "deepseek-chat").stableConstraint.length).toBeGreaterThan(0)
    } finally {
      if (prev === undefined) delete process.env["DEEPAGENT_CODE_MODEL_PROFILES"]
      else process.env["DEEPAGENT_CODE_MODEL_PROFILES"] = prev
    }
  })
})
