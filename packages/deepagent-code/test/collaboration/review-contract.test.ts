import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  isBoundToImplementationCommit,
  isSeniorApprovalForCommit,
  ReviewRoleProfiles,
  ReviewVerdictContract,
} from "@/collaboration/review-contract"

const implementationCommitSha = "a".repeat(40)

const reviewerVerdict = {
  reviewer: { id: "reviewer-1", role: "reviewer" as const },
  round: 1,
  implementationCommitSha,
  verdict: "request_changes" as const,
  rationale: "The boundary check rejects valid zero-valued input.",
  findings: [
    {
      severity: "high" as const,
      summary: "Valid zero input is rejected",
      rationale: "The truthiness guard treats zero as absent.",
      file: "src/limit.ts",
      line: 18,
    },
  ],
}

describe("review verdict contract", () => {
  test("validates a reviewer verdict with identity, role, round, and commit binding", () => {
    const decoded = Schema.decodeUnknownSync(ReviewVerdictContract)(reviewerVerdict)
    expect(decoded.reviewer).toEqual({ id: "reviewer-1", role: "reviewer" })
    expect(decoded.round).toBe(1)
    expect(decoded.implementationCommitSha).toBe(implementationCommitSha)
    expect(decoded.verdict).toBe("request_changes")
  })

  test("rejects malformed implementation commit bindings, invalid rounds, and invalid verdicts", () => {
    expect(() =>
      Schema.decodeUnknownSync(ReviewVerdictContract)({
        ...reviewerVerdict,
        implementationCommitSha: "not-a-commit",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ReviewVerdictContract)({
        ...reviewerVerdict,
        round: 0,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ReviewVerdictContract)({
        ...reviewerVerdict,
        verdict: "block",
      }),
    ).toThrow()
  })

  test("checks a review against the exact implementation commit", () => {
    const decoded = Schema.decodeUnknownSync(ReviewVerdictContract)(reviewerVerdict)
    expect(isBoundToImplementationCommit(decoded, implementationCommitSha)).toBe(true)
    expect(isBoundToImplementationCommit(decoded, "b".repeat(40))).toBe(false)
  })
})

describe("reviewer role profiles", () => {
  test("are read-only and cannot mutate code, git state, tasks, or queues", () => {
    for (const profile of Object.values(ReviewRoleProfiles)) {
      expect(profile.permission.allow).toEqual(["read", "search"])
      expect(profile.permission.deny).toEqual(
        expect.arrayContaining(["write", "commit", "merge", "task_spawn", "queue_mutation"]),
      )
    }
  })

  test("represents senior approval separately from reviewer or panel approval", () => {
    const reviewerApproval = Schema.decodeUnknownSync(ReviewVerdictContract)({
      ...reviewerVerdict,
      verdict: "approve",
    })
    const seniorApproval = Schema.decodeUnknownSync(ReviewVerdictContract)({
      ...reviewerVerdict,
      reviewer: { id: "senior-1", role: "senior-reviewer" },
      verdict: "approve",
    })

    expect(ReviewRoleProfiles.reviewer.requiresIndependentSeniorApproval).toBe(true)
    expect(isSeniorApprovalForCommit(reviewerApproval, implementationCommitSha)).toBe(false)
    expect(isSeniorApprovalForCommit(seniorApproval, implementationCommitSha)).toBe(true)
    expect(isSeniorApprovalForCommit(seniorApproval, "b".repeat(40))).toBe(false)
  })
})
