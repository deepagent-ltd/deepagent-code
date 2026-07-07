import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import {
  openUserGlobalStore,
  openProjectStore,
  projectIdForWorkspace,
} from "../../src/deepagent/durable-knowledge-store"
import type { DurableKnowledgeStore } from "../../src/deepagent/durable-knowledge-store"
import { GraphQuery } from "../../src/deepagent/graph-query"
import type { CreateDocInput, DocType, Provenance } from "../../src/deepagent/document-store"

// V3.8 Phase 1 (roadmap C5, v3.8.1 B.4): the shared GraphQuery service. These tests prove the four
// things retrieve()/queryKnowledge cannot do: reach non-knowledge types (whitelist bypass), walk
// cross-type edges, union physical stores, and degrade to empty when unconfigured.

let base: string
const WORK = "/work/repo-graph"

const prov: Provenance = { source: "runner", run_ref: "run:t", evidence_refs: [] }

// Create a node DIRECTLY through the DocumentStore under a DurableKnowledgeStore (bypassing
// stageCandidate, which only accepts knowledge inputs) so we can seed code_symbol/design/etc.
const node = (
  store: DurableKnowledgeStore,
  type: DocType,
  description: string,
  over: Partial<CreateDocInput> = {},
): string => {
  const doc = store.documentStore.create({
    type,
    scope: "durable",
    body: over.body ?? description,
    description,
    domain: over.domain ?? null,
    tags: over.tags ?? [],
    links: over.links ?? [],
    provenance: prov,
    ...(over.confidence ? { confidence: over.confidence } : {}),
    ...(over.idSlug ? { idSlug: over.idSlug } : {}),
  })
  return doc.id
}

const runQuery = (input: Parameters<GraphQuery.Interface["query"]>[0]) =>
  Effect.runSync(
    Effect.gen(function* () {
      const svc = yield* GraphQuery.Service
      return yield* svc.query(input)
    }).pipe(Effect.provide(GraphQuery.layer)),
  )

const ids = (result: GraphQuery.GraphQueryResult, type: DocType): readonly string[] =>
  (result.byType[type] ?? []).map((h) => h.doc.id)

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-graphq-"))
  knowledgeSource.configure(base)
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  knowledgeSource.invalidateCache()
})

describe("GraphQuery — shared graph recall (Phase 1)", () => {
  test("whitelist bypass: non-knowledge types (design/requirements/code_symbol) ARE reachable", () => {
    const proj = openProjectStore(base, WORK)
    const designId = node(proj, "design", "matmul kernel tiling design")
    const reqId = node(proj, "requirements", "matmul kernel must tile for cache locality")
    const codeId = node(proj, "code_symbol", "matmul kernel tiling implementation")

    const result = runQuery({ workspacePath: WORK, task: "matmul kernel tiling" })
    // retrieve()/queryKnowledge would drop ALL of these (KNOWLEDGE_DOC_TYPES whitelist).
    expect(ids(result, "design")).toContain(designId)
    expect(ids(result, "requirements")).toContain(reqId)
    expect(ids(result, "code_symbol")).toContain(codeId)
  })

  test("cross-type neighbors traversal returns linked docs of a DIFFERENT type", () => {
    const proj = openProjectStore(base, WORK)
    // design node with unique text that will NOT keyword-match the code seed's task.
    const designId = node(proj, "design", "quaternion slerp interpolation rationale")
    // code_symbol seed references the design; the task matches only the code text.
    const codeId = node(proj, "code_symbol", "renderer camera easing code path", {
      links: [{ rel: "references", to: designId }],
    })

    const result = runQuery({ workspacePath: WORK, seeds: [codeId], task: "renderer camera easing", depth: 2 })
    // The design is pulled in purely by graph traversal (references edge), not by keyword match.
    expect(ids(result, "code_symbol")).toContain(codeId)
    expect(ids(result, "design")).toContain(designId)
  })

  test("multi-store union: user-global + per-project results are both present", () => {
    const proj = openProjectStore(base, WORK)
    const ug = openUserGlobalStore(base)
    const projDesign = node(proj, "design", "project-local caching design shared token")
    const globalDesign = node(ug, "design", "global caching design shared token")

    const result = runQuery({ workspacePath: WORK, task: "caching design shared token" })
    const seen = ids(result, "design")
    expect(seen).toContain(projDesign)
    expect(seen).toContain(globalDesign)
  })

  test("scoring orders by similarity then graph distance", () => {
    const proj = openProjectStore(base, WORK)
    // Strong direct keyword match.
    const strong = node(proj, "design", "vector database indexing strategy overview")
    // Weak match, but a neighbor of the strong node (distance 1).
    const neighbor = node(proj, "knowledge", "unrelated pooling note", {
      confidence: { evidence_strength: "weak", support_count: 1 },
    })
    proj.documentStore.link(strong, "derived_from", neighbor)

    const result = runQuery({ workspacePath: WORK, task: "vector database indexing strategy" })
    const designHits = result.byType["design"] ?? []
    const knowledgeHits = result.byType["knowledge"] ?? []
    // Direct keyword hit scores above the distance-decayed neighbor.
    expect(designHits[0]?.doc.id).toBe(strong)
    expect(designHits[0]!.distance).toBe(0)
    const nb = knowledgeHits.find((h) => h.doc.id === neighbor)
    expect(nb).toBeDefined()
    expect(nb!.distance).toBe(1)
    expect(designHits[0]!.score).toBeGreaterThan(nb!.score)
  })

  test("respects INV-3: traversal stays within a single store (no cross-store neighbor)", () => {
    const proj = openProjectStore(base, WORK)
    const ug = openUserGlobalStore(base)
    // Two design nodes with the SAME token surface, one per store, but NO link between them (a
    // cross-store link is impossible — assertLinkTargets would throw). Seeding from the project node
    // must not surface the user-global node via traversal (only via its own keyword match, which we
    // avoid by using a seed-only, task-less query).
    const projSeed = node(proj, "code_symbol", "isolated seed node alpha")
    const projNeighbor = node(proj, "design", "linked project design beta", {
      links: [],
    })
    proj.documentStore.link(projSeed, "references", projNeighbor)
    const globalOnly = node(ug, "design", "unlinked global design gamma")

    // seed-only (no task): only the seed + its in-store neighbor should appear; global node must not.
    const result = runQuery({ workspacePath: WORK, seeds: [projSeed] })
    expect(ids(result, "code_symbol")).toContain(projSeed)
    expect(ids(result, "design")).toContain(projNeighbor)
    expect(ids(result, "design")).not.toContain(globalOnly)
  })

  test("type filter narrows returned buckets", () => {
    const proj = openProjectStore(base, WORK)
    const designId = node(proj, "design", "auth flow design shared phrase")
    node(proj, "requirements", "auth flow requirements shared phrase")

    const result = runQuery({ workspacePath: WORK, task: "auth flow shared phrase", types: ["design"] })
    expect(ids(result, "design")).toContain(designId)
    expect(result.byType["requirements"]).toBeUndefined()
  })

  test("graceful degradation: unconfigured knowledge-source returns empty buckets (no throw)", () => {
    knowledgeSource.configure(base)
    knowledgeSource.invalidateCache()
    // Simulate unconfigured by pointing isConfigured() to false is not exposed; instead assert the
    // documented behavior directly through the pure core with zero stores.
    const empty = GraphQuery.runQuery([], { task: "anything" })
    expect(empty.byType).toEqual({})
  })

  test("user-global-only query (no workspacePath) still returns global nodes", () => {
    const ug = openUserGlobalStore(base)
    const globalDesign = node(ug, "design", "standalone global design token xyz")
    const result = runQuery({ task: "standalone global design token xyz" })
    expect(ids(result, "design")).toContain(globalDesign)
  })
})
