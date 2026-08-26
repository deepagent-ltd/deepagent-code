import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { writeFileAtomic } from "./atomic-write"
import type { LearningCandidate } from "./learning"
import { DurableKnowledgeStore } from "./durable-knowledge-store"
import { documentRevision, type Doc, type GovernanceActor } from "./document-store"

// V3 learning promotion gate (docs/31 §1, decision 12). The ONLY path from a staged
// learning candidate to durable active knowledge. Enforces anti-pollution rules:
//  R1: hidden/evaluator (sealed) or external_trace candidates never auto-promote — sealed
//      is hard-blocked; external_trace requires the validation gate + human approval.
//  R2: promotion requires explicit human approval.
//  R3: rejected fingerprints are remembered so the same bad pattern is not relearned.
//  R4: approval preserves the candidate's canonical durable document identity.

export type CandidateOrigin = "run_local" | "external_trace" | "sealed"

export type GateVerdict = { readonly pass: boolean; readonly reason?: string; readonly evidence: readonly string[] }
export type ReplayRunner = (candidate: LearningCandidate) => {
  pass: boolean
  metricDelta: number
  evidenceRef?: string
}
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
  has(fp: string): boolean {
    return this.map.has(fp)
  }
  add(fp: string, reason: string): void {
    this.map.set(fp, reason)
    writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2))
  }
}

// Validation gate: dedupe vs RejectedBuffer, then replay/regression must pass without regressing.
export const validate = (candidate: LearningCandidate, rejected: RejectedBuffer, replay: ReplayRunner): GateVerdict => {
  const fp = fingerprint(candidate)
  if (rejected.has(fp)) return { pass: false, reason: "previously rejected (RejectedBuffer)", evidence: [] }
  const r = replay(candidate)
  if (!r.pass)
    return { pass: false, reason: "replay/regression failed", evidence: r.evidenceRef ? [r.evidenceRef] : [] }
  if (r.metricDelta < 0)
    return { pass: false, reason: "metric regressed", evidence: r.evidenceRef ? [r.evidenceRef] : [] }
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
  return {
    id: candidate.candidate_id,
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

export const approveCandidate = (
  record: PromotedRecord,
  stores: readonly DurableKnowledgeStore[],
  options: { readonly reviewRef?: string; readonly transitionedAt?: number } = {},
): PromotedRecord => {
  const matches = stores
    .map((store) => ({
      store,
      doc: store.findCandidate(
        record.source_candidate_id,
        record.type === "anti_pattern" ? "failure_dossier" : record.type,
        record.summary,
      ),
    }))
    .filter((match): match is { readonly store: DurableKnowledgeStore; readonly doc: Doc } => match.doc !== null)
  if (matches.length === 0)
    throw new Error(`approveCandidate: durable candidate ${record.source_candidate_id} was not found`)
  if (matches.length > 1)
    throw new Error(`approveCandidate: durable candidate ${record.source_candidate_id} has multiple authorities`)
  const match = matches[0]!
  const approved = match.store.approveCandidate(
    match.doc.id,
    documentRevision(match.doc),
    { type: "human", id: record.promoted_by },
    {
      ...(options.reviewRef ? { reviewRef: options.reviewRef } : {}),
      ...(options.transitionedAt !== undefined ? { transitionedAt: options.transitionedAt } : {}),
    },
  )
  return { ...record, id: approved.id }
}

export const rejectCandidate = (
  candidate: LearningCandidate,
  stores: readonly DurableKnowledgeStore[],
  reason: string,
  actor: GovernanceActor,
  options: { readonly reviewRef?: string; readonly transitionedAt?: number } = {},
): Doc => {
  const matches = stores
    .map((store) => ({
      store,
      doc: store.findCandidate(
        candidate.candidate_id,
        candidate.type === "anti_pattern" ? "failure_dossier" : candidate.type,
        candidate.summary,
      ),
    }))
    .filter((match): match is { readonly store: DurableKnowledgeStore; readonly doc: Doc } => match.doc !== null)
  if (matches.length === 0) throw new Error(`rejectCandidate: durable candidate ${candidate.candidate_id} was not found`)
  if (matches.length > 1) throw new Error(`rejectCandidate: durable candidate ${candidate.candidate_id} has multiple authorities`)
  const match = matches[0]!
  return match.store.rejectCandidate(match.doc.id, documentRevision(match.doc), actor, reason, {
    fingerprint: fingerprint(candidate),
    ...(options.reviewRef ? { reviewRef: options.reviewRef } : {}),
    ...(options.transitionedAt !== undefined ? { transitionedAt: options.transitionedAt } : {}),
  })
}

// Compatibility name retained for older callers. It no longer persists or copies a document; it
// resolves and approves the already-durable candidate in the supplied store.
export const persistPromoted = (record: PromotedRecord, store: DurableKnowledgeStore): string =>
  approveCandidate(record, [store]).id
