import { describe, expect, test } from "bun:test"
import { promptIntelligenceMode } from "../../src/prompt/intelligence-mode"

describe("promptIntelligenceMode", () => {
  test("uses the same configured default as the GUI", () => {
    expect(promptIntelligenceMode({ configMode: undefined, overrides: {}, directory: "/project" })).toBe(true)
    expect(promptIntelligenceMode({ configMode: "wish", overrides: {}, directory: "/project" })).toBe(true)
    expect(promptIntelligenceMode({ configMode: "direct", overrides: {}, directory: "/project" })).toBe(false)
  })

  test("directory and session choices override the default in order", () => {
    const overrides = { "directory:/project": false, session: true }
    expect(promptIntelligenceMode({ overrides, directory: "/project" })).toBe(false)
    expect(promptIntelligenceMode({ overrides, directory: "/other" })).toBe(true)
    expect(promptIntelligenceMode({ overrides, directory: "/project", sessionID: "session" })).toBe(true)
    expect(
      promptIntelligenceMode({
        configMode: "intelligence",
        overrides: { session: false },
        directory: "/project",
        sessionID: "session",
      }),
    ).toBe(false)
  })
})
