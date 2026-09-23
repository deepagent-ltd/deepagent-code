import { describe, expect, test } from "bun:test"
import { Model } from "@deepagent-code/llm"
import { route } from "@deepagent-code/llm/protocols/openai-chat"
import { ModelHardPolicy } from "../src/session/runner/model-hard-policy"
import { PreparedProviderTurn } from "../src/session/runner/prepared-provider-turn"

describe("FEATURE-001-405 managed model hard gates", () => {
  test.each([
    ["deepseek", "deepseek-v4-pro", 768_000, 896_000],
    ["deepseek", "deepseek-flash", 256_000, 384_000],
    ["moonshotai", "kimi-k3", 384_000, 512_000],
    ["zhipuai", "glm-5.2", 300_000, 384_000],
  ] as const)("%s/%s observes without changing dispatch at %i and compacts at %i", (providerID, apiModelID, observation, hardGate) => {
    const decide = (tokens: number) =>
      ModelHardPolicy.decide({
        providerID,
        runtimeModelID: apiModelID,
        apiModelID,
        physicalInputBudget: 1_000_000,
        estimatedFullRequestTokens: tokens,
        autoCompact: true,
      })
    expect(decide(observation - 1)).toMatchObject({ state: "managed", action: "normal" })
    expect(decide(observation)).toMatchObject({ state: "managed", action: "observed" })
    expect(decide(hardGate - 1)).toMatchObject({ state: "managed", action: "observed" })
    expect(decide(hardGate)).toMatchObject({ state: "managed", action: "hard_gate_compact" })
  })

  test("a 256K gateway limit wins over the K3 policy and disabled auto compaction blocks dispatch", () => {
    expect(
      ModelHardPolicy.decide({
        providerID: "deepagent",
        runtimeModelID: "kimi-k3",
        physicalInputBudget: 256_000,
        estimatedFullRequestTokens: 256_000,
        autoCompact: false,
      }),
    ).toMatchObject({
      state: "managed",
      key: "kimi-k3",
      effectiveHardGate: 256_000,
      limitMismatch: true,
      action: "hard_gate_blocked",
    })
  })

  test("uses the BUG-007 safety margin as the effective provider input budget", () => {
    const model = Model.make({
      id: "kimi-k3",
      provider: "moonshotai",
      route: route.with({ limits: { input: 256_000, output: 1_000 } }),
    })
    const budget = PreparedProviderTurn.budget(model, 254_976)
    expect(budget).toMatchObject({
      decision: "unavailable",
      reason: "physical_budget_exceeded",
      physicalInputBudget: 254_976,
      reservedOutputTokens: 1_000,
      safetyMargin: 1_024,
      provenance: "model_limit",
    })
    expect(ModelHardPolicy.decide({
      providerID: "moonshotai",
      runtimeModelID: "kimi-k3",
      apiModelID: "kimi-k3",
      physicalInputBudget: budget.physicalInputBudget,
      limitProvenance: budget.provenance,
      safetyMargin: budget.safetyMargin,
      estimatedFullRequestTokens: 254_976,
      autoCompact: false,
    })).toMatchObject({
      state: "managed",
      effectiveHardGate: 254_976,
      limitMismatch: true,
      limitProvenance: "model_limit",
      safetyMargin: 1_024,
      action: "hard_gate_blocked",
    })
    expect(PreparedProviderTurn.budget(model, 254_975).decision).toBe("ok")
  })

  test("API model identity outranks a misleading runtime alias; similar names stay unmanaged", () => {
    expect(
      ModelHardPolicy.decide({
        providerID: "deepseek",
        runtimeModelID: "deepseek-flash",
        apiModelID: "deepseek-flash-next",
        physicalInputBudget: 1_000_000,
        estimatedFullRequestTokens: 900_000,
        autoCompact: true,
      }),
    ).toEqual({ state: "unmanaged", reason: "model_not_registered" })
    expect(
      ModelHardPolicy.decide({
        providerID: "deepseek",
        runtimeModelID: "deepseek-v4-flash",
        apiModelID: "deepseek-v4-flash",
        physicalInputBudget: 1_000_000,
        estimatedFullRequestTokens: 900_000,
        autoCompact: true,
      }),
    ).toEqual({ state: "unmanaged", reason: "model_not_registered" })
    expect(
      ModelHardPolicy.decide({
        providerID: "deepagent",
        runtimeModelID: "k3-256k",
        physicalInputBudget: 256_000,
        estimatedFullRequestTokens: 200_000,
        autoCompact: true,
      }),
    ).toEqual({ state: "unmanaged", reason: "model_not_registered" })
  })
})
