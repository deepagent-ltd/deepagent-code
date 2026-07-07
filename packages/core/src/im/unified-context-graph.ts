import { Effect } from "effect"
import { GraphQuery } from "../deepagent/graph-query"
import type { DocType, LinkRel } from "../deepagent/document-store"
import type { AgentContextItem } from "./agent-executor"

// V3.8 Phase 3 (roadmap C4, v3.8.1 §B.4): the thin IM adapter over the shared GraphQuery service.
// GraphQuery stays GENERAL (bucketed-by-DocType, scored, IM-agnostic — see graph-query.ts); this
// module is the ONLY place that maps its byType buckets onto AgentContext's four IM buckets. It adds
// no recall logic of its own — it calls GraphQuery.query and re-shapes the result.
//
// CORRECTED bucket mapping (Phase 1 review — the original context-builder double-counted memory):
//   code      <- code_symbol
//   knowledge <- knowledge + strategy + methodology + skill   (NOT memory; skill IS included)
//   memory    <- memory                                       (exclusively — never folded into knowledge)
//   documents <- design + requirements + bugfix

export type UnifiedContext = {
  readonly code: AgentContextItem[]
  readonly knowledge: AgentContextItem[]
  readonly memory: AgentContextItem[]
  readonly documents: AgentContextItem[]
}

// DocType -> bucket assignment. Kept as explicit constants so the "memory not double-counted / skill
// in knowledge" contract is auditable at a glance (and asserted directly in the tests).
export const CODE_TYPES: readonly DocType[] = ["code_symbol"]
export const KNOWLEDGE_TYPES: readonly DocType[] = ["knowledge", "strategy", "methodology", "skill"]
export const MEMORY_TYPES: readonly DocType[] = ["memory"]
export const DOCUMENT_TYPES: readonly DocType[] = ["design", "requirements", "bugfix"]

const EMPTY: UnifiedContext = { code: [], knowledge: [], memory: [], documents: [] }

const toItem = (hit: GraphQuery.GraphHit): AgentContextItem => ({
  id: hit.doc.id,
  type: hit.doc.type,
  description: hit.doc.description,
  relevance: hit.score,
  body: hit.doc.body,
})

// Union the given DocType buckets from a GraphQuery result into one IM bucket. Each per-type bucket
// is already sorted best-first by GraphQuery; after union we re-sort by score desc (tiebreak on id)
// so the merged list is globally coherent.
const collect = (byType: GraphQuery.GraphQueryResult["byType"], types: readonly DocType[]): AgentContextItem[] => {
  const items: AgentContextItem[] = []
  for (const type of types) {
    const hits = byType[type]
    if (!hits) continue
    for (const hit of hits) items.push(toItem(hit))
  }
  items.sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id))
  return items
}

// Pure mapping (exported for unit tests): GraphQuery byType buckets -> the four IM buckets, per the
// corrected mapping above. No I/O, no service dependency.
export const mapResult = (result: GraphQuery.GraphQueryResult): UnifiedContext => ({
  code: collect(result.byType, CODE_TYPES),
  knowledge: collect(result.byType, KNOWLEDGE_TYPES),
  memory: collect(result.byType, MEMORY_TYPES),
  documents: collect(result.byType, DOCUMENT_TYPES),
})

export type UnifiedContextGraphInput = {
  readonly workspacePath?: string
  readonly task?: string
  readonly seeds?: readonly string[]
  readonly rels?: readonly LinkRel[]
  readonly depth?: number
  readonly limitPerType?: number
}

// Query the shared graph and map to IM buckets. Provides GraphQuery.layer internally so callers need
// no extra wiring (R stays `never` for the context-builder). Degradation is total: GraphQuery already
// returns empty buckets when knowledge-source is unconfigured (never throws), and any unexpected
// failure is caught here to an empty context — the builder must never fail (§B.4 降级).
//
// matchCauseEffect (NOT Effect.catch): GraphQuery.layer.query is an Effect.sync over the durable
// stores, and the underlying DocumentStore constructor loads docs eagerly via
// JSON.parse(readFileSync(...)) — a corrupt or unreadable store throws SYNCHRONOUSLY, which surfaces
// as a DEFECT, not a typed error. Effect.catch only recovers the typed error channel and would let
// such a defect escape as a rejected fiber, breaking the "never throws" contract (§B.4 降级).
// matchCauseEffect recovers the FULL cause (typed failures AND defects) to EMPTY.
export const query = (input: UnifiedContextGraphInput): Effect.Effect<UnifiedContext, never, never> =>
  Effect.gen(function* () {
    const svc = yield* GraphQuery.Service
    const result = yield* svc.query(input)
    return mapResult(result)
  }).pipe(
    Effect.provide(GraphQuery.layer),
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed(EMPTY),
      onSuccess: (ctx) => Effect.succeed(ctx),
    }),
  )
