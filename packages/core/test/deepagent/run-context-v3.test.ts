import { describe, expect, test } from "bun:test"
import { buildRunContext, type RunContextInput } from "../../src/deepagent/run-context"
import { AgentGateway } from "../../src/agent-gateway"

const DEEPAGENT_BOOT_MESSAGE = AgentGateway.DEEPAGENT_BOOT_MESSAGE

const base: RunContextInput = {
  runId: "run_1",
  mode: "high",
  status: "in_progress",
  round: 1,
  modelId: "deepseek-v4",
  feature: "session_chat",
  routerProvider: "deepseek",
  routerModel: "deepseek-v4",
  activationMode: "first_fast_design",
  knowledgeEnabled: false,
  bestCandidateRef: "generic_agent_passthrough",
  nextAction: "continue_or_complete",
  rootCause: null,
  bootMessage: `${DEEPAGENT_BOOT_MESSAGE}\n当前模式: high。`,
}

describe("V3 RUN_CONTEXT working-memory doc", () => {
  test("is handoff-ready: status, best candidate, next action present", () => {
    const md = buildRunContext(base)
    expect(md).toContain("## 现状")
    expect(md).toContain("status: in_progress")
    expect(md).toContain("best candidate: generic_agent_passthrough")
    expect(md).toContain("next action: continue_or_complete")
    expect(md).toContain("## 接手提示")
  })

  test("preserves the boot message invariant", () => {
    expect(buildRunContext(base)).toContain(DEEPAGENT_BOOT_MESSAGE)
  })

  test("failure status yields a diagnose-then-rollback handoff hint", () => {
    const md = buildRunContext({
      ...base,
      status: "runtime_failed",
      rootCause: "compile_error",
      nextAction: "review_required_before_resume",
    })
    expect(md).toContain("status: runtime_failed")
    expect(md).toContain("compile_error")
    expect(md).toContain("回滚")
  })

  test("max mode shows knowledge enabled", () => {
    const md = buildRunContext({
      ...base,
      mode: "max",
      knowledgeEnabled: true,
      activationMode: "first_fast_design_bounded_knowledge",
    })
    expect(md).toContain("knowledge: enabled (max)")
  })

  test("contains no hidden/evaluator content from structured fields", () => {
    const md = buildRunContext(base)
    expect(md).not.toContain("hidden")
    expect(md).not.toContain("evaluator")
  })
})
