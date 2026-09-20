import { describe, expect, test } from "bun:test"
import { flipFlagValueOn } from "../../src/deepagent/flip-flag"

// W0.1 M1: the single repo-wide flag table. Every consumer (entry defaults, core gates, Effect
// Config path) must agree on this table — pins it directly so a future consumer change cannot
// silently fork the semantics again.
describe("flipFlagValueOn (single flag table)", () => {
  test("absent key follows the context default", () => {
    expect(flipFlagValueOn(undefined, true)).toBe(true)
    expect(flipFlagValueOn(undefined, false)).toBe(false)
  })

  test("defined off values: \"\" / \"false\" / \"0\" (case + whitespace tolerant)", () => {
    for (const off of ["", "false", "FALSE", " False ", "0", "0 ", "\t0\n", "false\n", " FALSE "]) {
      expect(flipFlagValueOn(off, true)).toBe(false)
      expect(flipFlagValueOn(off, false)).toBe(false)
    }
  })

  test("any other defined value is ON regardless of the unset default", () => {
    for (const on of ["true", "TRUE", " true ", "1", "1 ", "yes", "2", " anything "]) {
      expect(flipFlagValueOn(on, true)).toBe(true)
      expect(flipFlagValueOn(on, false)).toBe(true)
    }
  })
})
