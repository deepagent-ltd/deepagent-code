import { describe, expect, test } from "bun:test"
import { buildVolatileRoundContext } from "../src/deepagent/prompt-policy"
import { decide as decideActivation } from "../src/deepagent/activation-policy"
import type { PromptContext } from "../src/deepagent/prompt-policy"

// G1 stage-guidance slimming: the full how-to-work prose renders when the stage CHANGES; later
// rounds in the same stage carry only the one-line round/stage marker. Continuation contexts never
// carry the guidance block at all.

const baseContext = (stage: ReturnType<typeof decideActivation>["stage"], round: number): PromptContext =>
  ({
    mode: "high",
    round,
    activation: decideActivation({
      mode: "high",
      round,
      stage,
      previousValidationPassed: false,
      previousDiagnosisAvailable: false,
      userRequestedDeeper: false,
      budgetExhausted: false,
    }),
    roundState: {
      mode: "high",
      round,
      budget_remaining_tokens: 100000,
    } as PromptContext["roundState"],
    environment: {
      os: "linux",
      shell: "/bin/bash",
      cwd: "/app",
      homedir: "/root",
      gitBranch: null,
      gitRoot: null,
      isGitRepo: false,
      date: "2026-09-13",
      platform: "linux",
    },
    task: {
      userRequest: "",
      taskType: "code_modification",
      domain: "code",
      goals: [],
      successCriteria: [],
      validationCommands: [],
      riskBoundaries: [],
    },
    tools: { availableTools: [], mcpServers: [], totalToolCount: 0 },
    knowledge: null,
    previousResults: null,
    userInstructions: null,
  }) as PromptContext

describe("G1 stage guidance slimming", () => {
  test("renders full guidance on round 1, marker-only on the next round of the same stage", () => {
    const first = buildVolatileRoundContext(baseContext("first_fast_design", 1))
    expect(first).toContain("Architect")
    const second = buildVolatileRoundContext(baseContext("first_fast_design", 2))
    expect(second).toContain("第 2 轮 · 阶段 first_fast_design")
    expect(second).not.toContain("Architect phase")
  })

  test("re-renders the full guidance when the stage changes", () => {
    buildVolatileRoundContext(baseContext("first_fast_design", 1))
    buildVolatileRoundContext(baseContext("first_fast_design", 2))
    const revised = buildVolatileRoundContext(baseContext("revision_minimal", 3))
    expect(revised).toContain("Judge phase")
  })
})
