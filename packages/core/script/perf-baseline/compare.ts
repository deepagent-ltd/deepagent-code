export * as PerfCompare from "./compare"

import * as fs from "node:fs"
import * as path from "node:path"
import { UNIT, type SummaryRow } from "./samples"

// C7-06 / K-07 B-12 — budget/threshold assertions for perf attribution. A baseline run and a
// candidate run each produce `summaries.jsonl` (one row per scenario×group, written by
// buildAndWriteManifest). This module compares them under an explicit regression budget and
// decides pass/fail deterministically, so a perf attribution claim is a machine-checked gate
// instead of eyeballed numbers.
//
// Rules (kept deliberately small and total):
//   - Rows are matched by (scenario, group). Only rows with status "ok" on BOTH sides compare;
//     unavailable/error rows are surface findings, never silent.
//   - For each compared statistic (default p50 and p95): regression ⇔ candidate > baseline ×
//     (1 + budget) AND candidate − baseline > noiseFloor (absolute, in the row's unit — machine
//     jitter below the floor never fails the gate).
//   - Budgets default for all rows, overridable per "scenario:group" (or "scenario:*").
//   - A row present in the baseline but missing from the candidate is a "missing" finding that
//     fails the gate: dropping a scenario from a perf run must never pass silently.

export type StatisticKey = "p50" | "p95" | "p99" | "mean"

export interface CompareThresholds {
  /** Default regression budget as a ratio: candidate may exceed baseline by this fraction. */
  readonly defaultBudgetRatio: number
  /** Per-row overrides keyed `scenario:group` or `scenario:*` (exact key wins over wildcard). */
  readonly budgets?: Readonly<Record<string, number>>
  /** Statistics compared per row; every listed statistic must stay within budget. */
  readonly statistics: readonly StatisticKey[]
  /** Absolute difference below this value (in the row's unit) is machine noise, not regression. */
  readonly noiseFloor: number
}

export const DEFAULT_THRESHOLDS: CompareThresholds = {
  defaultBudgetRatio: 0.25,
  statistics: ["p50", "p95"],
  noiseFloor: 0.5,
}

export type Finding =
  | {
      readonly kind: "compared"
      readonly scenario: string
      readonly group: string
      readonly statistic: StatisticKey
      readonly baseline: number
      readonly candidate: number
      readonly budget: number
      readonly verdict: "within" | "regression" | "improved"
    }
  | { readonly kind: "skipped"; readonly scenario: string; readonly group: string; readonly reason: "baseline_unavailable" | "candidate_unavailable" | "unit_mismatch" | "insufficient_samples" }
  | { readonly kind: "missing"; readonly scenario: string; readonly group: string }

export interface CompareReport {
  readonly findings: readonly Finding[]
  readonly regressions: number
  readonly missing: number
  /** Scenarios the baseline measured but this run could not (status != ok): failing, not skipping. */
  readonly unavailable: number
  readonly passed: boolean
}

const rowKey = (row: SummaryRow) => `${String(row.scenario)}\0${String(row.group)}`

const numeric = (row: SummaryRow, key: StatisticKey): number | undefined => {
  const value = row[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const budgetFor = (thresholds: CompareThresholds, scenario: string, group: string): number => {
  const exact = thresholds.budgets?.[`${scenario}:${group}`]
  if (exact !== undefined) return exact
  const wildcard = thresholds.budgets?.[`${scenario}:*`]
  if (wildcard !== undefined) return wildcard
  return thresholds.defaultBudgetRatio
}

const readSummaries = (runDir: string): SummaryRow[] => {
  const file = path.join(runDir, "summaries.jsonl")
  const body = fs.readFileSync(file, "utf8")
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SummaryRow)
}

export const compareSummaries = (
  baselineRows: readonly SummaryRow[],
  candidateRows: readonly SummaryRow[],
  thresholds: CompareThresholds = DEFAULT_THRESHOLDS,
): CompareReport => {
  const baselineByKey = new Map(baselineRows.map((row) => [rowKey(row), row]))
  const candidateByKey = new Map(candidateRows.map((row) => [rowKey(row), row]))
  const findings: Finding[] = []

  for (const [key, baseline] of baselineByKey) {
    const candidate = candidateByKey.get(key)
    const [scenario, group] = key.split("\0")
    if (!candidate) {
      findings.push({ kind: "missing", scenario, group })
      continue
    }
    if (baseline.status !== "ok" || candidate.status !== "ok") {
      findings.push({ kind: "skipped", scenario, group, reason: baseline.status !== "ok" ? "baseline_unavailable" : "candidate_unavailable" })
      continue
    }
    const unit = typeof candidate.unit === "string" ? candidate.unit : UNIT
    const baselineUnit = typeof baseline.unit === "string" ? baseline.unit : UNIT
    if (unit !== baselineUnit) {
      findings.push({ kind: "skipped", scenario, group, reason: "unit_mismatch" })
      continue
    }
    const budget = budgetFor(thresholds, scenario, group)
    let comparedAny = false
    for (const statistic of thresholds.statistics) {
      const baseValue = numeric(baseline, statistic)
      const candidateValue = numeric(candidate, statistic)
      if (baseValue === undefined || candidateValue === undefined) continue
      comparedAny = true
      const regression = candidateValue > baseValue * (1 + budget) && candidateValue - baseValue > thresholds.noiseFloor
      const verdict = regression ? "regression" : candidateValue < baseValue * (1 - budget) ? "improved" : "within"
      findings.push({ kind: "compared", scenario, group, statistic, baseline: baseValue, candidate: candidateValue, budget, verdict })
    }
    if (!comparedAny) findings.push({ kind: "skipped", scenario, group, reason: "insufficient_samples" })
  }

  const regressions = findings.filter((finding) => finding.kind === "compared" && finding.verdict === "regression").length
  const missing = findings.filter((finding) => finding.kind === "missing").length
  // Cross-review P2-11: a scenario the baseline measured but this run could not is a
  // measurement failure of THIS run — the gate fails rather than silently narrowing coverage.
  const unavailable = findings.filter(
    (finding) => finding.kind === "skipped" && finding.reason === "candidate_unavailable",
  ).length
  return { findings, regressions, missing, unavailable, passed: regressions === 0 && missing === 0 && unavailable === 0 }
}

export const compareRunDirectories = (baselineDir: string, candidateDir: string, thresholds?: CompareThresholds): CompareReport =>
  compareSummaries(readSummaries(baselineDir), readSummaries(candidateDir), thresholds)

export const writeCompareReport = (candidateDir: string, report: CompareReport): string => {
  const target = path.join(candidateDir, "compare.json")
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`)
  fs.renameSync(temp, target)
  return target
}
