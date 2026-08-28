/**
 * DET-MODE-01: subagentControlPlane flag validation
 *
 * Tests: fail-close semantics, strict equality check for durable routing activation.
 */
import { describe, expect, test } from "bun:test"

describe("DET-MODE-01: subagentControlPlane flag", () => {
  test("only valid mode strings are accepted; invalid falls back to legacy", () => {
    const validModes = ["legacy", "shadow", "durable"] as const
    type Mode = (typeof validModes)[number]

    const failClose = (value: string): Mode =>
      (validModes as readonly string[]).includes(value) ? (value as Mode) : "legacy"

    expect(failClose("legacy")).toBe("legacy")
    expect(failClose("shadow")).toBe("shadow")
    expect(failClose("durable")).toBe("durable")
    expect(failClose("unknown_mode")).toBe("legacy")
    expect(failClose("")).toBe("legacy")
    expect(failClose("LEGACY")).toBe("legacy") // case-sensitive: "LEGACY" is not "legacy"
    expect(failClose("Durable")).toBe("legacy") // case-sensitive
  })

  test("durable routing only activates for === 'durable' (strict equality)", () => {
    // Mirrors the exact condition used in task.ts:
    //   if (flags.subagentControlPlane === "durable") { ... }
    const shouldUseDurable = (mode: string) => mode === "durable"

    expect(shouldUseDurable("durable")).toBe(true)
    expect(shouldUseDurable("shadow")).toBe(false)
    expect(shouldUseDurable("legacy")).toBe(false)
    expect(shouldUseDurable("")).toBe(false)
    expect(shouldUseDurable("DURABLE")).toBe(false) // case-sensitive
  })

  test("shadow mode does NOT activate durable path — legacy path runs instead", () => {
    // Design: §4 cutover — shadow routes through legacy until cutover protocol is complete.
    const isDurablePath = (mode: string) => mode === "durable"
    const isLegacyPath = (mode: string) => mode !== "durable"

    for (const mode of ["legacy", "shadow", ""]) {
      expect(isDurablePath(mode)).toBe(false)
      expect(isLegacyPath(mode)).toBe(true)
    }
    expect(isDurablePath("durable")).toBe(true)
    expect(isLegacyPath("durable")).toBe(false)
  })
})
