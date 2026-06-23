import { describe, expect, test } from "bun:test"
import {
  buildRoundReport,
  deriveStatus,
  isConverged,
  reconcile,
  ROUND_REPORT_SCHEMA_VERSION,
  type ModelDeclarations,
  type RunnerGroundTruth,
} from "../../src/deepagent/round-report"

const pass = (command: string) => ({ command, passed: true, output: "ok", duration_ms: 1 })
const fail = (command: string) => ({ command, passed: false, output: "boom", duration_ms: 1 })

const declarations = (over: Partial<ModelDeclarations> = {}): ModelDeclarations => ({
  completion_claim: "complete",
  implementation_summary: "did the thing",
  claimed_change_surface: ["src/a.ts"],
  claimed_doc_updates: [],
  claimed_validation_passed: true,
  ...over,
})

const groundTruth = (over: Partial<RunnerGroundTruth> = {}): RunnerGroundTruth => ({
  validations: [pass("bun test")],
  changed_files: ["src/a.ts"],
  diff_stat: "1 file changed",
  ...over,
})

describe("V3.1 round report (A4 reconciliation)", () => {
  test("reconcile flags a model that claims pass while the runner observed failure", () => {
    const mismatches = reconcile(
      declarations({ claimed_validation_passed: true }),
      groundTruth({ validations: [fail("bun test")] }),
    )
    expect(mismatches.some((m) => m.field === "validation")).toBe(true)
  })

  test("reconcile flags phantom changed files the model claims but never touched", () => {
    const mismatches = reconcile(
      declarations({ claimed_change_surface: ["src/a.ts", "src/ghost.ts"] }),
      groundTruth({ changed_files: ["src/a.ts"] }),
    )
    expect(mismatches.some((m) => m.field === "change_surface" && m.detail.includes("ghost"))).toBe(true)
  })

  test("clean agreement produces no mismatches", () => {
    expect(reconcile(declarations(), groundTruth())).toHaveLength(0)
  })

  test("reconcile treats unverified deterministic results as completion mismatches", () => {
    const mismatches = reconcile(
      declarations({ completion_claim: "complete" }),
      groundTruth({
        deterministic_results: [
          { ref_id: "DETERMINISTIC_RESULT.json", verified_state: "unverified", task_kind: "deterministic_query" },
        ],
      }),
    )
    expect(mismatches).toEqual([
      {
        field: "deterministic_result",
        detail: "model claimed completion but deterministic result refs are not verified: DETERMINISTIC_RESULT.json:unverified",
      },
    ])
  })

  test("convergence requires runner truth, not just the model's claim", () => {
    // Model claims complete + pass, but the runner says a validation failed -> not converged.
    expect(isConverged(declarations(), groundTruth({ validations: [fail("bun test")] }), [])).toBe(false)
    // Model claims complete and the runner agrees -> converged.
    expect(isConverged(declarations(), groundTruth(), [])).toBe(true)
    // A mismatch always blocks convergence even if validations pass.
    expect(isConverged(declarations(), groundTruth(), [{ field: "validation", detail: "x" }])).toBe(false)
    // Model not claiming complete -> never converged.
    expect(isConverged(declarations({ completion_claim: "incomplete" }), groundTruth(), [])).toBe(false)
  })

  test("buildRoundReport stamps schema, reconciles, and sets converged", () => {
    const report = buildRoundReport({
      runId: "run_1",
      sessionID: "ses_1",
      round: 1,
      declarations: declarations(),
      groundTruth: groundTruth(),
    })
    expect(report.schema_version).toBe(ROUND_REPORT_SCHEMA_VERSION)
    expect(report.mismatches).toHaveLength(0)
    expect(report.converged).toBe(true)
  })

  test("deriveStatus is objective: done on convergence, continue when not, needs_human on mismatch/block", () => {
    const converged = buildRoundReport({
      runId: "r",
      sessionID: "s",
      round: 1,
      declarations: declarations(),
      groundTruth: groundTruth(),
    })
    expect(deriveStatus(converged)).toBe("done")

    const notDone = buildRoundReport({
      runId: "r",
      sessionID: "s",
      round: 1,
      declarations: declarations({ completion_claim: "incomplete", claimed_validation_passed: false }),
      groundTruth: groundTruth({ validations: [fail("bun test")] }),
    })
    expect(deriveStatus(notDone)).toBe("continue")

    const lying = buildRoundReport({
      runId: "r",
      sessionID: "s",
      round: 1,
      declarations: declarations({ claimed_validation_passed: true }),
      groundTruth: groundTruth({ validations: [fail("bun test")] }),
    })
    expect(deriveStatus(lying)).toBe("needs_human")

    const blocked = buildRoundReport({
      runId: "r",
      sessionID: "s",
      round: 1,
      declarations: declarations({ completion_claim: "blocked", claimed_validation_passed: false }),
      groundTruth: groundTruth({ validations: [fail("bun test")] }),
    })
    expect(deriveStatus(blocked)).toBe("needs_human")
  })
})
