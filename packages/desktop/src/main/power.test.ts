import { describe, expect, test } from "bun:test"
import { resolvePreventSleepEnabled } from "./prevent-sleep"

// Covers the persisted-setting semantics of the sleep-prevention toggle without the Electron
// runtime. The same resolution runs in power.ts on startup and on every settings change.

describe("resolvePreventSleepEnabled", () => {
  test("defaults to enabled when the setting was never stored (historical always-on behavior)", () => {
    expect(resolvePreventSleepEnabled(undefined)).toBe(true)
  })

  test("treats any value other than explicit false as enabled", () => {
    expect(resolvePreventSleepEnabled(true)).toBe(true)
    expect(resolvePreventSleepEnabled(null)).toBe(true)
    expect(resolvePreventSleepEnabled("false")).toBe(true)
  })

  test("disables only on explicit false", () => {
    expect(resolvePreventSleepEnabled(false)).toBe(false)
  })
})
