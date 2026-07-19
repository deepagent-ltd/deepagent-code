import { describe, expect, test } from "bun:test"
import { SessionTools } from "../../src/session/tools"

// Regression guard for the plan-gate WARN reminder placement. The bug: "⚠️ Plan gate: …" was
// PREPENDED to a successful tool's own output, so the model read the leading gate banner as a
// FAILURE/denial and recorded the (exit-0) call as plan-gate-blocked. That false negative was then
// re-surfaced as "previous validation failed" every round, so the model re-diagnosed the same
// non-failure verbatim on every subsequent turn ("the previous 'failures' are again plan-gate
// artifacts — the bash actually returned data"). The fix appends the note AFTER the real output and
// states the command ran, so the result leads and the nudge can't be misread as a block.
describe("appendPlanGateNote (plan-gate false-negative regression)", () => {
  const reason = "the plan is stale (reality changed); review it and update the `plan` tool to resync"
  const realOutput = "compat.cuh\nexit code: 0\nBuild OK"

  test("the real tool output comes FIRST (not behind a gate banner)", () => {
    const noted = SessionTools.appendPlanGateNote(realOutput, reason)
    expect(noted.startsWith(realOutput)).toBe(true)
    // The note must not lead with a warning/gate banner that reads as a failure.
    expect(noted.startsWith("⚠️")).toBe(false)
    expect(noted.startsWith("⚠️ Plan gate")).toBe(false)
  })

  test("states plainly that the command executed (so it is not read as a block)", () => {
    const noted = SessionTools.appendPlanGateNote(realOutput, reason)
    expect(noted).toContain("executed normally")
    expect(noted).toContain("real result")
    // The nudge reason is preserved so the model can still re-sync the plan.
    expect(noted).toContain(reason)
  })

  test("preserves the output verbatim and appends the note at the tail", () => {
    const noted = SessionTools.appendPlanGateNote(realOutput, reason)
    const idxOutput = noted.indexOf(realOutput)
    const idxNote = noted.indexOf("[plan-note]")
    expect(idxOutput).toBe(0)
    expect(idxNote).toBeGreaterThan(idxOutput + realOutput.length)
  })
})
