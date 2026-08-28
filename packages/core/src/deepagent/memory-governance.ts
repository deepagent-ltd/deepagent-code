// U6 memory governance pipeline (S1 §P1). The principle: default to FULLY AUTOMATIC; route to a
// human only for the few cases a machine cannot safely decide. This module is the explicit decision
// layer that classifies each learning candidate into one of: auto-admit, drop, or human-review (with
// a specific reason). The DurableKnowledgeStore already implements the mechanical gates — exact
// dedup + near-duplicate merge (gate 3/4, findSimilarKnowledge + reinforceConfidence) and the
// approval flip (gate 8). This module adds the routing gates (1/2/5/6/7) on top.
//
// Human-review triggers (the ONLY four; everything else is automatic):
//   1. sensitive content (gate 1)            — confirmed: sensitive enters review, not auto-reject
//   2. contradiction with high-trust knowledge (gate 5)
//   3. promotion INTO a domain pack (gate 6)
//   4. promotion to GLOBAL scope (gate 7)
import type { LearningCandidate } from "./learning"
import type { Doc, EvidenceStrength } from "./document-store"

export type ReviewReason = "sensitive" | "contradiction" | "pack_promotion" | "global_promotion"

// The routing decision for a single candidate.
export type GovernanceRoute =
  | { readonly kind: "auto_admit" } // gates passed — stage + approve automatically
  | { readonly kind: "drop"; readonly reason: "rejected_buffer" | "duplicate" } // gate 3 — never relearn
  | { readonly kind: "review"; readonly reason: ReviewReason } // gates 1/5/6/7 — human decides

export type KnowledgeType = "memory" | "strategy" | "methodology" | "anti_pattern"
export type KnowledgeScope = "session" | "project" | "global"

export type Classification = {
  readonly type: KnowledgeType
  readonly scope: KnowledgeScope
  readonly sensitive: boolean
  // blast radius: project-internal memory is low; strategies/methodologies and global/pack are higher
  readonly blastRadius: "low" | "medium" | "high"
}

// --- Gate 1: sensitivity ----------------------------------------------------------------------
// Same detector as the prior secret gate (keyword + literal credential VALUE patterns), but the
// ACTION changed (S1 D7 final): a sensitive candidate is ROUTED TO REVIEW, not auto-rejected and not
// auto-admitted. It stays pending (unretrievable) until a human approves.
const SENSITIVE_KEYWORD = /secret|token|password|passwd|api[_ -]?key|private[_ -]?key|credential|bearer|authorization/i
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style key
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, // PEM private key
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i, // scheme://user:pass@host
]
export const looksSensitive = (value: string): boolean =>
  SENSITIVE_KEYWORD.test(value) || SENSITIVE_VALUE_PATTERNS.some((re) => re.test(value))

// --- Gate 2: classification + blast radius ----------------------------------------------------
// Learned knowledge is project-scoped by default. memory is low blast radius; strategy/methodology
// reach further (they steer future solution direction) so they are medium. anti_pattern is negative
// knowledge (failure dossier) — also low (never positively injected). Global/pack promotion is a
// separate gate (7/6), not something a learning candidate claims on its own.
export const classify = (candidate: LearningCandidate): Classification => {
  const sensitive = looksSensitive(candidate.summary)
  // memory is low blast radius (a project fact). strategy/methodology steer future solution
  // direction; anti_pattern is solution-steering negative knowledge (a failure dossier the retriever
  // surfaces as do_not_use). All three reach further than a plain memory, so they share the higher
  // medium-blast-radius auto-admit bar (docs/30 anti-misleading).
  const blastRadius: Classification["blastRadius"] = candidate.type === "memory" ? "low" : "medium"
  return { type: candidate.type, scope: "project", sensitive, blastRadius }
}

// --- Gate 5: contradiction detection ----------------------------------------------------------
// A candidate contradicts existing knowledge when an active doc of the same type/domain expresses an
// opposing point. We can't do semantics here cheaply, so the runtime supplies the set of active docs
// the candidate is "near" (the store's similarity search) and whether any is HIGH-TRUST (curated /
// pack / global / strong-evidence). High-trust contradiction -> review; low-trust -> auto-supersede
// is handled by the store (new + strong evidence wins). This function only decides the ROUTING.
export const isHighTrust = (doc: Doc): boolean => {
  const strength: EvidenceStrength | undefined = doc.confidence?.evidence_strength
  const curated = doc.provenance.source === "human" || doc.scope === "durable"
  const packed = typeof doc.extensions?.["pack_id"] === "string" && doc.extensions["pack_id"] !== null
  return curated || packed || strength === "strong"
}

// --- The pipeline routing decision ------------------------------------------------------------
// Pure: the worker supplies the facts (rejected-buffer hit, contradicting high-trust docs, whether a
// pack/global promotion was requested) and this returns the route. Order matters and mirrors S1's
// gate sequence.
export type GovernanceFacts = {
  readonly classification: Classification
  readonly inRejectedBuffer: boolean // gate 3 (fingerprint already rejected)
  readonly contradictsHighTrust: boolean // gate 5
  readonly promotesIntoPack: boolean // gate 6
  readonly promotesToGlobal: boolean // gate 7
}

export const route = (facts: GovernanceFacts): GovernanceRoute => {
  // gate 3: never relearn a rejected fingerprint.
  if (facts.inRejectedBuffer) return { kind: "drop", reason: "rejected_buffer" }
  // gate 1: sensitive -> human review (pending, unretrievable).
  if (facts.classification.sensitive) return { kind: "review", reason: "sensitive" }
  // gate 5: contradicting high-trust knowledge -> human review (show both sides).
  if (facts.contradictsHighTrust) return { kind: "review", reason: "contradiction" }
  // gate 6: promoting INTO a domain pack -> human review (curated, ships with the product).
  if (facts.promotesIntoPack) return { kind: "review", reason: "pack_promotion" }
  // gate 7: promoting to GLOBAL scope -> human review (raises blast radius).
  if (facts.promotesToGlobal) return { kind: "review", reason: "global_promotion" }
  // gate 8: everything else admits automatically.
  return { kind: "auto_admit" }
}

// Confidence floor for auto-admit, scaled by blast radius (S1 §U6 gate 2 + D7 decision). A
// low-blast-radius project memory auto-admits at 0.6; strategy/methodology steer future solution
// direction (medium blast radius) and can mislead the model on wrong contexts (docs/30), so they
// need a higher bar (0.8) before auto-admitting — below that they route to review. The contradiction
// gate (5) is an additional always-on safety net regardless of confidence.
export const AUTO_ADMIT_MIN_CONFIDENCE = 0.6
export const AUTO_ADMIT_MIN_CONFIDENCE_MEDIUM = 0.8
export const confidenceFloorFor = (blastRadius: Classification["blastRadius"]): number =>
  blastRadius === "low" ? AUTO_ADMIT_MIN_CONFIDENCE : AUTO_ADMIT_MIN_CONFIDENCE_MEDIUM

export const meetsConfidenceFloor = (candidate: LearningCandidate, classification: Classification): boolean =>
  candidate.confidence >= confidenceFloorFor(classification.blastRadius)
