import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { compareSummaries, writeCompareReport, type CompareThresholds } from "../script/perf-baseline/compare"
import type { SummaryRow } from "../script/perf-baseline/samples"
import { tmpRoot } from "./fixture/tmpdir"

const row = (scenario: string, group: string, values: Partial<SummaryRow>): SummaryRow => ({
  scenario,
  group,
  owner_note: "unit",
  status: "ok",
  unit: "ms",
  n: 5,
  min: 1,
  max: 9,
  mean: 4,
  stdev: 1,
  p50: 4,
  p95: 8,
  p99: 9,
  failures: 0,
  extras: {},
  ...values,
})

const tight: CompareThresholds = { defaultBudgetRatio: 0.25, statistics: ["p50"], noiseFloor: 0.5 }

describe("perf baseline compare (C7-06 / K-07 B-12)", () => {
  test("within budget passes; a real regression fails; noise-floor deltas never fail", () => {
    const baseline = [row("startup", "cold", { p50: 10 })]
    const within = compareSummaries(baseline, [row("startup", "cold", { p50: 12 })], tight)
    expect(within.passed).toBe(true)

    const regressed = compareSummaries(baseline, [row("startup", "cold", { p50: 20 })], tight)
    expect(regressed.passed).toBe(false)
    expect(regressed.regressions).toBe(1)
    expect(regressed.findings).toContainEqual(
      expect.objectContaining({ kind: "compared", scenario: "startup", group: "cold", statistic: "p50", verdict: "regression" }),
    )

    // +30% of budget but only +0.2ms absolute: below the noise floor, never a regression.
    const jitter = compareSummaries(baseline, [row("startup", "cold", { p50: 10.2 })], tight)
    expect(jitter.passed).toBe(true)
  })

  test("improvement is reported without failing the gate", () => {
    const report = compareSummaries([row("startup", "cold", { p50: 10 })], [row("startup", "cold", { p50: 4 })], tight)
    expect(report.passed).toBe(true)
    expect(report.findings.some((finding) => finding.kind === "compared" && finding.verdict === "improved")).toBe(true)
  })

  test("per-key budget overrides (exact beats wildcard beats default)", () => {
    const thresholds: CompareThresholds = {
      defaultBudgetRatio: 0.1,
      budgets: { "startup:cold": 1, "startup:*": 0.5 },
      statistics: ["p50"],
      noiseFloor: 0,
    }
    const baseline = [row("startup", "cold", { p50: 10 }), row("startup", "warm", { p50: 10 }), row("journal", "hydration", { p50: 10 })]
    // cold doubles: within its exact budget of 1.0 (+100%). warm +40%: within wildcard 0.5.
    // journal +60%: over the 0.1 default.
    const candidate = [row("startup", "cold", { p50: 20 }), row("startup", "warm", { p50: 14 }), row("journal", "hydration", { p50: 16 })]
    const report = compareSummaries(baseline, candidate, thresholds)
    expect(report.regressions).toBe(1)
    const journal = report.findings.find((finding) => finding.kind === "compared" && finding.scenario === "journal")
    expect(journal?.verdict).toBe("regression")
  })

  test("unavailable rows are skipped explicitly; a dropped scenario fails the gate", () => {
    const skipped = compareSummaries(
      [row("startup", "cold", { p50: 10 }), row("db", "open", { p50: 5 })],
      [row("startup", "cold", { p50: 10, status: "unavailable" })],
      tight,
    )
    expect(skipped.passed).toBe(false)
    expect(skipped.missing).toBe(1)
    expect(skipped.findings.some((finding) => finding.kind === "skipped" && finding.reason === "candidate_unavailable")).toBe(true)
    expect(skipped.findings.some((finding) => finding.kind === "missing" && finding.group === "open")).toBe(true)
  })

  test("unit mismatch and missing statistic skip the row, never silently compare", () => {
    const mismatch = compareSummaries([row("mem", "rss", { unit: "MiB", p50: 100 })], [row("mem", "rss", { unit: "ms", p50: 100 })], tight)
    expect(mismatch.findings.some((finding) => finding.kind === "skipped" && finding.reason === "unit_mismatch")).toBe(true)

    const noStat = compareSummaries([row("startup", "cold", { p50: 10 })], [row("startup", "cold", { p50: undefined })], tight)
    expect(noStat.findings.some((finding) => finding.kind === "skipped" && finding.reason === "insufficient_samples")).toBe(true)
  })

  test("writeCompareReport lands a deterministic JSON artifact in the candidate run dir", () => {
    const dir = tmpRoot()
    const report = compareSummaries([row("startup", "cold", { p50: 10 })], [row("startup", "cold", { p50: 10 })], tight)
    const target = writeCompareReport(dir, report)
    const body = JSON.parse(fs.readFileSync(target, "utf8") as unknown as string)
    expect(path.basename(target)).toBe("compare.json")
    expect(body.passed).toBe(true)
    expect(body.regressions).toBe(0)
  })
})
