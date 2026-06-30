import { describe, expect, it } from "bun:test"
import { FailureTriage } from "../../src/deepagent/failure-triage"
import type { ValidationResult } from "../../src/deepagent/round-state"

// T2 (S1-v3.4): classifyFailure — fixability × progress, priority RED > YELLOW > GREEN.

const vr = (over: Partial<ValidationResult> = {}): ValidationResult => ({
  command: "tsc",
  passed: false,
  exit_code: 1,
  output: "",
  duration_ms: 1,
  ...over,
})

const base = {
  failed: [vr()],
  changedThisRound: true,
  round: 1,
  previousCategory: null,
  prevFailedCount: undefined,
  stagnant: false,
  errorOutput: null,
} satisfies FailureTriage.TriageInput

describe("failure-triage.classifyFailure", () => {
  describe("🔴 not_auto_fixable (environment)", () => {
    it("exit 127 (command not found) → red", () => {
      const r = FailureTriage.classifyFailure({ ...base, failed: [vr({ exit_code: 127 })] })
      expect(r.tier).toBe("not_auto_fixable")
      expect(r.reason).toMatch(/exit 127/)
    })
    for (const code of [126, 124, 137, 139, 134]) {
      it(`exit ${code} → red`, () => {
        expect(FailureTriage.classifyFailure({ ...base, failed: [vr({ exit_code: code })] }).tier).toBe(
          "not_auto_fixable",
        )
      })
    }
    for (const sig of [
      "Cannot find module 'x'",
      "ENOENT: no such file",
      "ECONNREFUSED 127.0.0.1",
      "ENOSPC: disk full",
      "EACCES: permission denied",
    ]) {
      it(`output "${sig.slice(0, 20)}" → red`, () => {
        const r = FailureTriage.classifyFailure({ ...base, failed: [vr({ output: sig })] })
        expect(r.tier).toBe("not_auto_fixable")
      })
    }
    it("unknown category with NO file change → red", () => {
      // output with no recognized code-error signature, and the model changed nothing this round.
      const r = FailureTriage.classifyFailure({
        ...base,
        changedThisRound: false,
        failed: [vr({ output: "weird gibberish 42" })],
      })
      expect(r.tier).toBe("not_auto_fixable")
      expect(r.reason).toMatch(/environment|no.*signature/i)
    })
    it("unknown category WHILE editing → not red (fixable-in-progress, e.g. bare shell assertion)", () => {
      // an opaque check that fails while the model is actively editing must stay revisable, not escalate.
      const r = FailureTriage.classifyFailure({
        ...base,
        changedThisRound: true,
        failed: [vr({ output: "weird gibberish 42" })],
      })
      expect(r.tier).not.toBe("not_auto_fixable")
    })
    it("runtime_error with NO file change → red (suspected environment)", () => {
      const r = FailureTriage.classifyFailure({
        ...base,
        changedThisRound: false,
        failed: [vr({ output: "TypeError: x is not a function" })],
      })
      expect(r.tier).toBe("not_auto_fixable")
      expect(r.reason).toMatch(/environment/i)
    })
  })

  describe("🟢 auto_fixable", () => {
    it("type error + changed file + first round → green revise", () => {
      const r = FailureTriage.classifyFailure({
        ...base,
        failed: [vr({ output: "error TS2322: Type 'x' is not assignable" })],
      })
      expect(r.tier).toBe("auto_fixable")
      expect(r.category).toBe("type_error")
    })
    it("lint error + changed file → green", () => {
      const r = FailureTriage.classifyFailure({ ...base, failed: [vr({ output: "eslint: 3 errors" })] })
      expect(r.tier).toBe("auto_fixable")
    })
  })

  describe("🟡 needs_narrowing substates", () => {
    it("stall: fingerprint unchanged → stall", () => {
      const r = FailureTriage.classifyFailure({
        ...base,
        stagnant: true,
        failed: [vr({ output: "error TS2322: Type X is not assignable" })],
      })
      expect(r.tier).toBe("needs_narrowing")
      expect(r.substate).toBe("stall")
    })
    it("regression: failures increased → regression", () => {
      const r = FailureTriage.classifyFailure({
        ...base,
        failed: [
          vr({ output: "error TS1: not assignable" }),
          vr({ output: "error TS2: not assignable" }),
          vr({ output: "error TS3: not assignable" }),
        ],
        prevFailedCount: 1,
        previousCategory: "type_error",
      })
      expect(r.tier).toBe("needs_narrowing")
      expect(r.substate).toBe("regression")
    })
    it("regression: category got harder (type_error → build_error) → regression", () => {
      const r = FailureTriage.classifyFailure({
        ...base,
        failed: [vr({ output: "build failed: cannot resolve" })],
        prevFailedCount: 1,
        previousCategory: "type_error",
      })
      expect(r.substate).toBe("regression")
    })
    it("oscillation: category flips, count flat → oscillation", () => {
      const r = FailureTriage.classifyFailure({
        ...base,
        failed: [vr({ output: "eslint: 1 error" })],
        prevFailedCount: 1,
        previousCategory: "type_error",
      })
      expect(r.tier).toBe("needs_narrowing")
      expect(r.substate).toBe("oscillation")
    })
    it("half_progress: failures dropping but not zero → half_progress", () => {
      const r = FailureTriage.classifyFailure({
        ...base,
        failed: [vr({ output: "error TS2322: Type X is not assignable" })],
        prevFailedCount: 3,
        previousCategory: "type_error",
      })
      expect(r.tier).toBe("needs_narrowing")
      expect(r.substate).toBe("half_progress")
    })
  })

  describe("priority", () => {
    it("red beats yellow: env exit code wins even when stagnant", () => {
      const r = FailureTriage.classifyFailure({
        ...base,
        stagnant: true,
        failed: [vr({ exit_code: 127, output: "error TS2322: Type X is not assignable" })],
      })
      expect(r.tier).toBe("not_auto_fixable")
    })
    it("yellow beats green: stall on a fixable category is not green", () => {
      const r = FailureTriage.classifyFailure({
        ...base,
        stagnant: true,
        failed: [vr({ output: "error TS2322: Type X is not assignable" })],
      })
      expect(r.tier).toBe("needs_narrowing")
    })
  })
})
