import { describe, expect, test } from "bun:test"
import { Model } from "@deepagent-code/llm"
import { route } from "@deepagent-code/llm/protocols/openai-chat"
import { ModelHardPolicy } from "../src/session/runner/model-hard-policy"
import { PreparedProviderTurn } from "../src/session/runner/prepared-provider-turn"

const decide = (id: string, mode: "adaptive" | "long" | "extreme", tokens = 0) =>
  ModelHardPolicy.decide({
    providerID: "custom",
    runtimeModelID: id,
    apiModelID: id,
    mode,
    physicalInputBudget: 1_000_000,
    estimatedFullRequestTokens: tokens,
    autoCompact: true,
  })

describe("three compaction modes", () => {
  test.each([
    ["gpt-6.1-sol", 272_000, 272_000],
    ["gpt-5.4", 272_000, 272_000],
    ["deepseek-flash", 384_000, 768_000],
    ["deepseek-v4-pro", 384_000, 768_000],
    ["kimi-k3", 256_000, 512_000],
    ["k3-256k", 256_000, 512_000],
    ["glm-5.3", 256_000, 512_000],
    ["custom-model", 256_000, 512_000],
  ] as const)("%s applies user work lines with bounded advance headroom", (id, adaptive, long) => {
    expect(decide(id, "adaptive")).toMatchObject({
      state: "managed",
      hardGate: adaptive,
      summaryOutputLimit: 20_000,
      effectiveHardGate: adaptive - 2_048,
      policyInputLimit: adaptive,
    })
    expect(decide(id, "long")).toMatchObject({
      state: "managed",
      hardGate: long,
      summaryOutputLimit: 32_000,
      effectiveHardGate: long - 2_048,
    })
    expect(decide(id, "extreme")).toMatchObject({
      state: "managed",
      hardGate: 1_000_000,
      summaryOutputLimit: 48_000,
      effectiveHardGate: 997_952,
    })
  })

  test("a smaller endpoint wins and disabled auto blocks before dispatch", () => {
    const input = {
      providerID: "deepagent",
      runtimeModelID: "kimi-k3",
      mode: "long" as const,
      physicalInputBudget: 256_000,
      estimatedFullRequestTokens: 253_952,
      autoCompact: false,
    }
    expect(ModelHardPolicy.decide(input)).toMatchObject({
      state: "managed",
      key: "kimi-k3",
      hardGate: 512_000,
      effectiveHardGate: 253_952,
      physicalInputBudget: 256_000,
      limitMismatch: true,
      action: "hard_gate_blocked",
    })
    expect(ModelHardPolicy.decide({ ...input, estimatedFullRequestTokens: 253_951 })).toMatchObject({
      action: "observed",
    })
  })

  test("API identity outranks runtime alias without borrowing a gateway price contract", () => {
    expect(
      ModelHardPolicy.decide({
        providerID: "deepseek",
        runtimeModelID: "deepseek-flash",
        apiModelID: "custom-model",
        physicalInputBudget: 1_000_000,
        estimatedFullRequestTokens: 0,
        autoCompact: true,
      }),
    ).toMatchObject({
      state: "managed",
      key: "default",
      hardGate: 256_000,
      pricing: { state: "unknown" },
    })
    for (const endpointOrigin of ["https://custom.example/v1", "invalid"])
      expect(
        ModelHardPolicy.pricingLookup({ providerID: "openai", apiModelID: "gpt-6.1-sol", endpointOrigin }),
      ).toEqual({ state: "unknown" })
  })

  test("economic modes preserve exact comparison while extreme permits crossing price", () => {
    const input = {
      providerID: "xai",
      runtimeModelID: "grok-4.7",
      apiModelID: "grok-4.7",
      physicalInputBudget: 500_000,
      estimatedFullRequestTokens: 200_000,
      autoCompact: true,
      bufferTokens: 0,
    }
    expect(ModelHardPolicy.decide(input)).toMatchObject({
      state: "managed",
      policyInputLimit: 199_999,
      pricing: { state: "tiered", inputLimit: 200_000, inclusive: false },
      action: "hard_gate_compact",
    })
    expect(ModelHardPolicy.decide({ ...input, mode: "extreme" })).toMatchObject({
      policyInputLimit: 500_000,
      action: "normal",
      summaryOutputLimit: 48_000,
    })
  })

  test("summary headroom is per request, not two outputs charged together", () => {
    expect(
      ModelHardPolicy.decide({
        providerID: "custom",
        runtimeModelID: "custom",
        mode: "extreme",
        physicalInputBudget: 994_976,
        summaryInputBudget: 950_976,
        estimatedFullRequestTokens: 0,
        autoCompact: true,
        bufferTokens: 2_048,
      }),
    ).toMatchObject({
      physicalInputBudget: 994_976,
      policyInputLimit: 950_976,
      effectiveHardGate: 948_928,
    })
  })

  test.each([
    ["openai", "gpt-6.1-sol", 272_000, true],
    ["anthropic", "claude-haiku-5-5", 100_000, true],
    ["google", "gemini-3.1-pro-preview", 200_000, true],
    ["google", "gemini-2.5-pro", 200_000, true],
    ["xai", "grok-4.7", 200_000, false],
    ["alibaba", "qwen3.7-flash", 32_000, true],
  ] as const)("%s/%s retains the published integer and comparison", (providerID, apiModelID, inputLimit, inclusive) => {
    expect(ModelHardPolicy.pricingLookup({ providerID, apiModelID })).toMatchObject({
      state: "tiered",
      inputLimit,
      inclusive,
    })
  })

  test("known flat latest models differ from unknown deployment scope", () => {
    for (const [providerID, apiModelID] of [
      ["google", "gemini-4-argon"],
      ["anthropic", "claude-opus-5-5"],
      ["alibaba", "qwen3.8-max"],
    ] as const)
      expect(ModelHardPolicy.pricingLookup({ providerID, apiModelID }).state).toBe("flat")
    expect(ModelHardPolicy.pricingLookup({ providerID: "alibaba", apiModelID: "qwen-plus" })).toEqual({
      state: "unknown",
    })
    expect(ModelHardPolicy.pricingLookup({ providerID: "alibaba", apiModelID: "qwen3.7-plus" })).toEqual({
      state: "unknown",
    })
    expect(
      ModelHardPolicy.pricingLookup({
        providerID: "alibaba",
        apiModelID: "qwen3.7-plus",
        deploymentScope: "international",
      }),
    ).toMatchObject({ state: "tiered", inputLimit: 256_000 })
    expect(ModelHardPolicy.pricingLookup({ providerID: "openai", apiModelID: "gpt-5.5-pro" })).toEqual({
      state: "unknown",
    })
    expect(
      ModelHardPolicy.pricingLookup({ providerID: "alibaba", apiModelID: "qwen-plus", deploymentScope: "global" }),
    ).toMatchObject({ state: "tiered", inputLimit: 128_000 })
    expect(
      ModelHardPolicy.pricingLookup({
        providerID: "alibaba",
        apiModelID: "qwen-plus",
        deploymentScope: "international",
      }),
    ).toMatchObject({ state: "tiered", inputLimit: 256_000 })
    expect(ModelHardPolicy.pricingLookup({ providerID: "anthropic", apiModelID: "claude-opus-9" })).toEqual({
      state: "unknown",
    })
  })
})

describe("physical requests reserve their own output", () => {
  const model = Model.make({
    id: "ordinary",
    provider: "custom",
    route: route.with({
      limits: { context: 1_000_000, input: 1_000_000, output: 64_000 },
    }),
  })
  test("ordinary answer and summary maxTokens are separate", () => {
    expect(PreparedProviderTurn.budget(model, 0, 2_000)).toMatchObject({
      physicalInputBudget: 996_976,
      reservedOutputTokens: 2_000,
      safetyMargin: 1_024,
    })
    expect(PreparedProviderTurn.budget(model, 0, 32_000)).toMatchObject({
      physicalInputBudget: 966_976,
      reservedOutputTokens: 32_000,
    })
    expect(PreparedProviderTurn.budget(model, 966_976, 32_000).decision).toBe("unavailable")
    expect(PreparedProviderTurn.budget(model, 966_975, 32_000).decision).toBe("ok")
  })
  test("a lower independent input ceiling does not subtract output twice", () => {
    const limited = Model.make({
      id: "limited",
      provider: "custom",
      route: route.with({
        limits: { context: 128_000, input: 100_000, output: 8_000 },
      }),
    })
    expect(PreparedProviderTurn.budget(limited, 0, 8_000).physicalInputBudget).toBe(98_976)
  })
  test("a resolved route output default is used before the model maximum", () => {
    const short = Model.make({
      id: "short",
      provider: "custom",
      route: route.with({
        limits: { context: 128_000, output: 64_000 },
        generation: { maxTokens: 128 },
      }),
    })
    expect(PreparedProviderTurn.budget(short)).toMatchObject({
      reservedOutputTokens: 128,
      physicalInputBudget: 126_848,
    })
    expect(PreparedProviderTurn.budget(short, 0, 20_000)).toMatchObject({
      reservedOutputTokens: 20_000,
      physicalInputBudget: 106_976,
    })
  })
  test("known independent Gemini 3 differs from shared Gemini 4", () => {
    const gemini = (id: string) =>
      Model.make({
        id,
        provider: "google",
        route: route.with({
          limits: { context: 1_048_576, input: 1_048_576, output: 65_536 },
        }),
      })
    expect(PreparedProviderTurn.budget(gemini("gemini-3.8-flash"), 0, 32_000).physicalInputBudget).toBe(1_047_552)
    expect(PreparedProviderTurn.budget(gemini("gemini-4-argon"), 0, 32_000).physicalInputBudget).toBe(1_015_552)
  })
  test("unknown context retains host guard; invalid limits fail closed", () => {
    expect(PreparedProviderTurn.budget(Model.make({ id: "unknown", provider: "custom", route }), 0)).toMatchObject({
      decision: "ok",
      physicalInputBudget: 32_768,
      provenance: "host_guard",
    })
    expect(PreparedProviderTurn.budget(model, 0, -1)).toMatchObject({
      decision: "unavailable",
      reason: "context_limit_invalid",
    })
  })
})
