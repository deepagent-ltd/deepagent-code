import { Schema } from "effect"

/**
 * Coordinator-facing contract for independent implementation reviews.
 *
 * These profiles are configuration, not native-agent registrations. A future
 * coordinator can map them to a registered agent and enforce the deny list.
 */

export const ReviewRole = Schema.Literals(["reviewer", "senior-reviewer"])
export type ReviewRole = Schema.Schema.Type<typeof ReviewRole>

export const ReviewVerdict = Schema.Literals(["approve", "request_changes", "reject"])
export type ReviewVerdict = Schema.Schema.Type<typeof ReviewVerdict>

export const ImplementationCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i)).annotate({
  identifier: "ImplementationCommitSha",
})
export type ImplementationCommitSha = Schema.Schema.Type<typeof ImplementationCommitSha>

export const ReviewFinding = Schema.Struct({
  severity: Schema.Literals(["critical", "high", "medium", "low"]),
  summary: Schema.String,
  rationale: Schema.String,
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Int),
  suggestion: Schema.optional(Schema.String),
}).annotate({ identifier: "ReviewContractFinding" })
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFinding>

export const ReviewVerdictContract = Schema.Struct({
  reviewer: Schema.Struct({
    id: Schema.String,
    role: ReviewRole,
  }),
  round: Schema.Int.check(Schema.isGreaterThan(0)),
  implementationCommitSha: ImplementationCommitSha,
  verdict: ReviewVerdict,
  rationale: Schema.String,
  findings: Schema.Array(ReviewFinding),
}).annotate({ identifier: "ReviewVerdictContract" })
export type ReviewVerdictContract = Schema.Schema.Type<typeof ReviewVerdictContract>

/** Tool and orchestration actions a review coordinator must deny to reviewers. */
export const ReviewCapability = Schema.Literals([
  "read",
  "search",
  "write",
  "commit",
  "merge",
  "task_spawn",
  "queue_mutation",
])
export type ReviewCapability = Schema.Schema.Type<typeof ReviewCapability>

export const ReviewPermissionPolicy = Schema.Struct({
  allow: Schema.Array(ReviewCapability),
  deny: Schema.Array(ReviewCapability),
}).annotate({ identifier: "ReviewPermissionPolicy" })
export type ReviewPermissionPolicy = Schema.Schema.Type<typeof ReviewPermissionPolicy>

export const ReviewRoleProfile = Schema.Struct({
  role: ReviewRole,
  permission: ReviewPermissionPolicy,
  output: Schema.Literal("ReviewVerdictContract"),
  requiresIndependentSeniorApproval: Schema.Boolean,
}).annotate({ identifier: "ReviewRoleProfile" })
export type ReviewRoleProfile = Schema.Schema.Type<typeof ReviewRoleProfile>

const reviewOnlyPermission = {
  allow: ["read", "search"],
  deny: ["write", "commit", "merge", "task_spawn", "queue_mutation"],
} as const satisfies ReviewPermissionPolicy

// Senior review can prepare a normal follow-up commit, but cannot integrate it,
// mutate queue state, or perform structural Git actions without parent approval.
const seniorReviewPermission = {
  allow: ["read", "search", "write", "commit"],
  deny: ["merge", "task_spawn", "queue_mutation"],
} as const satisfies ReviewPermissionPolicy

/**
 * Profiles are deliberately separate from Agent.Info registration. A coordinator
 * chooses the runtime agent and must apply this policy before executing it.
 */
export const ReviewRoleProfiles = {
  reviewer: {
    role: "reviewer",
    permission: reviewOnlyPermission,
    output: "ReviewVerdictContract",
    requiresIndependentSeniorApproval: true,
  },
  "senior-reviewer": {
    role: "senior-reviewer",
    permission: seniorReviewPermission,
    output: "ReviewVerdictContract",
    requiresIndependentSeniorApproval: false,
  },
} as const satisfies Record<ReviewRole, ReviewRoleProfile>

export function isBoundToImplementationCommit(
  review: ReviewVerdictContract,
  implementationCommitSha: ImplementationCommitSha,
): boolean {
  return review.implementationCommitSha === implementationCommitSha
}

/**
 * A senior approval is an explicit senior-reviewer verdict, never a panel vote.
 * The target SHA prevents approval of a stale or different implementation.
 */
export function isSeniorApprovalForCommit(
  review: ReviewVerdictContract,
  implementationCommitSha: ImplementationCommitSha,
): boolean {
  return (
    review.reviewer.role === "senior-reviewer" &&
    review.verdict === "approve" &&
    isBoundToImplementationCommit(review, implementationCommitSha)
  )
}

export * as ReviewContract from "./review-contract"
