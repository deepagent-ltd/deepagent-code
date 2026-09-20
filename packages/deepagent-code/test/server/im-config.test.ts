import { describe, expect, test } from "bun:test"
import { boundedPositiveInteger } from "../../src/server/routes/instance/httpapi/handlers/im-config"

describe("IM numeric configuration", () => {
  test("accepts positive safe integers and clamps the maximum", () => {
    expect(boundedPositiveInteger("7", 5, 10)).toBe(7)
    expect(boundedPositiveInteger("100", 5, 10)).toBe(10)
  })

  test("fails safe for missing, fractional, non-finite, zero and negative values", () => {
    for (const value of [undefined, "", "1.5", "NaN", "Infinity", "0", "-1"])
      expect(boundedPositiveInteger(value, 5, 10)).toBe(5)
  })
})
