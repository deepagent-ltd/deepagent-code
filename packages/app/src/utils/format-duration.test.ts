import { describe, expect, test } from "bun:test"
import { formatDuration } from "./format-duration"

// Minimal English-ish translator that mirrors the ui i18n templates.
const t = (key: string, params?: Record<string, string | number>) => {
  const p = params ?? {}
  if (key === "ui.message.duration.seconds") return `${p.count}s`
  if (key === "ui.message.duration.minutesSeconds") return `${p.minutes}m ${p.seconds}s`
  if (key === "ui.message.duration.hoursMinutes") return `${p.hours}h ${p.minutes}m`
  return key
}
const fmt = (n: number) => String(n)

describe("formatDuration", () => {
  test("under a minute -> seconds", () => {
    expect(formatDuration(4_200, t as never, fmt)).toBe("4s")
    expect(formatDuration(59_000, t as never, fmt)).toBe("59s")
  })

  test("under an hour -> minutes + seconds", () => {
    expect(formatDuration(60_000, t as never, fmt)).toBe("1m 0s")
    expect(formatDuration(90_000, t as never, fmt)).toBe("1m 30s")
  })

  test("an hour or more -> hours + minutes", () => {
    expect(formatDuration(3_600_000, t as never, fmt)).toBe("1h 0m")
    expect(formatDuration(3_930_000, t as never, fmt)).toBe("1h 5m")
  })

  test("negative / NaN -> empty string", () => {
    expect(formatDuration(-1, t as never, fmt)).toBe("")
    expect(formatDuration(Number.NaN, t as never, fmt)).toBe("")
  })
})
