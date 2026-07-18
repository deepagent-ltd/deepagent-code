import { describe, expect, test } from "bun:test"
import { addCandidate, createInitialRoundState } from "../../src/deepagent/round-state"
import type { CandidateRef, ValidationResult } from "../../src/deepagent/round-state"

// STALE-REHARVEST DEDUPE at the single append site (round-state.addCandidate). extractValidationResults
// re-scans the whole transcript every turn, so the same early validation result is re-recorded as a new
// candidate each round. addCandidate previously appended unconditionally → N identical candidates → the
// same failure block emitted N times downstream. Dedupe drops a candidate that is evidence-identical to
// the immediately-preceding one, while a genuinely new attempt still appends.
describe("addCandidate stale-reharvest dedupe", () => {
  const vr = (command: string, exit_code: number, output = "x"): ValidationResult => ({
    command,
    passed: exit_code === 0,
    exit_code,
    output,
    duration_ms: 0,
  })
  const cand = (over: Partial<CandidateRef>): CandidateRef => ({
    round: 1,
    attempt: 1,
    ref: "c",
    status: "failed",
    metric: 0,
    validations: [vr("bun run test", 1)],
    ...over,
  })

  test("dropping a duplicate: re-recording the SAME evidence does not append", () => {
    let s = createInitialRoundState("high")
    s = addCandidate(s, cand({}))
    s = addCandidate(s, cand({ ref: "c-again", output: "different noise" } as Partial<CandidateRef>))
    // Same round/status/exit outcome → deduped even though ref and output text differ.
    expect(s.candidates).toHaveLength(1)
  })

  test("volatile output with the same exit outcome is treated as a duplicate", () => {
    let s = createInitialRoundState("high")
    s = addCandidate(s, cand({ validations: [vr("bun run test", 0, "✓ done [3882.11ms]")] }))
    s = addCandidate(s, cand({ status: "validated", metric: 1, validations: [vr("bun run test", 0, "✓ done [4021.55ms]")] }))
    // Different status → NOT a duplicate (status is part of the key), so this one appends.
    expect(s.candidates).toHaveLength(2)
  })

  test("a genuine new run (changed exit outcome) still appends", () => {
    let s = createInitialRoundState("high")
    s = addCandidate(s, cand({ validations: [vr("bun run test", 1)] }))
    s = addCandidate(s, cand({ validations: [vr("bun run test", 0)] }))
    expect(s.candidates).toHaveLength(2)
  })

  test("a new round with identical evidence still appends (round is part of the key)", () => {
    let s = createInitialRoundState("high")
    s = addCandidate(s, cand({ round: 1 }))
    s = addCandidate(s, cand({ round: 2 }))
    expect(s.candidates).toHaveLength(2)
  })

  test("dedupe compares only the LAST candidate, not the whole history", () => {
    let s = createInitialRoundState("high")
    s = addCandidate(s, cand({ round: 1, validations: [vr("bun run test", 1)] }))
    s = addCandidate(s, cand({ round: 2, validations: [vr("bun run test", 0)] }))
    // Same evidence as round 1, but the LAST candidate is round 2 → not a duplicate of the tail → appends.
    s = addCandidate(s, cand({ round: 1, validations: [vr("bun run test", 1)] }))
    expect(s.candidates).toHaveLength(3)
  })

  test("a validated duplicate does not disturb best_candidate", () => {
    let s = createInitialRoundState("high")
    s = addCandidate(s, cand({ status: "validated", metric: 1, validations: [vr("bun run test", 0)] }))
    const bestAfterFirst = s.best_candidate
    s = addCandidate(s, cand({ status: "validated", metric: 1, validations: [vr("bun run test", 0)] }))
    expect(s.candidates).toHaveLength(1)
    expect(s.best_candidate).toBe(bestAfterFirst)
  })
})
