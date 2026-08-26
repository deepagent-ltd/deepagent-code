import { describe, expect, test } from "bun:test"
import {
  deepAgentIntelligenceModelFromConfig,
  deepAgentPromptModeFromConfig,
  deepAgentSubagentIntensityFromConfig,
} from "./deepagent-settings"

// Tier-2 legacy-compat (app READ side): an existing user's synced config may still carry the
// pre-rename `promptMode: "wish"` value and/or `wishModel` option key. These helpers must read the
// old shape and resolve it to the canonical intelligence mode / model so the rename does not
// silently drop a user's saved settings. The app only ever WRITES the new keys.
const config = (options: Record<string, unknown>) =>
  ({ provider: { deepagent: { options } } }) as unknown as Parameters<typeof deepAgentPromptModeFromConfig>[0]

describe("deepAgentPromptModeFromConfig", () => {
  test("normalizes the legacy 'wish' promptMode to 'intelligence'", () => {
    expect(deepAgentPromptModeFromConfig(config({ promptMode: "wish" }))).toBe("intelligence")
  })

  test("passes through the canonical 'intelligence' and 'direct' values", () => {
    expect(deepAgentPromptModeFromConfig(config({ promptMode: "intelligence" }))).toBe("intelligence")
    expect(deepAgentPromptModeFromConfig(config({ promptMode: "direct" }))).toBe("direct")
  })

  test("defaults to 'intelligence' when unset or unrecognized", () => {
    expect(deepAgentPromptModeFromConfig(config({}))).toBe("intelligence")
    expect(deepAgentPromptModeFromConfig(config({ promptMode: "bogus" }))).toBe("intelligence")
    expect(deepAgentPromptModeFromConfig(undefined)).toBe("intelligence")
  })
})

describe("deepAgentIntelligenceModelFromConfig", () => {
  test("reads the legacy `wishModel` key when the new key is absent", () => {
    expect(deepAgentIntelligenceModelFromConfig(config({ wishModel: "zhipuai/glm-4.7" }))).toBe("zhipuai/glm-4.7")
  })

  test("prefers the new `intelligenceModel` key over the legacy `wishModel`", () => {
    expect(
      deepAgentIntelligenceModelFromConfig(config({ intelligenceModel: "openai/gpt-5", wishModel: "zhipuai/glm-4.7" })),
    ).toBe("openai/gpt-5")
  })

  test("returns undefined when neither key holds a non-empty string", () => {
    expect(deepAgentIntelligenceModelFromConfig(config({}))).toBeUndefined()
    expect(deepAgentIntelligenceModelFromConfig(config({ intelligenceModel: "  " }))).toBeUndefined()
    expect(deepAgentIntelligenceModelFromConfig(undefined)).toBeUndefined()
  })
})

describe("deepAgentSubagentIntensityFromConfig", () => {
  test("reads the stored inherit/downgrade values", () => {
    expect(deepAgentSubagentIntensityFromConfig(config({ subagentIntensity: "downgrade" }))).toBe("downgrade")
    expect(deepAgentSubagentIntensityFromConfig(config({ subagentIntensity: "inherit" }))).toBe("inherit")
  })

  test("defaults to 'inherit' when unset or unrecognized", () => {
    expect(deepAgentSubagentIntensityFromConfig(config({}))).toBe("inherit")
    expect(deepAgentSubagentIntensityFromConfig(config({ subagentIntensity: "bogus" }))).toBe("inherit")
    expect(deepAgentSubagentIntensityFromConfig(undefined)).toBe("inherit")
  })
})
