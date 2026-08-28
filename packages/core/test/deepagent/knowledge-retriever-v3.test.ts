import { describe, expect, test, beforeAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { seedCoreKnowledge } from "../../src/deepagent/knowledge-seed"
import { openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import {
  retrieve,
  gateRefs,
  clampTopK,
  evidenceFromConfidence,
  releasedDocumentAuthorityKey,
  type EvidenceStrength,
} from "../../src/deepagent/knowledge-retriever"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"
import { DeepAgentReleasedSnapshot, type Selection } from "../../src/deepagent/released-snapshot"
import { Hash } from "../../src/util/hash"

const task: TaskContext = {
  userRequest: "fix the failing typecheck in the auth module",
  taskType: "bug_fix",
  domain: "code",
  goals: [],
  successCriteria: [],
  riskBoundaries: [],
  validationCommands: [],
}
const tools: ToolContext = { availableTools: [], mcpServers: [], totalToolCount: 0 }
let releasedSelection: Selection

const item = (ref_id: string, relevance: number, evidence_strength: EvidenceStrength) => ({
  ref_id,
  relevance,
  evidence_strength,
})

beforeAll(() => {
  // isolate disk knowledge so retrieve() has a clean store, then seed the core in-code knowledge
  // into it (DAP-11: the curated strategies/methodologies now live in DocumentStore, not in-code).
  const dir = mkdtempSync(path.join(tmpdir(), "deepagent-mem-"))
  knowledgeSource.configure(dir)
  const store = openUserGlobalStore(dir)
  seedCoreKnowledge(store)
  const documents = store
    .listByStatus("active")
    .map((doc) => DeepAgentReleasedSnapshot.documentRef(store.documentStore.get(doc.id)!, "user_global"))
  releasedSelection = {
    snapshotId: "knowledge-retriever-v3",
    securityNamespaceId: "knowledge-retriever-v3-namespace",
    projectScopeKey: "knowledge-retriever-v3-project",
    legacyProjectId: "global",
    parentSnapshotId: null,
    generation: 1,
    membershipHash: DeepAgentReleasedSnapshot.exactRefsFingerprint(documents),
    manifestHash: Hash.sha256("knowledge-retriever-v3"),
    documents,
  }
})

describe("V3 knowledge gates", () => {
  test("gateRefs: blocked -> do_not_use, relevance + evidence gates, gaps recorded", () => {
    const items = [
      item("a", 0.9, "strong"),
      item("b", 0.9, "weak"), // excluded by evidence
      item("c", 0.2, "strong"), // excluded by relevance
      item("d", 0.8, "medium"),
      item("e", 0.85, "strong"),
    ]
    const g = gateRefs(items, "strategy", 0.45, new Set(["a"]))
    expect(g.doNotUse.map((d) => d.ref_id)).toEqual(["a"])
    expect(g.selected.map((s) => s.ref_id)).toEqual(["e", "d"]) // sorted by relevance, a blocked
    expect(g.gaps.some((x) => x.ref_id === "b" && x.excluded_by === "evidence")).toBe(true)
    expect(g.gaps.some((x) => x.ref_id === "c" && x.excluded_by === "relevance")).toBe(true)
  })

  test("gateRefs: mandatory top-k clamps to hard cap", () => {
    const items = Array.from({ length: 8 }, (_, i) => item(`s${i}`, 0.9, "strong"))
    const g = gateRefs(items, "strategy", 0.45, new Set(), 99)
    expect(g.selected.length).toBe(5) // strategy hard cap, never unlimited
    expect(g.gaps.filter((x) => x.excluded_by === "topk").length).toBe(3)
  })

  test("gateRefs keeps same-id released documents independent and supports exact authority blocking", () => {
    const globalRef = {
      ...item("same-id", 0.95, "strong"),
      document_ref: {
        sourceStore: "user_global" as const,
        id: "same-id",
        version: 1,
        hash: "sha256:" + "a".repeat(64),
        type: "memory" as const,
        scope: "durable",
      },
    }
    const projectRef = {
      ...item("same-id", 0.9, "strong"),
      document_ref: {
        sourceStore: "project" as const,
        id: "same-id",
        version: 2,
        hash: "sha256:" + "b".repeat(64),
        type: "memory" as const,
        scope: "durable:project:test",
      },
    }
    const result = gateRefs(
      [globalRef, projectRef],
      "memory",
      0.45,
      new Set([releasedDocumentAuthorityKey(globalRef.document_ref)]),
    )

    expect(result.selected.map((ref) => releasedDocumentAuthorityKey(ref.document_ref))).toEqual([
      releasedDocumentAuthorityKey(projectRef.document_ref),
    ])
    expect(result.doNotUse).toEqual([
      {
        ref_id: "same-id",
        authority_ref: releasedDocumentAuthorityKey(globalRef.document_ref),
        reason: "blocked by diagnosis",
      },
    ])
  })

  test("clampTopK cannot be disabled and respects caps", () => {
    expect(clampTopK("strategy", 0)).toBe(3) // 0 -> default, gate cannot be off
    expect(clampTopK("strategy", 99)).toBe(5)
    expect(clampTopK("methodology", 99)).toBe(3)
    expect(clampTopK("memory")).toBe(3)
  })

  test("evidenceFromConfidence mapping", () => {
    expect(evidenceFromConfidence(0.9)).toBe("strong")
    expect(evidenceFromConfidence(0.6)).toBe("medium")
    expect(evidenceFromConfidence(0.1)).toBe("weak")
    expect(evidenceFromConfidence(0)).toBe("none")
  })

  test("retrieve: general mode carries no durable knowledge", () => {
    expect(retrieve({ mode: "general", task, tools, round: 1, previousFailures: 0, releasedSelection })).toBeNull()
  })

  test("retrieve: high mode injects no strategy/methodology (docs/39 §3.1)", () => {
    // high does durable retrieval (skills + memory) but never strategies/methodologies.
    const r = retrieve({ mode: "high", task, tools, round: 1, previousFailures: 0, releasedSelection })
    if (r) {
      expect(r.strategyRefs).toEqual([])
      expect(r.methodologyRefs).toEqual([])
    }
  })

  test("retrieve: xhigh injects no strategy/methodology, but allows domain knowledge (docs/39 §3.1)", () => {
    const r = retrieve({ mode: "xhigh", task, tools, round: 1, previousFailures: 0, releasedSelection })
    if (r) {
      expect(r.strategyRefs).toEqual([])
      expect(r.methodologyRefs).toEqual([])
    }
  })

  test("retrieve: max mode is bounded, advisory, and evidence-annotated", () => {
    const r = retrieve({ mode: "max", task, tools, round: 1, previousFailures: 0, releasedSelection })
    expect(r).not.toBeNull()
    expect(r!.strategyRefs.length).toBeLessThanOrEqual(3) // mandatory top-k
    expect(r!.methodologyRefs.length).toBeLessThanOrEqual(2) // raised M2: 1→2
    expect(r!.topkApplied).toMatchObject({ strategy: 3, methodology: 2, memory: 3 })
    expect(r!.gapAnalysis).toBeDefined()
    // every injected strategy has an evidence strength recorded
    for (const ref of r!.strategyRefs) expect(r!.evidenceByRef![ref]).toBeDefined()
    // advisory synthesis annotates admitted evidence strength inline; medium and strong are both allowed.
    expect(r!.synthesis).toMatch(/· (medium|strong)/)
  })

  test("retrieve: diagnosis-blocked ref goes to do_not_use, never selected", () => {
    // Seed ids are `doc:strategy:<slug>`. Get a real id from the pool first.
    const base = retrieve({ mode: "max", task, tools, round: 1, previousFailures: 0, releasedSelection })
    const realRef = base?.strategyRefs[0]
    if (!realRef) return // nothing seeded in this env — skip
    const r = retrieve({
      mode: "max",
      task,
      tools,
      round: 1,
      previousFailures: 0,
      blockedRefs: [realRef],
      releasedSelection,
    })
    expect(r!.strategyRefs).not.toContain(realRef)
    expect(r!.doNotUse!.some((d) => d.ref_id === realRef)).toBe(true)
  })
})
