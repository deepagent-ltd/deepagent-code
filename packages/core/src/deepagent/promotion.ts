import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { writeFileAtomic } from "./atomic-write"
import type { LearningCandidate } from "./learning"
import { DurableKnowledgeStore } from "./durable-knowledge-store"

// V3 learning promotion gate (docs/31 §1, decision 12). The ONLY path from a staged
// learning candidate to durable active knowledge. Enforces anti-pollution rules:
//  R1: hidden/evaluator (sealed) or external_trace candidates never auto-promote — sealed
//      is hard-blocked; external_trace requires the validation gate + human approval.
//  R2: promotion requires explicit human approval.
//  R3: rejected fingerprints are remembered so the same bad pattern is not relearned.
//  R4: promotion produces a NEW durable record (new id); the run candidate keeps identity.

export type CandidateOrigin = "run_local" | "external_trace" | "sealed"

export type GateVerdict = { readonly pass: boolean; readonly reason?: string; readonly evidence: readonly string[] }
export type ReplayRunner = (candidate: LearningCandidate) => { pass: boolean; metricDelta: number; evidenceRef?: string }
export type HumanApproval = { readonly approver: string; readonly approved: boolean; readonly note?: string }

export type PromotedRecord = {
  readonly id: string
  readonly source_candidate_id: string
  readonly type: LearningCandidate["type"]
  readonly summary: string
  readonly evidence_refs: readonly string[]
  readonly evidence_strength: "strong" | "medium" | "weak"
  readonly promoted_by: string
  readonly promoted_at: string
}

export const fingerprint = (c: LearningCandidate): string =>
  "fp:" + createHash("sha256").update(`${c.type}:${c.summary}`).digest("hex").slice(0, 24)

export class RejectedBuffer {
  private file: string
  private map: Map<string, string>
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, "rejected_buffer.json")
    this.map = existsSync(this.file) ? new Map(Object.entries(JSON.parse(readFileSync(this.file, "utf8")))) : new Map()
  }
  has(fp: string): boolean { return this.map.has(fp) }
  add(fp: string, reason: string): void { this.map.set(fp, reason); writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2)) }
}

// Validation gate: dedupe vs RejectedBuffer, then replay/regression must pass without regressing.
export const validate = (candidate: LearningCandidate, rejected: RejectedBuffer, replay: ReplayRunner): GateVerdict => {
  const fp = fingerprint(candidate)
  if (rejected.has(fp)) return { pass: false, reason: "previously rejected (RejectedBuffer)", evidence: [] }
  const r = replay(candidate)
  if (!r.pass) return { pass: false, reason: "replay/regression failed", evidence: r.evidenceRef ? [r.evidenceRef] : [] }
  if (r.metricDelta < 0) return { pass: false, reason: "metric regressed", evidence: r.evidenceRef ? [r.evidenceRef] : [] }
  return { pass: true, evidence: r.evidenceRef ? [r.evidenceRef] : [] }
}

export const promote = (
  candidate: LearningCandidate,
  origin: CandidateOrigin,
  verdict: GateVerdict,
  approval: HumanApproval,
  now: string,
): PromotedRecord => {
  if (origin === "sealed") throw new Error("R1: sealed/hidden candidates can never be promoted")
  if (!verdict.pass) throw new Error("cannot promote a candidate that failed the validation gate")
  if (!approval.approved) throw new Error("R2: promotion requires human approval")
  const evidence_strength = verdict.evidence.length >= 1 ? "medium" : "weak"
  const newId = `durable:${candidate.type}:` + createHash("sha256").update(candidate.candidate_id).digest("hex").slice(0, 12)
  return {
    id: newId, // R4: new durable identity
    source_candidate_id: candidate.candidate_id,
    type: candidate.type,
    summary: candidate.summary,
    evidence_refs: verdict.evidence,
    evidence_strength,
    promoted_by: approval.approver,
    promoted_at: now,
  }
}

export const reject = (candidate: LearningCandidate, rejected: RejectedBuffer, reason: string): void =>
  rejected.add(fingerprint(candidate), reason)

// Persist a human-approved promoted record into the durable DocumentStore so the retriever finds it
// on subsequent runs (closes the self-learning loop: run candidate -> gate -> human -> durable ->
// retrievable). The promoted doc is staged then immediately approved (active). It is written as
// user-global (no project tag) intentionally: the explicit human-approval path promotes knowledge
// meant to apply broadly, unlike the automatic LearningWorker path which stays project-shared.
export const persistPromoted = (record: PromotedRecord, store: DurableKnowledgeStore): string => {
  const doc = store.stageCandidate({
    type: record.type === "anti_pattern" ? "failure_dossier" : record.type,
    description: record.summary,
    body: record.summary,
    domain: null,
    tags: ["promoted", "learned"],
    scope: "user-global",
    sensitivity: "source_code",
    risk: "low",
    confidence: {
      evidence_strength: record.evidence_strength,
      support_count: record.evidence_refs.length || 1,
    },
    provenance: { source: "human", run_ref: record.source_candidate_id, evidence_refs: record.evidence_refs },
    idSlug: record.id,
  })
  store.approve(doc.id) // human-approved -> active -> retrievable
  return doc.id // the durable doc id (distinct from the promotion record id)
}
