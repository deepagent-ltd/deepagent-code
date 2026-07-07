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
    setScenarioOverride("ses_a", "intelligence")
    expect(getScenarioOverride("ses_a")).toBe("intelligence")
    setScenarioOverride("ses_a", "direct")
    expect(getScenarioOverride("ses_a")).toBe("direct")
  })

  test("keys are isolated", () => {
    setScenarioOverride("ses_b", "intelligence")
    expect(getScenarioOverride("ses_c")).toBeUndefined()
  })

  test("resolve prefers session key, falls back to directory key", () => {
    setScenarioOverride("dir_x", "intelligence")
    // No session override yet -> directory-scoped intelligence applies (toggle set before session exists).
    expect(resolveScenarioOverride("ses_new", "dir_x")).toBe("intelligence")
    // A session override takes precedence over the directory one.
    setScenarioOverride("ses_new", "direct")
    expect(resolveScenarioOverride("ses_new", "dir_x")).toBe("direct")
  })

  test("stop clears both session and directory overrides so the next turn uses the configured default", () => {
    setScenarioOverride("ses_d", "intelligence")
    setScenarioOverride("dir_d", "intelligence")
    resetScenarioOnStop("ses_d", "dir_d")
    // Cleared, not pinned to "direct": resolution now falls through to the configured default,
    // and a pinned session key can no longer shadow a later dir-key toggle back to intelligence.
    expect(getScenarioOverride("ses_d")).toBeUndefined()
    expect(getScenarioOverride("dir_d")).toBeUndefined()
    expect(resolveScenarioOverride("ses_d", "dir_d")).toBeUndefined()
  })

  test("after stop, re-toggling intelligence on the directory key re-engages intelligence at submit time", () => {
    // Repro of the 'exit intelligence -> can never re-enter' bug: previously stop pinned the SESSION key to
    // "direct", which submit resolves before the dir key, so the toggle (dir key only) was shadowed.
    setScenarioOverride("ses_f", "intelligence")
    resetScenarioOnStop("ses_f", "dir_f")
    setScenarioOverride("dir_f", "intelligence") // user re-selects intelligence via the toggle
    expect(resolveScenarioOverride("ses_f", "dir_f")).toBe("intelligence")
  })

  test("listeners are notified when overrides change", () => {
    let count = 0
    const unsubscribe = subscribeScenarioOverride(() => count++)
    setScenarioOverride("ses_e", "intelligence")
    resetScenarioOnStop("ses_e")
    unsubscribe()
    setScenarioOverride("ses_e", "direct")
    expect(count).toBe(2)
  })
})
