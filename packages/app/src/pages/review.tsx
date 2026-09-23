type LearningCandidate = {
  candidateId: string
  type: "memory" | "strategy" | "methodology"
  status: string
  sourceRunId: string
  sourceRound: number
  summary: string
  evidenceRefs: string[]
  confidence: number
}
export type { LearningCandidate }
type PromotionPayload = {
  directory: string
  candidate: ReturnType<typeof promotionCandidate>
  origin: "run_local"
  verdict: { pass: true; reason: string; evidence: string[] }
  approval: { approver: string; approved: true; note?: string }
}
type RejectionPayload = {
  directory: string
  candidate: ReturnType<typeof promotionCandidate>
  reason: string
}

export const promotionCandidate = (candidate: LearningCandidate) => ({
  candidate_id: candidate.candidateId,
  type: candidate.type,
  status: "staged" as const,
  source_run_id: candidate.sourceRunId,
  source_round: candidate.sourceRound,
  summary: candidate.summary,
  evidence_refs: candidate.evidenceRefs,
  confidence: candidate.confidence,
})

export async function promoteLearningCandidate(input: {
  client: { deepagent: { knowledge: { promote: (payload: PromotionPayload) => unknown } } }
  directory: string
  candidate: LearningCandidate
  approver: string
  note: string
}) {
  const reviewer = input.approver.trim()
  if (!reviewer) throw new Error("请先填写审批人")
  const note = input.note.trim()
  return await input.client.deepagent.knowledge.promote({
    directory: input.directory,
    candidate: promotionCandidate(input.candidate),
    origin: "run_local",
    verdict: { pass: true, reason: note || "review approved", evidence: input.candidate.evidenceRefs },
    approval: { approver: reviewer, approved: true, note: note || undefined },
  })
}

export async function rejectLearningCandidate(input: {
  client: { deepagent: { knowledge: { reject: (payload: RejectionPayload) => unknown } } }
  directory: string
  candidate: LearningCandidate
  reason: string
}) {
  const reason = input.reason.trim()
  if (!reason) throw new Error("请先填写拒绝理由")
  return await input.client.deepagent.knowledge.reject({
    directory: input.directory,
    candidate: promotionCandidate(input.candidate),
    reason,
  })
}
