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

  test("stop clears both session and directory overrides so the next turn uses the configured default", () => {
    setScenarioOverride("ses_d", "wish")
    setScenarioOverride("dir_d", "wish")
    resetScenarioOnStop("ses_d", "dir_d")
    // Cleared, not pinned to "direct": resolution now falls through to the configured default,
    // and a pinned session key can no longer shadow a later dir-key toggle back to wish.
    expect(getScenarioOverride("ses_d")).toBeUndefined()
    expect(getScenarioOverride("dir_d")).toBeUndefined()
    expect(resolveScenarioOverride("ses_d", "dir_d")).toBeUndefined()
  })

  test("after stop, re-toggling wish on the directory key re-engages wish at submit time", () => {
    // Repro of the 'exit wish -> can never re-enter' bug: previously stop pinned the SESSION key to
    // "direct", which submit resolves before the dir key, so the toggle (dir key only) was shadowed.
    setScenarioOverride("ses_f", "wish")
    resetScenarioOnStop("ses_f", "dir_f")
    setScenarioOverride("dir_f", "wish") // user re-selects wish via the toggle
    expect(resolveScenarioOverride("ses_f", "dir_f")).toBe("wish")
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
