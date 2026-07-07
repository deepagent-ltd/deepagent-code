import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { GraphQuery } from "../src/deepagent/graph-query"
import type { Doc, DocType } from "../src/deepagent/document-store"
import { mapResult, query } from "../src/im/unified-context-graph"
import * as knowledgeSource from "../src/deepagent/knowledge-source"
import { projectKnowledgeRoot, projectIdForWorkspace } from "../src/deepagent/durable-knowledge-store"

// V3.8 Phase 3 (roadmap C4, v3.8.1 §B.4): UnifiedContextGraph is the thin IM adapter over the shared
// GraphQuery service. These tests pin the CORRECTED DocType→bucket mapping from the Phase 1 review:
//   code      <- code_symbol
//   knowledge <- knowledge + strategy + methodology + skill   (memory NOT folded in; skill IS)
//   memory    <- memory (exclusively)
//   documents <- design + requirements + bugfix

const doc = (id: string, type: DocType, description = id): Doc => ({
  id,
  type,
  scope: "durable",
  status: "active",
  version: 1,
  superseded_by: null,
  hash: "sha256:test",
  created_round: null,
  domain: null,
  tags: [],
  description,
  provenance: { source: "tool", run_ref: "test", evidence_refs: [] },
  links: [],
  body: `body of ${id}`,
})

const hit = (id: string, type: DocType, score: number): GraphQuery.GraphHit => ({
  doc: doc(id, type, `${id} description`),
  score,
  distance: 0,
})

describe("UnifiedContextGraph mapping (Phase 3)", () => {
  it("maps every bucket type per the corrected mapping", () => {
    const result: GraphQuery.GraphQueryResult = {
      byType: {
        code_symbol: [hit("c1", "code_symbol", 0.9)],
        knowledge: [hit("k1", "knowledge", 0.8)],
        strategy: [hit("s1", "strategy", 0.7)],
        methodology: [hit("m1", "methodology", 0.6)],
        skill: [hit("sk1", "skill", 0.5)],
        memory: [hit("mem1", "memory", 0.85)],
        design: [hit("d1", "design", 0.75)],
        requirements: [hit("r1", "requirements", 0.65)],
        bugfix: [hit("b1", "bugfix", 0.55)],
      },
    }

    const mapped = mapResult(result)

    // code <- code_symbol
    expect(mapped.code.map((i) => i.id)).toEqual(["c1"])

    // knowledge <- knowledge + strategy + methodology + skill (sorted by relevance desc)
    expect(mapped.knowledge.map((i) => i.id)).toEqual(["k1", "s1", "m1", "sk1"])
    // skill IS included in knowledge
    expect(mapped.knowledge.some((i) => i.type === "skill")).toBe(true)
    // memory is NOT double-counted into knowledge
    expect(mapped.knowledge.some((i) => i.type === "memory")).toBe(false)

    // memory <- memory exclusively
    expect(mapped.memory.map((i) => i.id)).toEqual(["mem1"])

    // documents <- design + requirements + bugfix
    expect(mapped.documents.map((i) => i.id)).toEqual(["d1", "r1", "b1"])
  })

  it("each hit becomes an AgentContextItem {id,type,description,relevance,body}", () => {
    const result: GraphQuery.GraphQueryResult = {
      byType: { code_symbol: [hit("c1", "code_symbol", 0.42)] },
    }
    const item = mapResult(result).code[0]!
    expect(item).toEqual({
      id: "c1",
      type: "code_symbol",
      description: "c1 description",
      relevance: 0.42,
      body: "body of c1",
    })
  })

  it("empty GraphQuery result maps to four empty buckets", () => {
    const mapped = mapResult({ byType: {} })
    expect(mapped).toEqual({ code: [], knowledge: [], memory: [], documents: [] })
  })

  it("knowledge union sorts across source types by relevance", () => {
    const result: GraphQuery.GraphQueryResult = {
      byType: {
        knowledge: [hit("k-low", "knowledge", 0.1)],
        skill: [hit("sk-high", "skill", 0.99)],
        strategy: [hit("s-mid", "strategy", 0.5)],
      },
    }
    expect(mapResult(result).knowledge.map((i) => i.id)).toEqual(["sk-high", "s-mid", "k-low"])
  })
})

describe("UnifiedContextGraph.query degradation (Phase 3 §B.4 降级)", () => {
  let base: string | null = null
  afterEach(() => {
    knowledgeSource.invalidateCache()
    if (base) rmSync(base, { recursive: true, force: true })
    base = null
  })

  it("returns EMPTY (never throws) when the graph is unconfigured", async () => {
    knowledgeSource.invalidateCache()
    // No configure() → GraphQuery.layer's isConfigured() guard yields emptyResult.
    const ctx = await Effect.runPromise(query({ workspacePath: "/work/x", task: "anything" }))
    expect(ctx).toEqual({ code: [], knowledge: [], memory: [], documents: [] })
  })

  it("recovers a DEFECT (corrupt store throws synchronously) to EMPTY — not just typed failures", async () => {
    // The store constructor eagerly loads docs via JSON.parse(readFileSync(...)); a corrupt doc file
    // makes storesForWorkspace() throw SYNCHRONOUSLY inside GraphQuery.layer's Effect.sync, surfacing
    // as a DEFECT. Effect.catch would let it escape; catchAllCause (the fix) recovers it. This test
    // FAILS (unhandled rejection) if the combinator is reverted to Effect.catch.
    base = mkdtempSync(path.join(tmpdir(), "deepagent-ucg-defect-"))
    const workspacePath = "/work/corrupt-repo"
    const projRoot = projectKnowledgeRoot(base, projectIdForWorkspace(workspacePath))
    const corruptTypeDir = path.join(projRoot, "docs", "design")
    mkdirSync(corruptTypeDir, { recursive: true })
    writeFileSync(path.join(corruptTypeDir, "corrupt@v1.json"), "{ this is not valid json")

    knowledgeSource.configure(base)
    knowledgeSource.invalidateCache()
    const ctx = await Effect.runPromise(query({ workspacePath, task: "anything" }))
    expect(ctx).toEqual({ code: [], knowledge: [], memory: [], documents: [] })
  })
})
