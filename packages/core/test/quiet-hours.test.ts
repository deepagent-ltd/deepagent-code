import { describe, expect, test } from "bun:test"
import { QuietHours } from "@deepagent-code/core/deepagent/quiet-hours"

// QuietHours.decide + isWithinQuietHours are PURE functions — plain unit tests.

describe("QuietHours.decide — §E4 four branches", () => {
  test("outside quiet hours → deliver (any priority)", () => {
    expect(QuietHours.decide({ priority: "low", withinQuietHours: false })).toEqual({ action: "deliver" })
    expect(QuietHours.decide({ priority: "critical", withinQuietHours: false })).toEqual({
      action: "deliver",
    })
  })

  test("inside quiet hours, low/normal → digest", () => {
    expect(QuietHours.decide({ priority: "low", withinQuietHours: true })).toEqual({ action: "digest" })
    expect(QuietHours.decide({ priority: "normal", withinQuietHours: true })).toEqual({ action: "digest" })
  })

  test("inside quiet hours, high/critical → deliver with requiresReason", () => {
    expect(QuietHours.decide({ priority: "high", withinQuietHours: true })).toEqual({
      action: "deliver",
      requiresReason: true,
    })
    expect(QuietHours.decide({ priority: "critical", withinQuietHours: true })).toEqual({
      action: "deliver",
      requiresReason: true,
    })
  })
})

describe("QuietHours.isWithinQuietHours — §E4 window math", () => {
  // helper: epoch ms for a given UTC hour.
  const utcHour = (h: number) => h * 3_600_000

  test("simple window [1, 5) in UTC", () => {
    expect(QuietHours.isWithinQuietHours(utcHour(0), 1, 5)).toBe(false)
    expect(QuietHours.isWithinQuietHours(utcHour(1), 1, 5)).toBe(true) // inclusive start
    expect(QuietHours.isWithinQuietHours(utcHour(4), 1, 5)).toBe(true)
    expect(QuietHours.isWithinQuietHours(utcHour(5), 1, 5)).toBe(false) // exclusive end
  })

  test("wrap-around window 22 → 6 spans midnight", () => {
    expect(QuietHours.isWithinQuietHours(utcHour(22), 22, 6)).toBe(true)
    expect(QuietHours.isWithinQuietHours(utcHour(23), 22, 6)).toBe(true)
    expect(QuietHours.isWithinQuietHours(utcHour(0), 22, 6)).toBe(true)
    expect(QuietHours.isWithinQuietHours(utcHour(5), 22, 6)).toBe(true)
    expect(QuietHours.isWithinQuietHours(utcHour(6), 22, 6)).toBe(false) // exclusive end
    expect(QuietHours.isWithinQuietHours(utcHour(12), 22, 6)).toBe(false)
  })

  test("empty window when start === end → never quiet", () => {
    expect(QuietHours.isWithinQuietHours(utcHour(3), 5, 5)).toBe(false)
  })

  test("tzOffsetMinutes shifts the local hour", () => {
    // 22:00 UTC is 06:00 at UTC+8 → outside a 22→6 window in local time.
    expect(QuietHours.isWithinQuietHours(utcHour(22), 22, 6, 480)).toBe(false)
    // 14:00 UTC is 22:00 at UTC+8 → inside the window.
    expect(QuietHours.isWithinQuietHours(utcHour(14), 22, 6, 480)).toBe(true)
    // negative offset (UTC-5): 04:00 UTC is 23:00 previous day → inside 22→6.
    expect(QuietHours.isWithinQuietHours(utcHour(4), 22, 6, -300)).toBe(true)
  })
})
