import type { DocumentStore, DocRef } from "./document-store"

// V3 reviewer projection (docs/27 P7 / A15 data layer): answer "why was candidate X
// accepted / rolled back" purely by walking the document graph. This is the data the
// reviewer UI consumes; the UI itself lands in the deepagent-code integration.

export type CandidateExplanation = {
  readonly candidate: DocRef
  readonly parents: readonly DocRef[]
  readonly decision: { readonly ref: string; readonly verdict: "accept" | "rollback" | "other"; readonly reason: string } | null
  readonly evals: readonly DocRef[]
  readonly diagnoses: readonly DocRef[]
}

export const explainCandidate = (store: DocumentStore, candidateId: string): CandidateExplanation => {
  const cand = store.get(candidateId)
  if (!cand) throw new Error(`unknown candidate ${candidateId}`)

  const refOf = (id: string): DocRef | null => {
    const d = store.get(id)
    return d ? { id: d.id, version: d.version, type: d.type, scope: d.scope, status: d.status, domain: d.domain, tags: d.tags, description: d.description } : null
  }

  const parents = cand.links
    .filter((l) => l.rel === "derived_from" || l.rel === "triggered_by")
    .map((l) => refOf(l.to))
    .filter((r): r is DocRef => r !== null)

  const incoming = store.getRefsIn(candidateId)
  const decisionRef = incoming.find((r) => r.from.type === "decision")?.from ?? null
  let decision: CandidateExplanation["decision"] = null
  const decisionDoc = decisionRef ? store.get(decisionRef.id) : null
  if (decisionDoc) {
    const text = `${decisionDoc.description}\n${decisionDoc.body}`
    const verdict = /rollback/i.test(text) ? "rollback" : /accept/i.test(text) ? "accept" : "other"
    // `split` always yields at least [""], so `?? description` is dead — use `||` so an empty
    // body falls back to the description.
    decision = { ref: decisionDoc.id, verdict, reason: decisionDoc.body.split("\n")[0] || decisionDoc.description }
  }

  const evals = incoming.filter((r) => r.from.type === "eval").map((r) => r.from)
  const diagnoses = decisionDoc
    ? decisionDoc.links
        .filter((l) => l.rel === "triggered_by" || l.rel === "produces_evidence")
        .map((l) => refOf(l.to))
        .filter((r): r is DocRef => r !== null && r.type === "diagnosis")
    : []

  const candidateRef = refOf(cand.id)
  if (!candidateRef) throw new Error(`candidate ${candidateId} could not be projected`)
  return { candidate: candidateRef, parents, decision, evals, diagnoses }
}
