import { DocumentStore } from "./document-store"

// V3 run working memory (docs/28/29): materialize a run as a typed-document graph so the
// document store is the run's working-memory substrate (not just flat JSON artifacts).
// Nodes are linked (candidate derived_from design, decision refines candidate, decision
// triggered_by diagnosis), so the reviewer projection can answer "why accept/rollback"
// purely from the graph. This is the wiring point the runtime calls to back a run with the
// document graph; the gateway can invoke it best-effort alongside its artifact writing.

export type RunSummary = {
  readonly runId: string
  readonly taskId: string
  readonly agentMode: string
  readonly status: "in_progress" | "completed" | "runtime_failed" | "blocked" | "cancelled"
  readonly round: number
  readonly nextActionPolicy: string
  readonly runContextMarkdown: string
  readonly design?: { readonly summary: string }
  readonly candidate: { readonly summary: string; readonly status: string }
  readonly diagnosis?: { readonly summary: string; readonly rootCause: string | null; readonly nextAction: string }
  readonly decision: { readonly verdict: "accept" | "rollback"; readonly reason: string }
  readonly learningCandidates?: readonly {
    readonly candidate_id: string
    readonly type: "memory" | "strategy" | "methodology"
    readonly status: "staged" | "rejected"
    readonly source_run_id: string
    readonly source_round: number
    readonly summary: string
    readonly evidence_refs: readonly string[]
    readonly confidence: number
  }[]
}

export type RunGraphRefs = { readonly candidateId: string; readonly runContextId: string; readonly runStateId: string }

export const buildRunGraph = (store: DocumentStore, s: RunSummary): RunGraphRefs => {
  const scope = `run:${s.runId}`
  const prov = (source: "runner" | "model") => ({ source, run_ref: scope })

  const runState = store.upsert({
    type: "run_state", scope, description: `run state ${s.runId}`,
    body: JSON.stringify({ agent_mode: s.agentMode, status: s.status, round: s.round, next_action_policy: s.nextActionPolicy }, null, 2),
    provenance: prov("runner"), createdRound: s.round,
    extensions: { agent_mode: s.agentMode, status: s.status, next_action_policy: s.nextActionPolicy, round: s.round },
  })

  const runContext = store.upsert({
    type: "run_context", scope, description: `run context ${s.runId}`,
    body: s.runContextMarkdown, provenance: prov("runner"), createdRound: s.round,
  })

  let designId: string | null = null
  if (s.design) designId = store.upsert({
    type: "design", scope, description: `design ${s.runId}`, body: s.design.summary,
    provenance: prov("model"), createdRound: s.round,
  }).id

  const candidate = store.upsert({
    type: "candidate", scope, description: `candidate ${s.runId}`, body: s.candidate.summary,
    provenance: prov("model"), createdRound: s.round,
    links: designId ? [{ rel: "derived_from", to: designId }] : [],
    extensions: { candidate_status: s.candidate.status },
  })

  let diagnosisId: string | null = null
  if (s.diagnosis) diagnosisId = store.upsert({
    type: "diagnosis", scope, description: `diagnosis ${s.runId}: ${s.diagnosis.rootCause ?? "n/a"}`,
    body: s.diagnosis.summary, provenance: prov("runner"), createdRound: s.round,
    links: [{ rel: "produces_evidence", to: candidate.id }],
    extensions: { root_cause: s.diagnosis.rootCause, next_action: s.diagnosis.nextAction },
  }).id

  store.upsert({
    type: "decision", scope, description: `decision ${s.runId}`,
    body: `${s.decision.verdict}: ${s.decision.reason}`, provenance: prov("runner"), createdRound: s.round,
    links: [
      { rel: "refines", to: candidate.id },
      ...(diagnosisId ? [{ rel: "triggered_by" as const, to: diagnosisId }] : []),
    ],
  })

  for (const learning of s.learningCandidates ?? []) {
    const doc = store.upsert({
      type: learning.type,
      scope,
      description: learning.candidate_id,
      body: learning.summary,
      provenance: { source: "runner", run_ref: scope, evidence_refs: learning.evidence_refs },
      createdRound: learning.source_round,
      idSlug: learning.candidate_id,
      confidence: {
        evidence_strength: learning.confidence >= 0.8 ? "strong" : learning.confidence >= 0.5 ? "medium" : "weak",
        support_count: learning.evidence_refs.length,
        last_validated_round: learning.source_round,
      },
      extensions: {
        candidate_id: learning.candidate_id,
        source_run_id: learning.source_run_id,
        source_round: learning.source_round,
        confidence: learning.confidence,
        promotion_status: learning.status,
      },
      links: [{ rel: "derived_from", to: candidate.id }],
    })
    store.setStatus(doc.id, learning.status === "staged" ? "candidate" : "rejected")
  }

  return { candidateId: candidate.id, runContextId: runContext.id, runStateId: runState.id }
}
