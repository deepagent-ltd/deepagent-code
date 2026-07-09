import { describe, expect, test } from "bun:test"
import { formatSessionTime } from "./session-time"

// Fixed "now": Wednesday, 2026-07-08 15:30 local.
const now = new Date(2026, 6, 8, 15, 30, 0)

describe("formatSessionTime", () => {
  test("same day -> clock time (HH:MM)", () => {
    const at = new Date(2026, 6, 8, 9, 5, 0)
    expect(formatSessionTime(at, "en-US", now)).toBe("09:05")
  })

  test("earlier today late morning -> clock time", () => {
    const at = new Date(2026, 6, 8, 0, 1, 0)
    expect(formatSessionTime(at, "en-US", now)).toBe("00:01")
  })

  test("yesterday -> weekday", () => {
    const at = new Date(2026, 6, 7, 23, 0, 0) // Tuesday
    expect(formatSessionTime(at, "en-US", now)).toBe("Tue")
  })

  test("6 days ago -> weekday", () => {
    const at = new Date(2026, 6, 2, 10, 0, 0) // Thursday
    expect(formatSessionTime(at, "en-US", now)).toBe("Thu")
  })

  test("exactly 7 calendar days ago -> month-day", () => {
    const at = new Date(2026, 6, 1, 10, 0, 0) // last Wednesday
    expect(formatSessionTime(at, "en-US", now)).toBe("07/01")
  })

  test("8 days ago -> month-day", () => {
    const at = new Date(2026, 5, 30, 10, 0, 0)
    expect(formatSessionTime(at, "en-US", now)).toBe("06/30")
  })

  test("accepts epoch millis", () => {
    const at = new Date(2026, 6, 8, 14, 0, 0).getTime()
    expect(formatSessionTime(at, "en-US", now)).toBe("14:00")
  })

  test("invalid input -> empty string", () => {
    expect(formatSessionTime(Number.NaN, "en-US", now)).toBe("")
  })
})
