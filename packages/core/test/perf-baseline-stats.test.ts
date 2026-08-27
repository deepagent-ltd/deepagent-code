import { describe, expect, test } from "bun:test"
import {
  DISPERSION_RERUN_RATIO,
  dispersionVerdict,
  EmptySamplesError,
  PerfStats,
  percentile,
  round,
  slopePerStep,
  STAT_METHOD,
  summarize,
} from "../script/perf-baseline/stats"

describe("perf baseline statistics", () => {
  test("linear interpolation percentile on arithmetic progression", () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1)
    expect(percentile(samples, 50)).toBe(50.5)
    expect(percentile(samples, 95)).toBeCloseTo(95.05, 10)
    expect(percentile(samples, 99)).toBeCloseTo(99.01, 10)
    expect(percentile(samples, 0)).toBe(1)
    expect(percentile(samples, 100)).toBe(100)
  })

  test("single sample collapses every quantile onto itself", () => {
    expect(percentile([42], 50)).toBe(42)
    expect(percentile([42], 95)).toBe(42)
    expect(percentile([42], 99)).toBe(42)
  })

  test("input order does not affect results", () => {
    const ordered = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const shuffled = [6, 1, 10, 3, 8, 2, 9, 4, 7, 5]
    expect(percentile(shuffled, 90)).toBe(percentile(ordered, 90))
    expect(summarize(shuffled).p99).toBe(summarize(ordered).p99)
  })

  test("classic population stdev example", () => {
    const summary = summarize([2, 4, 4, 4, 5, 5, 7, 9])
    expect(summary.n).toBe(8)
    expect(summary.mean).toBe(5)
    expect(summary.stdev).toBe(2)
    expect(summary.min).toBe(2)
    expect(summary.max).toBe(9)
  })

  test("extreme outliers are never trimmed away", () => {
    const base = Array.from({ length: 100 }, (_, index) => index + 1)
    const polluted = [...base, 1_000_000_000]
    expect(summarize(polluted).max).toBe(1_000_000_000)
    expect(summarize(polluted).p99).toBeGreaterThan(summarize(base).p99)
    expect(summarize(polluted).n).toBe(101)
  })

  test("empty and invalid input are rejected loudly", () => {
    expect(() => summarize([])).toThrow(EmptySamplesError)
    expect(() => percentile([], 50)).toThrow(EmptySamplesError)
    expect(() => summarize([1, Number.NaN])).toThrow(TypeError)
    expect(() => percentile([1], 150)).toThrow(RangeError)
  })

  test("least squares slope recovers exact linear rates", () => {
    expect(slopePerStep([3, 5, 7, 9])).toBe(2)
    expect(slopePerStep([0, -2, -4, -6])).toBe(-2)
    expect(slopePerStep([4, 4, 4])).toBe(0)
    expect(() => slopePerStep([1])).toThrow(EmptySamplesError)
  })

  test("declared method string is exported verbatim", () => {
    expect(STAT_METHOD).toContain("no trimming")
  })

  test("dispersion verdict schedules a rerun only for heavy-tailed samples", () => {
    expect(DISPERSION_RERUN_RATIO).toBe(3)
    const tight = Array.from({ length: 100 }, (_, index) => 90 + (index % 5))
    const tightVerdict = dispersionVerdict(tight)
    expect(tightVerdict.rerun_required).toBe(false)

    const heavyTail = [...Array.from({ length: 100 }, () => 10), 500, 900]
    const heavyVerdict = dispersionVerdict(heavyTail)
    expect(heavyVerdict.rerun_required).toBe(true)
    expect(heavyVerdict.ratio_p99_over_p50).toBeGreaterThan(DISPERSION_RERUN_RATIO)
  })

  test("dispersion verdict refuses to fire on a degenerate all-zero baseline", () => {
    const verdict = dispersionVerdict([0, 0, 0, 0])
    expect(verdict.rerun_required).toBe(false)
    expect(verdict.ratio_p99_over_p50).toBe(0)
  })

  test("round keeps requested precision", () => {
    expect(round(1.23456, 3)).toBe(1.235)
    expect(round(1.23456)).toBe(1.235)
    expect(round(Number.NaN)).toBeNaN()
  })
})
