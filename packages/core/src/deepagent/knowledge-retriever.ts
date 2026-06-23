import type { AgentMode } from "./mode"
import { knowledgeEnabled } from "./mode"
import type { KnowledgeRefProjection, KnowledgeSynthesis, TaskContext, ToolContext } from "./prompt-policy"
import * as knowledgeSource from "./knowledge-source"
import { type ProblemProfile, type ActivateOptions } from "./domain-pack"
import * as Registry from "./domain-pack-registry"
import type { ExtendedProblemProfile } from "./domain-pack-registry"

// V3 anti-misleading retrieval (docs/30). Knowledge is advisory and gated so the agent
// system never drags down the model: mandatory per-type top-k, an evidence-strength gate
// (weak/none are never injected as guidance), a relevance threshold, and explicit
// gap_analysis / do_not_use surfacing. Skills are NOT here — skills are capability
// (docs/30 §2.2) and handled outside this knowledge path.

export type EvidenceStrength = "strong" | "medium" | "weak" | "none"

const EVIDENCE_SCORE: Record<EvidenceStrength, number> = { strong: 1, medium: 0.6, weak: 0.25, none: 0 }

// Mandatory per-type top-k (V3 defaults) and the hard caps top-k can never exceed.
// top-k cannot be disabled: a missing/zero value falls back to the default.
// review_4 M1: add knowledge (max/ultra) and skill (high+) to the per-type gate.
// review_4 M2: raise methodology default 1→2, hard cap 2→3 (416 docs across 100 packs).
export const TOPK_DEFAULT = { strategy: 3, methodology: 2, memory: 3, knowledge: 2, skill: 2 } as const
export const TOPK_HARD_CAP = { strategy: 5, methodology: 3, memory: 5, knowledge: 4, skill: 4 } as const

// An item below this evidence score is never injected as guidance (only reported as a gap).
export const EVIDENCE_THRESHOLD = EVIDENCE_SCORE.medium // 0.6 -> excludes weak/none
export const EVIDENCE_GATED_KINDS = ["strategy", "methodology", "memory"] as const

export type RetrievalInput = {
  readonly mode: AgentMode
  readonly task: TaskContext
  readonly tools: ToolContext
  readonly round: number
  readonly previousFailures: number
  readonly blockedRefs?: readonly string[] // diagnosis-blocked refs -> do_not_use
  readonly profile?: ProblemProfile // V3: activates domain packs (docs/31 §2)
  readonly domainOptions?: ActivateOptions // override / threshold for domain activation
  // V3.2.1 decision B (docs/34 §8): workspace isolation by path. When set, durable retrieval unions
  // user-global knowledge with project-shared knowledge for THIS workspace; project-shared knowledge
  // from OTHER workspaces is never read (different on-disk store). Absent => user-global only. The
  // path (not a pre-hashed id) is required because the durable store roots at project/<hash(path)>.
  readonly workspacePath?: string
}

export type StrategyRef = {
  readonly ref_id: string
  readonly pack_id: string | null
  readonly provenance: string
  readonly scope: string
  readonly relevance: number
  readonly summary: string
  readonly evidence_strength: EvidenceStrength
}

export type MethodologyRef = {
  readonly ref_id: string
  readonly pack_id: string | null
  readonly scope: string
  readonly relevance: number
  readonly summary: string
  readonly evidence_strength: EvidenceStrength
}

export type MemoryRef = {
  readonly ref_id: string
  readonly provenance: string
  readonly summary: string
  readonly relevance: number
  readonly evidence_strength: EvidenceStrength
}

// review_4 M1/M4: knowledge and skill are first-class retrieved types. They carry pack_id so the
// primary-pack quota and rankDoc activePackIds scope apply identically to strategy/methodology.
export type KnowledgeRef = {
  readonly ref_id: string
  readonly pack_id: string | null
  readonly scope: string
  readonly relevance: number
  readonly summary: string
  readonly evidence_strength: EvidenceStrength
}
export type SkillRef = {
  readonly ref_id: string
  readonly pack_id: string | null
  readonly scope: string
  readonly relevance: number
  readonly summary: string
  readonly evidence_strength: EvidenceStrength
}

// Strategies and methodologies are seeded from pack documents/ into DocumentStore at
// configure() (docs/35 S1). The in-code constants were deleted; data lives in
// packages/domain-packs/code/core/documents/ and code/gpu-kernel/documents/.

// Map a learned-candidate confidence (0..1) onto a discrete evidence strength.
export const evidenceFromConfidence = (confidence: number): EvidenceStrength => {
  if (confidence >= 0.8) return "strong"
  if (confidence >= 0.5) return "medium"
  if (confidence > 0) return "weak"
  return "none"
}

export const clampTopK = (type: keyof typeof TOPK_DEFAULT, requested?: number): number => {
  const def = TOPK_DEFAULT[type]
  const cap = TOPK_HARD_CAP[type]
  const k = !requested || requested < 1 ? def : requested
  return Math.min(k, cap)
}

// Re-exported so callers (gateway/handlers) can clear the durable read cache after approve/reject/
// seed. Delegates to the knowledge-source adapter (the single durable read path, docs/34 §8).
export const invalidateCache = (): void => {
  knowledgeSource.invalidateCache()
}

// Durable strategies from the DocumentStore (scope=user-global ∪ this workspace's project-shared,
// status=active only). DAP-11: the formerly in-code CORE_STRATEGIES + gpu pack are now SEEDED into
// the DocumentStore at gateway configure(), so they flow through this single path — no in-code
// double-injection. The seed/pack docs are NOT excluded anymore (they ARE the curated knowledge).
const loadDiskStrategies = (workspacePath: string | undefined, activation: KnowledgeActivation): StrategyRef[] => {
  let scored
  try {
    scored = knowledgeSource.queryKnowledge({
      types: ["strategy"],
      activePackIds: activation.activePackIds,
      keywords: activation.keywords,
      ...(workspacePath ? { workspacePath } : {}),
      limit: 50,
    })
  } catch {
    return []
  }
  return scored.map(({ doc, score }) => ({
    ref_id: doc.id,
    pack_id: packIdOf(doc),
    provenance: doc.provenance.run_ref ? `learned:${doc.provenance.run_ref}` : "durable",
    scope: "durable",
    relevance: rankDoc(score, packIdOf(doc), activation),
    summary: doc.description,
    evidence_strength: doc.confidence?.evidence_strength ?? "none",
  }))
}

// DAP-11: the in-code constants are no longer the retrieval source — they are SEEDED into
// DocumentStore at gateway configure() and read back via loadDiskStrategies.
const getAllStrategies = (workspacePath: string | undefined, activation: KnowledgeActivation): readonly StrategyRef[] =>
  loadDiskStrategies(workspacePath, activation)

// review_4 M1: knowledge docs — durable, seeded from domain-packs documents/knowledge/, max/ultra only.
const loadDiskKnowledge = (workspacePath: string | undefined, activation: KnowledgeActivation): KnowledgeRef[] => {
  try {
    const scored = knowledgeSource.queryKnowledge({
      types: ["knowledge"],
      activePackIds: activation.activePackIds,
      keywords: activation.keywords,
      ...(workspacePath ? { workspacePath } : {}),
      limit: 40,
    })
    return scored.map(({ doc, score }) => ({
      ref_id: doc.id,
      pack_id: packIdOf(doc),
      scope: doc.domain ?? "general",
      relevance: rankDoc(score, packIdOf(doc), activation),
      summary: doc.description,
      evidence_strength: doc.confidence?.evidence_strength ?? "none",
    }))
  } catch { return [] }
}

// review_4 M4: skill docs — durable, seeded from domain-packs documents/skills/, high+ (by design).
const loadDiskSkills = (workspacePath: string | undefined, activation: KnowledgeActivation): SkillRef[] => {
  try {
    const scored = knowledgeSource.queryKnowledge({
      types: ["skill"],
      activePackIds: activation.activePackIds,
      keywords: activation.keywords,
      ...(workspacePath ? { workspacePath } : {}),
      limit: 30,
    })
    return scored.map(({ doc, score }) => ({
      ref_id: doc.id,
      pack_id: packIdOf(doc),
      scope: doc.domain ?? "general",
      relevance: rankDoc(score, packIdOf(doc), activation),
      summary: doc.description,
      evidence_strength: doc.confidence?.evidence_strength ?? "none",
    }))
  } catch { return [] }
}

export type GapEntry = { readonly ref_id: string; readonly excluded_by: "relevance" | "evidence" | "topk" | "global_cap" }
export type DoNotUseEntry = { readonly ref_id: string; readonly reason: string }

type Gated<T> = {
  readonly selected: readonly T[]
  readonly gaps: readonly GapEntry[]
  readonly doNotUse: readonly DoNotUseEntry[]
}

const strategyProjection = (s: StrategyRef): KnowledgeRefProjection => ({
  ref_id: s.ref_id,
  kind: "strategy",
  provenance: s.provenance,
  scope: s.scope,
  summary: s.summary,
  relevance: s.relevance,
  evidence_strength: s.evidence_strength,
  body_policy: "summary_only",
})

const methodologyProjection = (m: MethodologyRef): KnowledgeRefProjection => ({
  ref_id: m.ref_id,
  kind: "methodology",
  provenance: "deepagent_methodology_registry",
  scope: m.scope,
  summary: m.summary,
  relevance: m.relevance,
  evidence_strength: m.evidence_strength,
  body_policy: "summary_only",
})

const memoryProjection = (m: MemoryRef): KnowledgeRefProjection => ({
  ref_id: m.ref_id,
  kind: "memory",
  provenance: m.provenance,
  scope: "learned",
  summary: m.summary,
  relevance: m.relevance,
  evidence_strength: m.evidence_strength,
  body_policy: "summary_only",
})

const knowledgeProjection = (k: KnowledgeRef): KnowledgeRefProjection => ({
  ref_id: k.ref_id,
  kind: "knowledge",
  provenance: "durable",
  scope: k.scope,
  summary: k.summary,
  relevance: k.relevance,
  evidence_strength: k.evidence_strength,
  body_policy: "summary_only",
})

const skillProjection = (s: SkillRef): KnowledgeRefProjection => ({
  ref_id: s.ref_id,
  kind: "skill",
  provenance: "durable",
  scope: s.scope,
  summary: s.summary,
  relevance: s.relevance,
  evidence_strength: s.evidence_strength,
  body_policy: "summary_only",
})

// Pure gate: relevance threshold -> evidence threshold -> mandatory top-k. Diagnosis-blocked
// refs are surfaced as do_not_use and never selected. Exported for unit testing.
// priorityPackOf (optional): maps a ref to its pack id; when the top-k slice would drop every ref
// of a priority (primary) pack, the highest-relevance ref of that pack is force-kept so a correctly
// matched narrow pack is never fully starved by equal-relevance fallback refs at the k boundary
// (docs/review_38 §二 B4: the gpu-kernel preemption case once many packs co-activate).
export const gateRefs = <T extends { ref_id: string; relevance: number; evidence_strength: EvidenceStrength }>(
  items: readonly T[],
  type: keyof typeof TOPK_DEFAULT,
  relevanceThreshold: number,
  blocked: ReadonlySet<string>,
  topkOverride?: number,
  priorityPackOf?: (item: T) => string | null,
  priorityPackIds?: ReadonlySet<string>,
): Gated<T> => {
  const gaps: GapEntry[] = []
  const doNotUse: DoNotUseEntry[] = []

  const pool = items.filter((i) => {
    if (blocked.has(i.ref_id)) {
      doNotUse.push({ ref_id: i.ref_id, reason: "blocked by diagnosis" })
      return false
    }
    return true
  })

  const passRelevance = pool.filter((i) => {
    if (i.relevance >= relevanceThreshold) return true
    gaps.push({ ref_id: i.ref_id, excluded_by: "relevance" })
    return false
  })

  const passEvidence = passRelevance.filter((i) => {
    if (EVIDENCE_SCORE[i.evidence_strength] >= EVIDENCE_THRESHOLD) return true
    gaps.push({ ref_id: i.ref_id, excluded_by: "evidence" })
    return false
  })

  const k = clampTopK(type, topkOverride)
  // Stable total order: ref_id tiebreaker so the selected top-k set is deterministic across runs
  // (equal-relevance items at the k boundary must not flip with input/file-read order).
  const sorted = [...passEvidence].sort((a, b) => b.relevance - a.relevance || a.ref_id.localeCompare(b.ref_id))
  const selected = [...sorted.slice(0, k)]
  // Primary-pack guarantee: if the top-k slice contains no ref from a priority pack that DOES have
  // an eligible ref below the cut, promote that pack's highest-relevance ref (swapping out the
  // lowest-relevance non-priority ref already selected). Keeps narrow packs represented.
  if (priorityPackOf && priorityPackIds && priorityPackIds.size > 0) {
    const selectedIds = new Set(selected.map((i) => i.ref_id))
    const packsInSelection = new Set(selected.map((i) => priorityPackOf(i)).filter(Boolean) as string[])
    for (const pid of priorityPackIds) {
      if (packsInSelection.has(pid)) continue
      const candidate = sorted.find((i) => priorityPackOf(i) === pid && !selectedIds.has(i.ref_id))
      if (!candidate) continue
      // Pick a victim from an OVER-REPRESENTED pack first (a pack holding >1 selected ref), so every
      // primary pack keeps at least one slot; fall back to the lowest-relevance non-priority ref.
      const packCount = new Map<string, number>()
      for (const i of selected) { const p = priorityPackOf(i); if (p) packCount.set(p, (packCount.get(p) ?? 0) + 1) }
      let victimIdx = -1
      for (let j = selected.length - 1; j >= 0; j--) {
        const vp = priorityPackOf(selected[j])
        if (vp && (packCount.get(vp) ?? 0) > 1) { victimIdx = j; break }
      }
      if (victimIdx < 0) {
        for (let j = selected.length - 1; j >= 0; j--) {
          const vp = priorityPackOf(selected[j])
          if (!vp || !priorityPackIds.has(vp)) { victimIdx = j; break }
        }
      }
      if (victimIdx >= 0) {
        selectedIds.delete(selected[victimIdx].ref_id)
        selected[victimIdx] = candidate
        selectedIds.add(candidate.ref_id)
        packsInSelection.add(pid)
      }
    }
  }
  const selectedSet = new Set(selected.map((i) => i.ref_id))
  for (const i of sorted) if (!selectedSet.has(i.ref_id)) gaps.push({ ref_id: i.ref_id, excluded_by: "topk" })

  return { selected, gaps, doNotUse }
}

// B4 (docs/review_38 §八): the global selected-ref ceiling is no longer a fixed 5. It scales with
// task complexity so multi-domain and high-risk tasks can carry the refs they need, while simple
// single-domain tasks stay lean (token budget). Hard ceiling is 12 — never unbounded.
export const SELECTED_REF_CAP = { simple: 5, multiDomain: 8, highRiskOrUltra: 12 } as const
// candidateRefs is the transparency/rerank pool (not all injected); capped so it can't grow without
// bound as more packs activate.
export const CANDIDATE_REF_CAP = 30

const isRiskPack = (packId: string): boolean => packId.startsWith("risk.") || packId.startsWith("business.")

const selectedRefCap = (input: RetrievalInput, activation: KnowledgeActivation): number => {
  const multiDomain = activation.primaryPackIds.length >= 2
  const highRisk = activation.activePackIds.some(isRiskPack)
  if (input.mode === "ultra" || (highRisk && multiDomain)) return SELECTED_REF_CAP.highRiskOrUltra
  if (multiDomain) return SELECTED_REF_CAP.multiDomain
  return SELECTED_REF_CAP.simple
}

// Quota-aware selection: instead of a naive top-N-by-relevance slice (which lets an over-activated
// or high-scoring fallback pack starve a correctly-matched primary pack), reserve a slot for each
// primary pack and each active risk pack first, then fill the rest by relevance with the core/testing
// fallback contribution capped. Returns the chosen ref_id set. Deterministic (ref_id tiebreaker).
type ScoredId = { readonly ref_id: string; readonly relevance: number; readonly packId: string | null }
const FALLBACK_QUOTA = 2

const selectWithQuota = (refs: readonly ScoredId[], cap: number, activation: KnowledgeActivation, rescuePool: readonly ScoredId[] = refs): ReadonlySet<string> => {
  const fallbackSet = new Set<string>(CORE_FALLBACK_PACKS)
  const sorted = [...refs].sort((a, b) => b.relevance - a.relevance || a.ref_id.localeCompare(b.ref_id))
  const rescueSorted = [...rescuePool].sort((a, b) => b.relevance - a.relevance || a.ref_id.localeCompare(b.ref_id))
  const chosen = new Set<string>()
  // 1. Reserve the highest-relevance ref for each primary pack (anti-preemption). review_4: if a
  //    primary was fully starved at the per-type top-k stage (e.g. 5 primaries competing for 3 strategy
  //    slots, so a narrow pack like code.vector-search lost every slot), rescue its best ref from the
  //    full passing pool so every primary keeps >=1 representative regardless of per-type contention.
  for (const pid of activation.primaryPackIds) {
    if (chosen.size >= cap) break
    const best = sorted.find((r) => r.packId === pid && !chosen.has(r.ref_id))
      ?? rescueSorted.find((r) => r.packId === pid && !chosen.has(r.ref_id))
    if (best) chosen.add(best.ref_id)
  }
  // 2. Reserve one for each active risk/business pack (policy refs must survive).
  for (const pid of activation.activePackIds) {
    if (chosen.size >= cap) break
    if (!isRiskPack(pid)) continue
    const best = sorted.find((r) => r.packId === pid && !chosen.has(r.ref_id))
    if (best) chosen.add(best.ref_id)
  }
  // 3. Fill remaining slots by relevance, capping core/testing fallback contribution.
  let fallbackCount = 0
  for (const r of sorted) {
    if (chosen.size >= cap) break
    if (chosen.has(r.ref_id)) continue
    if (r.packId && fallbackSet.has(r.packId)) {
      if (fallbackCount >= FALLBACK_QUOTA) continue
      fallbackCount++
    }
    chosen.add(r.ref_id)
  }
  return chosen
}

export const retrieve = (input: RetrievalInput): KnowledgeSynthesis | null => {
  if (!knowledgeEnabled(input.mode)) return null

  const threshold = relevanceThreshold(input)
  const blocked = new Set(input.blockedRefs ?? [])

  const activation = activateKnowledgePacks(input)
  const activeDomains = activation.activeDomains

  const primaryPackSet = new Set(activation.primaryPackIds)
  const strategyPool = [...contextualStrategies(input, activation)]
  const strategyGate = gateRefs(strategyPool, "strategy", threshold, blocked, undefined, (s) => s.pack_id, primaryPackSet)
  const methodologyPool = [...selectMethodologies(input, activation)]
  const methodologyGate = gateRefs(methodologyPool, "methodology", threshold, blocked, undefined, (m) => m.pack_id, primaryPackSet)
  // review_4 M1/M4: knowledge + skill are now retrieved through the same gate (relevance → evidence →
  // per-type top-k → primary-pack guarantee) so the 682 knowledge/skill docs are no longer dead.
  const knowledgePool = loadDiskKnowledge(input.workspacePath, activation)
  const knowledgeGate = gateRefs(knowledgePool, "knowledge", threshold, blocked, undefined, (k) => k.pack_id, primaryPackSet)
  const skillPool = loadDiskSkills(input.workspacePath, activation)
  const skillGate = gateRefs(skillPool, "skill", threshold, blocked, undefined, (s) => s.pack_id, primaryPackSet)
  // Read the memory pool once: selectMemory hits disk, and calling it twice risks the store
  // changing between calls (and doubles I/O).
  const memoryPool = selectMemory(input)
  const memoryGate = gateRefs(memoryPool, "memory", threshold, blocked)

  const selectedStrategies = strategyGate.selected
  const selectedMethodologies = methodologyGate.selected
  const selectedKnowledge = knowledgeGate.selected
  const selectedSkills = skillGate.selected
  const selectedMemory = memoryGate.selected

  const candidateRefs = [
    ...strategyPool.map(strategyProjection),
    ...methodologyPool.map(methodologyProjection),
    ...knowledgePool.map(knowledgeProjection),
    ...skillPool.map(skillProjection),
    ...memoryPool.map(memoryProjection),
  ].sort((a, b) => b.relevance - a.relevance || a.ref_id.localeCompare(b.ref_id)).slice(0, CANDIDATE_REF_CAP)
  const selectedByType = [
    ...selectedStrategies.map(strategyProjection),
    ...selectedMethodologies.map(methodologyProjection),
    ...selectedKnowledge.map(knowledgeProjection),
    ...selectedSkills.map(skillProjection),
    ...selectedMemory.map(memoryProjection),
  ].sort((a, b) => b.relevance - a.relevance || a.ref_id.localeCompare(b.ref_id))

  // B4 (docs/review_38 §八): dynamic global cap + per-pack quota. The cap scales with task
  // complexity (simple 5 / multi-domain 8 / ultra·high-risk 12). Within the cap, selectWithQuota
  // reserves a slot for each primary pack and each active risk pack BEFORE filling by relevance,
  // so an over-activated or high-scoring fallback pack can no longer starve a correctly-matched
  // primary pack (the top-k preemption failure in docs/review_38 §二 B4). Memory has no pack_id, so
  // it competes in the relevance-fill stage only. Overflow → gap_analysis(excluded_by:"global_cap").
  const cap = selectedRefCap(input, activation)
  const toScored = <T extends { ref_id: string; relevance: number; pack_id?: string | null }>(arr: readonly T[]): ScoredId[] =>
    arr.map((r) => ({ ref_id: r.ref_id, relevance: r.relevance, packId: r.pack_id ?? null }))
  const scoredIds: ScoredId[] = [
    ...selectedStrategies.map((s) => ({ ref_id: s.ref_id, relevance: s.relevance, packId: s.pack_id })),
    ...selectedMethodologies.map((m) => ({ ref_id: m.ref_id, relevance: m.relevance, packId: m.pack_id })),
    ...selectedKnowledge.map((k) => ({ ref_id: k.ref_id, relevance: k.relevance, packId: k.pack_id })),
    ...selectedSkills.map((s) => ({ ref_id: s.ref_id, relevance: s.relevance, packId: s.pack_id })),
    ...selectedMemory.map((m) => ({ ref_id: m.ref_id, relevance: m.relevance, packId: null })),
  ]
  // review_4: rescue pool = ALL evidence-passing refs (not just per-type top-k survivors), so a
  // primary starved by per-type contention can still be pulled in by the primary-pack quota.
  const rescuePool: ScoredId[] = [
    ...toScored(strategyPool), ...toScored(methodologyPool),
    ...toScored(knowledgePool), ...toScored(skillPool),
  ].filter((r) => r.relevance >= threshold)
  const cappedRefIds = selectWithQuota(scoredIds, cap, activation, [...scoredIds, ...rescuePool])
  // Build projection lookup for any rescued ref not already in selectedByType.
  const rescuedProjections: KnowledgeRefProjection[] = []
  const inSelectedByType = new Set(selectedByType.map((r) => r.ref_id))
  for (const s of strategyPool) if (cappedRefIds.has(s.ref_id) && !inSelectedByType.has(s.ref_id)) rescuedProjections.push(strategyProjection(s))
  for (const m of methodologyPool) if (cappedRefIds.has(m.ref_id) && !inSelectedByType.has(m.ref_id)) rescuedProjections.push(methodologyProjection(m))
  for (const k of knowledgePool) if (cappedRefIds.has(k.ref_id) && !inSelectedByType.has(k.ref_id)) rescuedProjections.push(knowledgeProjection(k))
  for (const sk of skillPool) if (cappedRefIds.has(sk.ref_id) && !inSelectedByType.has(sk.ref_id)) rescuedProjections.push(skillProjection(sk))
  const selectedRefs = [...selectedByType.filter((r) => cappedRefIds.has(r.ref_id)), ...rescuedProjections]
  const globalCapExcluded = selectedByType.filter((r) => !cappedRefIds.has(r.ref_id))

  // P1-4: filter the per-type selections down to what survived the global cap, so synthesis text,
  // the per-type ref lists, and selectedRefs are all consistent (the work package mirrors these).
  // review_4: union the per-type top-k survivors with any rescued primary refs from the full pool.
  const rescuedIds = new Set(rescuedProjections.map((r) => r.ref_id))
  const keptStrategies = [...selectedStrategies, ...strategyPool.filter((s) => rescuedIds.has(s.ref_id))].filter((s) => cappedRefIds.has(s.ref_id))
  const keptMethodologies = [...selectedMethodologies, ...methodologyPool.filter((m) => rescuedIds.has(m.ref_id))].filter((m) => cappedRefIds.has(m.ref_id))
  const keptKnowledge = [...selectedKnowledge, ...knowledgePool.filter((k) => rescuedIds.has(k.ref_id))].filter((k) => cappedRefIds.has(k.ref_id))
  const keptSkills = [...selectedSkills, ...skillPool.filter((s) => rescuedIds.has(s.ref_id))].filter((s) => cappedRefIds.has(s.ref_id))
  const keptMemory = selectedMemory.filter((m) => cappedRefIds.has(m.ref_id))

  const gapAnalysis = [
    ...strategyGate.gaps,
    ...methodologyGate.gaps,
    ...knowledgeGate.gaps,
    ...skillGate.gaps,
    ...memoryGate.gaps,
    ...globalCapExcluded.map((r) => ({ ref_id: r.ref_id, excluded_by: "global_cap" as const })),
  ]
  const doNotUse = [...strategyGate.doNotUse, ...methodologyGate.doNotUse, ...knowledgeGate.doNotUse, ...skillGate.doNotUse, ...memoryGate.doNotUse]
  const evidenceByRef: Record<string, EvidenceStrength> = {}
  for (const s of keptStrategies) evidenceByRef[s.ref_id] = s.evidence_strength
  for (const m of keptMethodologies) evidenceByRef[m.ref_id] = m.evidence_strength
  for (const k of keptKnowledge) evidenceByRef[k.ref_id] = k.evidence_strength
  for (const s of keptSkills) evidenceByRef[s.ref_id] = s.evidence_strength
  for (const m of keptMemory) evidenceByRef[m.ref_id] = m.evidence_strength

  const synthesisParts: string[] = []
  if (keptStrategies.length > 0) {
    synthesisParts.push("Strategies for this task:")
    for (const s of keptStrategies) synthesisParts.push(`- [${s.ref_id} · ${s.evidence_strength}] ${s.summary}`)
  }
  if (keptMethodologies.length > 0) {
    synthesisParts.push("")
    synthesisParts.push("Applicable methodologies:")
    for (const m of keptMethodologies) synthesisParts.push(`- [${m.ref_id} · ${m.evidence_strength}] ${m.summary}`)
  }
  if (keptKnowledge.length > 0) {
    synthesisParts.push("")
    synthesisParts.push("Relevant domain knowledge:")
    for (const k of keptKnowledge) synthesisParts.push(`- [${k.ref_id} · ${k.evidence_strength}] ${k.summary}`)
  }
  if (keptSkills.length > 0) {
    synthesisParts.push("")
    synthesisParts.push("Applicable skills (load body on demand):")
    for (const s of keptSkills) synthesisParts.push(`- [${s.ref_id} · ${s.evidence_strength}] ${s.summary}`)
  }
  if (keptMemory.length > 0) {
    synthesisParts.push("")
    synthesisParts.push("Relevant memories:")
    for (const m of keptMemory) synthesisParts.push(`- [${m.ref_id} · ${m.evidence_strength}] ${m.summary}`)
  }

  if (synthesisParts.length === 0 && doNotUse.length === 0) return null

  return {
    synthesis: synthesisParts.join("\n"),
    strategyRefs: keptStrategies.map((s) => s.ref_id),
    methodologyRefs: keptMethodologies.map((m) => m.ref_id),
    knowledgeRefs: keptKnowledge.map((k) => k.ref_id),
    skillRefs: keptSkills.map((s) => s.ref_id),
    memoryRefs: keptMemory.map((m) => m.ref_id),
    conflicts: [],
    candidateRefs,
    selectedRefs,
    rejectedRefs: [
      ...gapAnalysis.map((g) => ({ ref_id: g.ref_id, reason: g.excluded_by })),
      ...doNotUse.map((d) => ({ ref_id: d.ref_id, reason: d.reason })),
    ],
    gapAnalysis,
    doNotUse,
    evidenceByRef,
    topkApplied: {
      strategy: clampTopK("strategy"),
      methodology: clampTopK("methodology"),
      knowledge: clampTopK("knowledge"),
      skill: clampTopK("skill"),
      memory: clampTopK("memory"),
    },
    activeDomains,
  }
}

const relevanceThreshold = (input: RetrievalInput): number => {
  if (input.previousFailures >= 2) return 0.7
  if (input.round > 1) return 0.8
  return 0.85
}

type KnowledgeActivation = {
  readonly activePackIds: readonly string[]
  readonly primaryPackIds: readonly string[]
  readonly activeDomains: readonly string[]
  readonly keywords: readonly string[]
}

// review_4 M6: expand fallback to include debugging + review — these are foundational for repair
// and audit tasks even when no specific detector fires. Kept small to avoid diluting primary packs.
const CORE_FALLBACK_PACKS = ["code.core", "code.testing", "code.debugging", "code.review"] as const

const taskText = (input: RetrievalInput): string => [
  input.task.userRequest ?? "",
  input.task.taskType,
  input.task.domain,
  ...input.task.goals,
  ...input.task.successCriteria,
  ...input.task.riskBoundaries,
  ...input.task.validationCommands,
].join(" ")

const retrievalText = (input: RetrievalInput): string => [
  input.task.userRequest ?? "",
  ...input.task.goals,
  ...input.task.successCriteria,
  ...input.task.riskBoundaries,
  ...input.task.validationCommands,
].join(" ")

const keywordsForTask = (input: RetrievalInput): readonly string[] =>
  [...new Set(retrievalText(input).toLowerCase().split(/[^a-z0-9_.#+-]+/).filter((w) => w.length > 2).slice(0, 30))]

const detectTaskKind = (input: RetrievalInput): ExtendedProblemProfile["task_kind"] => {
  const text = taskText(input).toLowerCase()
  if (/\b(review|audit)\b/.test(text)) return "review"
  if (/\b(test|spec|coverage)\b/.test(text)) return "test"
  if (/\b(debug|repro|trace|crash|bug)\b/.test(text)) return "debug"
  if (/\b(migrat|upgrade|schema|backfill)\b/.test(text)) return "migrate"
  if (/\b(optimi[sz]e|performance|benchmark|latency)\b/.test(text)) return "optimize"
  if (/\b(explain|document|describe)\b/.test(text)) return "explain"
  if (/\b(deploy|operate|rollback|production)\b/.test(text)) return "operate"
  return "implement"
}

const profileFromInput = (input: RetrievalInput): ExtendedProblemProfile => {
  const text = taskText(input).toLowerCase()
  const codeDomains = [input.task.domain, ...(input.profile?.domain ? [input.profile.domain] : [])]
  const languages = [input.profile?.language].filter((v): v is string => Boolean(v))
  const frameworks = [input.profile?.framework].filter((v): v is string => Boolean(v))
  const addIf = (condition: boolean, values: readonly string[]) => condition ? values : []
  return {
    scenario_mode: "direct",
    agent_strength: input.mode,
    task_kind: detectTaskKind(input),
    code_domains: [...new Set([
      ...codeDomains,
      ...addIf(/\b(gpu|cuda|rocm|sgemm|kernel)\b/.test(text), ["gpu_kernel", "cuda"]),
      ...addIf(/\b(frontend|web ui|browser|css|dom|viewport|responsive|a11y|accessibility|canvas|image)\b/.test(text), ["frontend", "web", "browser", "css", "accessibility"]),
      ...addIf(/\b(vue|nuxt|pinia|composition api|template binding)\b/.test(text), ["frontend", "vue"]),
      ...addIf(/\b(rest|graphql|rpc|endpoint|openapi|route|request|response|controller|middleware)\b/.test(text), ["backend", "api", "rest", "graphql"]),
      ...addIf(/\b(database|sql|migration|transaction|constraint|index|backfill|rollback|deadlock|explain)\b/.test(text), ["database", "sql", "migration", "transaction"]),
      ...addIf(/\b(review|severity|finding|blocking|residual risk)\b/.test(text), ["review"]),
      ...addIf(/\b(test|fixture|flake|coverage|runner)\b/.test(text), ["testing"]),
      ...addIf(/\b(debug|repro|trace|log|root cause)\b/.test(text), ["debugging"]),
      ...addIf(/\b(typescript|typecheck|tsc|generic|module resolution)\b/.test(text), ["typescript"]),
      ...addIf(/\b(javascript|esm|cjs|node|npm|pnpm|yarn|bun)\b/.test(text), ["javascript"]),
      // B2 (docs/review_38): populate the code_domains enum values detectors check but
      // profileFromInput previously never set, so those structural branches were dead in production.
      ...addIf(/\b(software architecture|architectural boundary|adr|bounded context|service boundary)\b/.test(text), ["architecture"]),
      ...addIf(/\b(observability|logging|metrics|tracing|otel|correlation id)\b/.test(text), ["observability"]),
      ...addIf(/\b(benchmark|baseline|regression threshold|perf test)\b/.test(text), ["benchmarking"]),
      ...addIf(/\b(latency|throughput|profiling|hot path|allocation)\b/.test(text), ["performance"]),
      ...addIf(/\b(web vitals|lighthouse|bundle size|hydration cost|layout shift)\b/.test(text), ["frontend_performance"]),
      ...addIf(/\b(mcp|model context protocol|tool server|tool schema)\b/.test(text), ["mcp"]),
      ...addIf(/\b(read-only query|count rows|list files|inspect state|status check)\b/.test(text), ["query", "deterministic"]),
      // review_4 M3: 21 packs whose detector code_domains were never populated by profileFromInput,
      // so they could only activate via repo_signals regex. Add their core domain enum values.
      ...addIf(/\b(embedded|firmware|rtos|freertos|microcontroller|mcu|bare.?metal|isr)\b/.test(text), ["embedded", "firmware", "rtos"]),
      ...addIf(/\b(kernel module|syscall|device driver|page table|scheduler|ioctl|virtual memory)\b/.test(text), ["kernel", "syscall", "driver"]),
      ...addIf(/\b(distributed|consensus|raft|paxos|replication|quorum|split.?brain|leader election)\b/.test(text), ["distributed", "consensus", "replication"]),
      ...addIf(/\b(blockchain|smart contract|solidity|evm|reentrancy|web3|on.?chain)\b/.test(text), ["blockchain", "smart_contract"]),
      ...addIf(/\b(concurrency|race condition|data race|deadlock|mutex|lock ordering|atomic)\b/.test(text), ["concurrency", "races", "locks"]),
      ...addIf(/\b(tcp|http client|connection timeout|retry policy|backpressure|connection pool|keep.?alive)\b/.test(text), ["networking", "tcp", "http"]),
      ...addIf(/\b(lexer|parser|abstract syntax tree|intermediate representation|code generation|compiler pass|type checker|llvm)\b/.test(text), ["compiler", "parser", "codegen"]),
      ...addIf(/\b(shader|glsl|hlsl|wgsl|rendering pipeline|rasteriz|opengl|vulkan|webgpu|framebuffer)\b/.test(text), ["graphics", "rendering", "shader"]),
      ...addIf(/\b(verilog|systemverilog|vhdl|always_ff|always_comb|testbench|rtl|fpga|synthesi[sz]|clock domain)\b/.test(text), ["hdl", "verilog", "rtl"]),
      ...addIf(/\b(cache line|branch predict|simd|avx|sse|neon|memory barrier|false sharing|numa|cache miss)\b/.test(text), ["cpu_arch", "microarchitecture", "simd"]),
      ...addIf(/\b(assembly|x86-64|arm64|aarch64|calling convention|stack frame|inline asm|disassembl|godbolt)\b/.test(text), ["assembly", "asm"]),
      ...addIf(/\b(etl|elt|data pipeline|kafka|spark|airflow|dagster|data warehouse|data lineage)\b/.test(text), ["data_engineering", "etl", "pipeline"]),
      ...addIf(/\b(training loop|overfitting|train.?test split|data leakage|loss function|gradient|epoch|hyperparameter|pytorch|tensorflow)\b/.test(text), ["ml", "training", "inference"]),
      ...addIf(/\b(model serving|inference server|dynamic batching|triton|vllm|model versioning|inference latency|tensorrt)\b/.test(text), ["model_serving", "inference_serving"]),
      ...addIf(/\b(data quality|data validation|freshness check|data contract|great expectations|data drift|completeness)\b/.test(text), ["data_quality", "freshness"]),
      ...addIf(/\b(elasticsearch|opensearch|inverted index|bm25|relevance ranking|full.?text search|analyzer|query dsl|faceting)\b/.test(text), ["search", "elasticsearch", "ranking"]),
      ...addIf(/\b(serverless|aws lambda|cloud function|faas|cold start|api gateway|lambda function|step function)\b/.test(text), ["serverless", "lambda", "faas"]),
      ...addIf(/\b(websocket|server.?sent event|sse|pub.?sub|live update|realtime|subscription channel)\b/.test(text), ["realtime", "websocket", "sse"]),
      ...addIf(/\b(event bus|message queue|outbox|consumer|dead.?letter|event sourcing|idempotent consumer)\b/.test(text), ["event_driven", "events", "messaging"]),
      ...addIf(/\b(robotics|ros2?|control loop|sensor fusion|actuator|coordinate frame|pid controller)\b/.test(text), ["robotics", "ros", "control"]),
      ...addIf(/\b(command.?line|cli tool|argument parsing|exit code|stdin|stdout|subcommand|flag parsing|argv|getopt)\b/.test(text), ["cli", "command_line"]),
      ...addIf(/\b(game loop|game engine|fixed timestep|entity component|collision detection|sprite|game physics|unity|unreal|godot)\b/.test(text), ["game", "game_loop"]),
      ...addIf(/\b(encryption|aes|aead|hashing|sha-256|bcrypt|key management|cryptograph|nonce|constant.?time|digital signature|kdf)\b/.test(text), ["cryptography", "encryption", "hashing"]),
      ...addIf(/\b(wasm|webassembly|wasm-bindgen|wasi|emscripten|wasm-pack|linear memory)\b/.test(text), ["wasm", "webassembly"]),
    ].filter(Boolean))],
    business_domains: [...new Set([
      ...addIf(/\b(payment|ledger|invoice|trade|financial|money|billing|reconciliation)\b/.test(text), ["finance"]),
      ...addIf(/\b(patient|clinical|healthcare|phi|hipaa|medical|ehr|diagnosis)\b/.test(text), ["healthcare"]),
    ])],
    platforms: [...new Set([
      ...addIf(/\b(web|browser|frontend|viewport|dom|css)\b/.test(text), ["web"]),
      ...addIf(/\b(node|npm|pnpm|yarn|bun)\b/.test(text), ["node"]),
      ...addIf(/\b(docker|dockerfile|container image|multi-stage)\b/.test(text), ["docker"]),
      ...addIf(/\b(aws|gcp|azure|cloud|terraform|iam)\b/.test(text), ["cloud"]),
      ...addIf(/\b(local dev|dev server|localhost|watch mode)\b/.test(text), ["local"]),
    ])],
    languages: [...new Set([
      ...languages,
      ...addIf(/\b(typescript|typecheck|tsc)\b/.test(text), ["typescript"]),
      ...addIf(/\b(javascript|esm|cjs|node)\b/.test(text), ["javascript"]),
      ...addIf(/\b(kotlin|gradle)\b/.test(text), ["kotlin"]),
      ...addIf(/\b(c#|csharp|dotnet|\.net)\b/.test(text), ["csharp"]),
      ...addIf(/\b(cuda|sgemm|kernel)\b/.test(text), ["cpp", "cuda"]),
    ])],
    frameworks: [...new Set([
      ...frameworks,
      ...addIf(/\b(vue|nuxt|pinia)\b/.test(text), ["vue"]),
    ])],
    data_classes: [...new Set([
      ...addIf(/\b(pii|personal data|email|phone|address|user data)\b/.test(text), ["pii", "personal_data"]),
      ...addIf(/\b(phi|patient|clinical|medical record)\b/.test(text), ["phi"]),
      ...addIf(/\b(pci|card number|payment card|cardholder)\b/.test(text), ["pci"]),
      ...addIf(/\b(secret|credential|api key|token|password)\b/.test(text), ["secret_adjacent"]),
    ])],
    risk_markers: [...new Set([
      ...addIf(/\b(security|authz|authorization|injection|secret|trust boundary|xss|csrf)\b/.test(text), ["security"]),
      ...addIf(/\b(privacy|pii|phi|pci|redact|retention|consent|data minimization|export|delete)\b/.test(text), ["privacy"]),
      ...addIf(/\b(production|deploy|deployment|traffic|incident|external state|canary|slo)\b/.test(text), ["production"]),
      // B2: supply-chain / dependency-provenance markers (risk.supply-chain detector reads these).
      ...addIf(/\b(supply chain|dependency provenance|lockfile|postinstall|typosquat|package install)\b/.test(text), ["supply_chain"]),
      ...addIf(/\b(license|spdx|gpl|attribution|redistribution)\b/.test(text), ["license"]),
    ])],
    repo_signals: [taskText(input), ...(input.profile?.signals ?? [])],
    round_signals: [...new Set(input.previousFailures > 0 ? ["previous_round_failure"] : [])],
    user_overrides: input.domainOptions?.override ? [input.domainOptions.override] : [],
  }
}

const activateKnowledgePacks = (input: RetrievalInput): KnowledgeActivation => {
  const profile = profileFromInput(input)
  const threshold = input.domainOptions?.threshold ?? 0.5
  const manifests = Registry.discover()
  const selected = Registry.score(profile, manifests).filter((s) => s.score >= threshold).map((s) => s.packId)
  for (const override of profile.user_overrides) {
    if (!selected.includes(override)) selected.push(override)
  }
  const resolution = Registry.resolve(selected, manifests)
  const active = new Set([...resolution.activePackIds, ...CORE_FALLBACK_PACKS])
  const activeManifests = manifests.filter((m) => active.has(m.id))
  return {
    activePackIds: [...active].sort(),
    primaryPackIds: selected.filter((id) => !CORE_FALLBACK_PACKS.includes(id as typeof CORE_FALLBACK_PACKS[number])).sort(),
    activeDomains: [...new Set(activeManifests.flatMap((m) => m.domains))].sort(),
    keywords: keywordsForTask(input),
  }
}

const packIdOf = (doc: { readonly extensions?: Readonly<Record<string, unknown>>; readonly tags?: readonly string[] }): string | null => {
  if (typeof doc.extensions?.pack_id === "string") return doc.extensions.pack_id
  return doc.tags?.find((tag) => tag.startsWith("pack:"))?.slice("pack:".length) ?? null
}

const rankDoc = (score: number, packId: string | null, activation: KnowledgeActivation): number => {
  if (!packId) return score
  // docs/34 §8: activePackIds is the authoritative retrieval scope. The durable store ranks across
  // ALL seeded docs by keyword, so a high-keyword doc from a NON-active pack (e.g. code.database.postgres
  // on a generic code.database task that did not activate postgres) would otherwise preempt the correctly
  // matched pack. Exclude out-of-scope packs entirely (relevance 0 → dropped by the relevance gate),
  // rather than merely down-weighting them. This is the top-k preemption guard the audit (docs/review_38
  // §二 B4) called for, now load-bearing because many specific sub-packs exist.
  if (!activation.activePackIds.includes(packId)) return 0
  if (activation.primaryPackIds.includes(packId)) return score
  if (CORE_FALLBACK_PACKS.includes(packId as typeof CORE_FALLBACK_PACKS[number])) return score * 0.72
  return score * 0.68
}

// DAP-11: methodologies are seeded into DocumentStore at configure() and retrieved from there.
// Scope-based selection is now handled by the DocumentStore query (tags carry scope info).
const selectMethodologies = (input: RetrievalInput, activation: KnowledgeActivation): MethodologyRef[] => {
  let scored
  try {
    scored = knowledgeSource.queryKnowledge({
      types: ["methodology"],
      activePackIds: activation.activePackIds,
      keywords: activation.keywords,
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      limit: 20,
    })
  } catch {
    return []
  }
  return scored.map(({ doc, score }) => ({
    ref_id: doc.id,
    pack_id: packIdOf(doc),
    scope: doc.domain ?? "general",
    relevance: rankDoc(score, packIdOf(doc), activation),
    summary: doc.description,
    evidence_strength: doc.confidence?.evidence_strength ?? "none",
  }))
}

const contextualStrategies = (input: RetrievalInput, activation: KnowledgeActivation): StrategyRef[] => {
  const hasMcp = input.tools.mcpServers.length > 0 || input.tools.availableTools.some((tool) => tool.source === "mcp")
  return getAllStrategies(input.workspacePath, activation).map((strategy) => {
    if (hasMcp && strategy.ref_id === "strategy:mcp-tool-coordination") {
      return { ...strategy, relevance: Math.max(strategy.relevance, 0.98) }
    }
    return strategy
  })
}

const selectMemory = (input: RetrievalInput): MemoryRef[] => {
  const keywords: string[] = []
  if (input.task.userRequest) {
    const words = input.task.userRequest.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
    keywords.push(...words.slice(0, 10))
  }

  try {
    // P1-3: the keyword-adjusted score (not raw confidence) is the ref's relevance, so a
    // high-confidence but keyword-irrelevant memory does not sail through the relevance gate.
    // docs/34 §8: workspacePath unions this workspace's project-shared memories with user-global;
    // other workspaces' project-shared memory is never read. Only status=active is returned.
    const results = knowledgeSource.queryKnowledge({
      types: ["memory"],
      domain: input.task.domain,
      keywords,
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      limit: 5,
    })
    return results.map(({ doc, score }) => ({
      ref_id: doc.id,
      provenance: `learned:${doc.provenance.run_ref ?? "unknown"}`,
      summary: doc.description,
      relevance: score,
      evidence_strength: doc.confidence?.evidence_strength ?? "none",
    }))
  } catch {
    return []
  }
}
