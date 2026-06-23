import { describe, expect, test } from "bun:test"
import {
  setScenarioOverride,
  getScenarioOverride,
  resolveScenarioOverride,
  resetScenarioOnStop,
  subscribeScenarioOverride,
} from "./scenario-override"

// D1/D3: the scenario override is the backend spine of the send-adjacent scenario toggle (D1)
// and the stop->direct reset (D3). These verify the observable contract submit.ts reads when
// choosing the turn's prompt pipeline mode.
describe("scenario override (D1/D3)", () => {
  test("override is read back per key", () => {
    setScenarioOverride("ses_a", "wish")
    expect(getScenarioOverride("ses_a")).toBe("wish")
    setScenarioOverride("ses_a", "direct")
    expect(getScenarioOverride("ses_a")).toBe("direct")
  })

  test("keys are isolated", () => {
    setScenarioOverride("ses_b", "wish")
    expect(getScenarioOverride("ses_c")).toBeUndefined()
  })

  test("resolve prefers session key, falls back to directory key", () => {
    setScenarioOverride("dir_x", "wish")
    // No session override yet -> directory-scoped wish applies (toggle set before session exists).
    expect(resolveScenarioOverride("ses_new", "dir_x")).toBe("wish")
    // A session override takes precedence over the directory one.
    setScenarioOverride("ses_new", "direct")
    expect(resolveScenarioOverride("ses_new", "dir_x")).toBe("direct")
  })

  test("stop resets both session and directory keys to direct (fail-safe)", () => {
    setScenarioOverride("ses_d", "wish")
    setScenarioOverride("dir_d", "wish")
    resetScenarioOnStop("ses_d", "dir_d")
    expect(getScenarioOverride("ses_d")).toBe("direct")
    expect(getScenarioOverride("dir_d")).toBe("direct")
  })

  test("listeners are notified when overrides change", () => {
    let count = 0
    const unsubscribe = subscribeScenarioOverride(() => count++)
    setScenarioOverride("ses_e", "wish")
    resetScenarioOnStop("ses_e")
    unsubscribe()
    setScenarioOverride("ses_e", "direct")
    expect(count).toBe(2)
  })
})
