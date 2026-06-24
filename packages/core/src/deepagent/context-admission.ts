import type { DurableKnowledgeStore } from "./durable-knowledge-store"
import type { DomainPackIndexEntry } from "./domain-pack-registry"

// docs/34 §6/§9 S6 — On-demand skill/doc loading + ContextAdmissionGate.
//
// Progressive disclosure: at run start, only the INDEX (ref_id + summary + metadata) is exposed to
// the retrieval context. Full body is loaded ONLY on explicit demand (the model calls
// load_skill/load_pack_doc), and the load event is recorded in the run graph (DAP-6).
// The admission gate applies before any refs reach the prompt: it enforces ref count and
// estimated-token ceilings so durable knowledge stays bounded (docs/34 §4.2 step 5, DAP-4).

export type LoadEvent = {
  readonly ref_id: string
  readonly loaded_at: string
  readonly run_ref: string
  readonly body_length: number
}

export type AdmissionResult = {
  readonly admitted: readonly DomainPackIndexEntry[]
  readonly truncated: readonly DomainPackIndexEntry[]
  readonly admitted_ref_count: number
  readonly estimated_tokens: number
}

// Gate parameters. Conservative defaults so knowledge injection stays within model context budget.
export type GateParams = {
  readonly max_index_refs?: number       // hard limit on total refs admitted to context
  readonly max_estimated_tokens?: number  // rough token ceiling (1 token ≈ 4 chars of summary text)
  readonly allowed_strengths?: readonly ("high" | "xhigh" | "max" | "ultra")[]  // filter by agent strength
}

const DEFAULT_GATE: Required<GateParams> = {
  max_index_refs: 20,
  max_estimated_tokens: 4000,
  allowed_strengths: ["high", "xhigh", "max", "ultra"],
}

const estimateTokens = (entries: readonly DomainPackIndexEntry[]): number =>
  entries.reduce((acc, e) => acc + Math.ceil((e.title.length + e.summary.length + e.triggers.join(" ").length) / 4), 0)

// Filter pack index entries through the ContextAdmissionGate before they reach the prompt.
// Only entries with evidence_strength >= medium and risk <= the agent strength are admitted.
// Truncation is recorded so the prompt-builder can surface "more knowledge available" to the model.
export const admitIndexRefs = (
  entries: readonly DomainPackIndexEntry[],
  agentStrength: "general" | "high" | "xhigh" | "max" | "ultra",
  params: GateParams = {},
): AdmissionResult => {
  const p = { ...DEFAULT_GATE, ...params }
  if (agentStrength === "general") {
    // general never admits durable knowledge (DAP-3)
    return { admitted: [], truncated: [...entries], admitted_ref_count: 0, estimated_tokens: 0 }
  }
  // agentStrength is narrowed past "general" by the early return above.
  const s: "high" | "xhigh" | "max" | "ultra" = agentStrength

  const strengthOk = (e: DomainPackIndexEntry): boolean =>
    p.allowed_strengths.includes(s) && e.allowed_strengths.includes(s)

  const evidenceOk = (e: DomainPackIndexEntry): boolean =>
    e.evidence_strength === "strong" || e.evidence_strength === "medium"

  // docs/39 §3.1: skills at high+; domain knowledge at xhigh+; strategy/methodology at max/ultra only.
  const typeOk = (e: DomainPackIndexEntry): boolean => {
    if (e.type === "skill") return true // already gated by strengthOk
    if (e.type === "knowledge") return s === "xhigh" || s === "max" || s === "ultra"
    return s === "max" || s === "ultra"
  }

  const candidates = entries.filter((e) => strengthOk(e) && evidenceOk(e) && typeOk(e))
  const admitted: DomainPackIndexEntry[] = []
  let tokens = 0
  for (const e of candidates) {
    if (admitted.length >= p.max_index_refs) break
    const eTokens = Math.ceil((e.title.length + e.summary.length) / 4)
    if (tokens + eTokens > p.max_estimated_tokens) break
    admitted.push(e)
    tokens += eTokens
  }
  const admittedIds = new Set(admitted.map((e) => e.ref_id))
  const truncated = entries.filter((e) => !admittedIds.has(e.ref_id))

  return { admitted, truncated, admitted_ref_count: admitted.length, estimated_tokens: tokens }
}

// Load a skill or knowledge doc body on demand. Records a LoadEvent for the run graph (DAP-6).
// Returns null if the doc is unknown; the caller should handle absence gracefully.
export const loadOnDemand = (
  refId: string,
  runRef: string,
  store: DurableKnowledgeStore,
): { body: string; event: LoadEvent } | null => {
  const body = store.loadBody(refId)
  if (body === null) return null
  return {
    body,
    event: {
      ref_id: refId,
      loaded_at: new Date().toISOString(),
      run_ref: runRef,
      body_length: body.length,
    },
  }
}

// Format the admitted pack index as a compact prompt section. Emitted only for max/ultra modes.
// The model can call load_skill(<ref_id>) to get the full body of any admitted skill ref.
export const formatPackIndexSection = (
  result: AdmissionResult,
  activeDomains: readonly string[],
): string => {
  if (result.admitted.length === 0) return ""
  const lines: string[] = [
    `Active domain packs: ${activeDomains.join(", ")}`,
    `Available refs (${result.admitted.length}${result.truncated.length > 0 ? `, +${result.truncated.length} truncated` : ""}):`,
  ]
  for (const e of result.admitted) {
    const tag = e.type === "skill" ? "skill" : e.type.slice(0, 3)
    lines.push(`  [${e.ref_id} · ${e.evidence_strength} · ${tag}] ${e.summary}`)
  }
  if (result.truncated.length > 0) {
    lines.push(`  (${result.truncated.length} additional refs available via load_pack_doc)`)
  }
  return lines.join("\n")
}
