export * as GraphQuery from "./graph-query"

import { Context, Effect, Layer } from "effect"
import type { Doc, DocRef, DocType, LinkRel } from "./document-store"
import { knowledgeSimilarity } from "./document-store"
import type { DurableKnowledgeStore } from "./durable-knowledge-store"
import * as knowledgeSource from "./knowledge-source"

// V3.8 Phase 1 (roadmap C5, v3.8.1 B.4): the ONE shared graph-recall service that both the IM
// UnifiedContextGraph (Phase 3) and the Appendix-A Curator recall (Phase 7) build on. It is
// deliberately GENERAL -- bucketed-by-DocType + scored -- never IM-specific. UnifiedContextGraph is
// a thin adapter that maps these buckets onto AgentContext's {code,knowledge,memory,documents}.
//
// What it does that retrieve()/queryKnowledge CANNOT:
//  - reaches nodes directly via DurableKnowledgeStore.documentStore (the read-only getter), so it is
//    NOT filtered by KNOWLEDGE_DOC_TYPES. design/requirements/bugfix/code_symbol therefore surface
//    here even though retrieve() drops them (roadmap C3 / v3.8.1 B.1 "documents bucket is dead").
//  - walks cross-type edges with DocumentStore.neighbors(id, rels, depth) WITHIN each physical store
//    (INV-3: links are single-store, so traversal is single-store -- never cross user-global/project).
//  - unions the per-scope physical stores (user-global + per-project) the SAME way queryKnowledge
//    does, reusing knowledge-source.storesForWorkspace so the cached store instances are shared.
//
// Scoring = token/keyword similarity (knowledgeSimilarity overlap coefficient, NO embeddings) with a
// graph-distance decay: a node reached as a neighbor scores its own text-similarity multiplied by a
// per-hop decay, so closer (more directly linked) neighbors outrank far ones. Seed matches (distance
// 0) keep full similarity.

// Default cross-type relations walked from a seed. Covers the code<->doc edges (references/
// implements) plus the knowledge-derivation edges (derived_from/validated_by/refines/depends_on) so
// a code_symbol seed can pull the design/knowledge it references and a doc seed can pull what it was
// derived from. Callers may override via GraphQueryInput.rels.
export const DEFAULT_RELS: readonly LinkRel[] = [
  "references",
  "implements",
  "derived_from",
  "validated_by",
  "refines",
  "depends_on",
  "supports",
  "requires",
]

export const DEFAULT_DEPTH = 2
export const DEFAULT_LIMIT_PER_TYPE = 10
// Per-hop multiplicative decay applied to a neighbor's own text similarity (distance 1 -> x0.6,
// distance 2 -> x0.36, ...). Keeps direct links ahead of transitive ones without zeroing them out.
export const DEFAULT_DISTANCE_DECAY = 0.6

// A single scored graph hit. `distance` is the min hop count from any seed (0 = the seed/keyword
// match itself). `doc` is the full node (body included) so callers can render or progressively
// disclose without a second fetch.
export type GraphHit = {
  readonly doc: Doc
  readonly score: number
  readonly distance: number
}

// Results bucketed by DocType. `byType` is the general form (every DocType that produced a hit);
// callers that only care about a few types read those keys. Each bucket is sorted best-first and
// capped to limitPerType. Kept general (not IM-shaped) so the Curator recall can consume it too.
export type GraphQueryResult = {
  readonly byType: Readonly<Partial<Record<DocType, readonly GraphHit[]>>>
}

export type GraphQueryInput = {
  // Workspace path selecting the per-project store to union with user-global. Omitted -> user-global
  // only (matches queryKnowledge's optional-workspace behavior).
  readonly workspacePath?: string
  // Free-text task/query used for keyword similarity against every candidate node's text.
  readonly task?: string
  // Explicit entry-node ids (e.g. code paths already resolved to code_symbol ids, or known doc ids).
  // When present, neighbors() traversal starts from these in addition to any keyword seed matches.
  readonly seeds?: readonly string[]
  // Restrict the buckets returned. Omitted -> all DocTypes that produced a hit.
  readonly types?: readonly DocType[]
  // Link relations to traverse. Defaults to DEFAULT_RELS.
  readonly rels?: readonly LinkRel[]
  // BFS depth for neighbors(). Defaults to DEFAULT_DEPTH.
  readonly depth?: number
  // Per-bucket cap after scoring/sort. Defaults to DEFAULT_LIMIT_PER_TYPE.
  readonly limitPerType?: number
}

export interface Interface {
  readonly query: (input: GraphQueryInput) => Effect.Effect<GraphQueryResult>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/deepagent/GraphQuery") {}

// text used for similarity: description carries the human summary, tags add keyword surface, body is
// included so code_symbol signatures / doc contents contribute. Bounded so a huge body cannot swamp
// the token set.
const nodeText = (doc: Doc): string =>
  `${doc.description} ${doc.tags.join(" ")} ${doc.body}`.slice(0, 4000)

// Similarity of a node against the free-text task. Returns 0 when there is no task (seed-only query):
// seed nodes still enter at distance 0 with a floor score so an explicit seed is never dropped.
const similarity = (doc: Doc, task: string | undefined): number =>
  task && task.length > 0 ? knowledgeSimilarity(nodeText(doc), task) : 0

// Score for a hit at a given graph distance: text similarity decayed per hop. Every REACHED node
// (seed, keyword match, or pure graph neighbor) gets at least a small positive floor before decay,
// so a node pulled in purely by traversal (zero keyword overlap) still surfaces -- being linked IS
// the relevance signal -- while keyword similarity dominates when present. Decay^distance then keeps
// closer nodes ahead of far ones.
const scoreAt = (sim: number, distance: number): number =>
  Math.max(sim, REACHED_FLOOR) * Math.pow(DEFAULT_DISTANCE_DECAY, distance)

const REACHED_FLOOR = 0.01

// Walk one physical store: collect keyword-seed matches + explicit seeds at distance 0, then expand
// via neighbors() up to `depth`, tracking the minimum distance at which each node is reached. All
// reads go through store.documentStore (the read-only getter) -> NO retrieve() whitelist.
const collectFromStore = (
  store: DurableKnowledgeStore,
  input: GraphQueryInput,
  rels: readonly LinkRel[],
  depth: number,
): Map<string, { doc: Doc; distance: number }> => {
  const ds = store.documentStore
  const found = new Map<string, { doc: Doc; distance: number }>()

  const consider = (id: string, distance: number): boolean => {
    const doc = ds.get(id)
    if (!doc) return false
    const existing = found.get(id)
    if (existing && existing.distance <= distance) return false
    found.set(id, { doc, distance })
    return true
  }

  // Distance-0 frontier: explicit seeds (if the id exists in this store) + keyword matches over all
  // listed nodes. list() already drops sealed docs (INV-7) and yields latest versions only.
  const frontier: string[] = []
  for (const seedId of input.seeds ?? []) if (consider(seedId, 0)) frontier.push(seedId)

  const task = input.task
  if (task && task.length > 0) {
    for (const ref of ds.list()) {
      if (found.has(ref.id)) continue
      const doc = ds.get(ref.id)
      if (!doc) continue
      if (knowledgeSimilarity(nodeText(doc), task) <= 0) continue
      found.set(ref.id, { doc, distance: 0 })
      frontier.push(ref.id)
    }
  }

  // Expand cross-type neighbors from every distance-0 node in one BFS per seed. neighbors() itself
  // does depth-bounded BFS; we call it per frontier node and record hop distance by re-walking level
  // by level so the min-distance bookkeeping is exact (neighbors() returns refs without distance).
  for (const startId of frontier) {
    let level: string[] = [startId]
    const localSeen = new Set<string>([startId])
    for (let d = 1; d <= depth; d++) {
      const step: DocRef[] = []
      for (const cur of level) for (const r of ds.neighbors(cur, rels, 1)) step.push(r)
      const nextLevel: string[] = []
      for (const ref of step) {
        if (localSeen.has(ref.id)) continue
        localSeen.add(ref.id)
        consider(ref.id, d)
        nextLevel.push(ref.id)
      }
      if (nextLevel.length === 0) break
      level = nextLevel
    }
  }

  return found
}

const emptyResult: GraphQueryResult = { byType: {} }

// Pure core (exported for unit tests): union the given stores, score, bucket by DocType, cap.
export const runQuery = (
  stores: readonly DurableKnowledgeStore[],
  input: GraphQueryInput,
): GraphQueryResult => {
  const rels = input.rels ?? DEFAULT_RELS
  const depth = input.depth ?? DEFAULT_DEPTH
  const limitPerType = input.limitPerType ?? DEFAULT_LIMIT_PER_TYPE
  const wantTypes = input.types ? new Set(input.types) : null

  // Union across stores, deduping by id and keeping the closest (min-distance) sighting.
  const merged = new Map<string, { doc: Doc; distance: number }>()
  for (const store of stores) {
    for (const [id, hit] of collectFromStore(store, input, rels, depth)) {
      const existing = merged.get(id)
      if (!existing || hit.distance < existing.distance) merged.set(id, hit)
    }
  }

  const buckets = new Map<DocType, GraphHit[]>()
  for (const { doc, distance } of merged.values()) {
    if (wantTypes && !wantTypes.has(doc.type)) continue
    const score = scoreAt(similarity(doc, input.task), distance)
    if (score <= 0) continue
    const bucket = buckets.get(doc.type) ?? []
    bucket.push({ doc, score, distance })
    buckets.set(doc.type, bucket)
  }

  const byType: Partial<Record<DocType, readonly GraphHit[]>> = {}
  for (const [type, hits] of buckets) {
    hits.sort((a, b) => b.score - a.score || a.distance - b.distance || a.doc.id.localeCompare(b.doc.id))
    byType[type] = hits.slice(0, limitPerType)
  }
  return { byType }
}

export const layer = Layer.succeed(
  Service,
  Service.of({
    query: (input) =>
      Effect.sync(() => {
        // Graceful degradation: knowledge-source not configured -> empty buckets, never throw
        // (matches the isConfigured() guard the retriever uses before touching durable stores).
        if (!knowledgeSource.isConfigured()) return emptyResult
        const stores = knowledgeSource.storesForWorkspace(input.workspacePath)
        return runQuery(stores, input)
      }),
  }),
)
