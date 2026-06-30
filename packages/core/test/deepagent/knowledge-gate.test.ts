import { describe, expect, test } from "bun:test"
import { evaluateSnapshot, formatGateManifest } from "../../src/deepagent/knowledge-gate"
import type { AblationRunner } from "../../src/deepagent/ablation"

const TASKS = ["t1", "t2", "t3"]

describe("V3 knowledge-snapshot ship gate", () => {
  test("ships when MAX never regresses", () => {
    const runner: AblationRunner = (g) => ({ general: 0.6, high: 0.7, max: 0.78 })[g]
    const d = evaluateSnapshot("snap:ok", TASKS, runner)
    expect(d.ship).toBe(true)
    expect(d.offenders).toEqual([])
    expect(formatGateManifest(d).enforcement).toBe("blocking")
  })

  test("blocks and names offenders when MAX regresses", () => {
    const runner: AblationRunner = (g, t) =>
      g === "max" && t === "t2" ? 0.5 : { general: 0.6, high: 0.7, max: 0.78 }[g]
    const d = evaluateSnapshot("snap:bad", TASKS, runner)
    expect(d.ship).toBe(false)
    expect(d.offenders).toEqual(["t2"])
    expect(formatGateManifest(d).ship).toBe(false)
  })

  test("refuses to ship without held-out tasks", () => {
    const d = evaluateSnapshot("snap:empty", [], () => 1)
    expect(d.ship).toBe(false)
    expect(d.reason).toContain("no held-out")
  })
})
