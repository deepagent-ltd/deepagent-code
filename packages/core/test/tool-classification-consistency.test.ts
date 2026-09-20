import { describe, expect, test } from "bun:test"
import { builtinToolNames } from "../src/tool/builtins"
import { isMutatingTool } from "../src/deepagent/plan-controller"

// The plan gate's classifier is fail-OPEN: `isMutatingTool` returns false for any name it does not
// recognise. That is the right default for an unknown third-party tool (never invent a block), but it
// meant a SHIPPED builtin could silently skip the gate — which is exactly what happened to
// `apply_patch_chunk`, absent from the mutating set while `locationLayer` registers it: the chunked
// patch transaction bypassed the plan gate entirely (no block, and no implicit-plan audit record
// either).
//
// The expectation below is the BEHAVIOUR contract for the shipped leaf set, declared here rather than
// exported from the production module (an exported mutable Set is itself a runtime-integrity
// violation), so the class is closed by observation: a new leaf that lands on the wrong side fails
// this test instead of landing in the fail-open gap.
const READ_ONLY_BUILTINS = new Set([
  "read",
  "glob",
  "grep",
  "git_read",
  "webfetch",
  "websearch",
  "skill",
  "code_intel",
  "context_query",
  "capability_search",
  "capability_load",
  "question",
  "task",
  // The gate's own escape hatch: a stale plan must stay repairable, so `plan` is never gated.
  "plan",
])

describe("plan-gate tool classification covers the builtin registry", () => {
  test("every builtin is classified on the side the gate needs", () => {
    const wrong = [...builtinToolNames].filter((name) => isMutatingTool(name) === READ_ONLY_BUILTINS.has(name))
    expect(wrong).toEqual([])
  })

  test("the chunked patch transaction is mutating (the regression this test exists for)", () => {
    expect(isMutatingTool("apply_patch_chunk")).toBe(true)
    expect(isMutatingTool("apply_patch")).toBe(true)
  })

  test("a shell command with nothing to inspect is treated as mutating (fail-safe)", () => {
    expect(isMutatingTool("bash")).toBe(true)
  })
})
