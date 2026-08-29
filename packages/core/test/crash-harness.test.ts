import { describe, expect, test } from "bun:test"
import { runAllFetch, classify, runScenario, assertUniquePoints, type ScenarioResult } from "../script/crash-harness/scenario-runner"

describe("C0-04 crash-point harness", () => {
  test("crash point ids are unique and well-formed", () => {
    expect(() => assertUniquePoints()).not.toThrow()
  })

  test("oracle classification table is exact", () => {
    expect(classify(true, true)).toBe("converged")
    expect(classify(true, false)).toBe("indeterminate")
    expect(classify(false, false)).toBe("converged")
    expect(classify(false, true)).toBe("divergent")
  })

  test("kill before commit -> converged (no side effect persisted)", async () => {
    const result = await runScenario({ scenarioId: "before", crashPointId: "CRASH-migration-receipt-002", killAt: "before-commit" })
    expect(result.dbRow).toBe(false)
    expect(result.doneMarker).toBe(false)
    expect(result.outcome).toBe("converged")
    expect(result.pass).toBe(true)
  }, 30000)

  test("kill after commit, before done marker -> indeterminate (persisted but unsealed)", async () => {
    const result = await runScenario({ scenarioId: "after", crashPointId: "CRASH-tool-effect-001", killAt: "after-commit" })
    expect(result.dbRow).toBe(true)
    expect(result.doneMarker).toBe(false)
    expect(result.outcome).toBe("indeterminate")
    expect(result.pass).toBe(true)
  }, 30000)

  test("full run -> converged", async () => {
    const result = await runScenario({ scenarioId: "full", crashPointId: "CRASH-migration-receipt-002", killAt: "never" })
    expect(result.dbRow).toBe(true)
    expect(result.doneMarker).toBe(true)
    expect(result.outcome).toBe("converged")
    expect(result.pass).toBe(true)
  }, 30000)

  test("all fetch scenarios pass against their frozen expectations", async () => {
    const results: readonly ScenarioResult[] = await runAllFetch()
    for (const r of results) expect(r.pass).toBe(true)
  }, 90000)
})
