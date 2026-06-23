import { describe, expect, test } from "bun:test"
import { run, gate, formatManifest, type AblationRunner } from "../../src/deepagent/ablation"

const TASKS = ["t1", "t2", "t3"]

describe("V3 ablation regression gate", () => {
  test("blocks when MAX regresses vs HIGH and names the offender", () => {
    // MAX regresses on t2 (misleading knowledge); fine elsewhere.
    const runner: AblationRunner = (group, task) => {
      const base = { general: 0.6, high: 0.7, max: 0.78 }[group]
      if (group === "max" && task === "t2") return 0.5 // worse than HIGH=0.7
      return base
    }
    const report = run(TASKS, "snap:x", runner)
    const verdict = gate(report, 0)
    expect(verdict.pass).toBe(false)
    expect(verdict.offenders).toEqual(["t2"])
  })

  test("passes when MAX never regresses (and reports net gain)", () => {
    const runner: AblationRunner = (group) => ({ general: 0.6, high: 0.7, max: 0.78 })[group]
    const report = run(TASKS, "snap:x", runner)
    const verdict = gate(report, 0)
    expect(verdict.pass).toBe(true)
    expect(verdict.offenders).toEqual([])
    expect(report.perGroup.max).toBeGreaterThan(report.perGroup.high)
  })

  test("MAX == HIGH is allowed (no regression)", () => {
    const runner: AblationRunner = (group) => ({ general: 0.5, high: 0.6, max: 0.6 })[group]
    expect(gate(run(TASKS, "snap:x", runner), 0).pass).toBe(true)
  })

  test("tolerance allows a small dip", () => {
    const runner: AblationRunner = (group, task) => {
      if (group === "max" && task === "t2") return 0.69
      return { general: 0.6, high: 0.7, max: 0.75 }[group]
    }
    const report = run(TASKS, "snap:x", runner)
    expect(gate(report, 0).pass).toBe(false) // strict: any dip fails
    expect(gate(report, 0.05).pass).toBe(true) // 0.01 dip within 0.05 tolerance
  })

  test("repeats average the metric", () => {
    let n = 0
    const runner: AblationRunner = () => (n++ % 2 === 0 ? 0.6 : 0.8) // alternates
    const report = run(["t1"], "snap:x", runner, 2)
    expect(report.perTask[0]!.gen).toBeCloseTo(0.7) // (0.6+0.8)/2
  })

  test("formatManifest carries the rule and verdict", () => {
    const report = run(TASKS, "snap:x", (g) => ({ general: 0.6, high: 0.7, max: 0.78 })[g])
    const manifest = formatManifest(report, gate(report, 0)) as any
    expect(manifest.schema_version).toBe("ablation_regression_gate.v1")
    expect(manifest.snapshot_id).toBe("snap:x")
    expect(manifest.verdict.pass).toBe(true)
    expect(manifest.verdict.rule).toContain("must not regress")
  })
})
