import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { openUserGlobalStore, type KnowledgeDocInput } from "../../src/deepagent/durable-knowledge-store"
import { retrieve, invalidateCache } from "../../src/deepagent/knowledge-retriever"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"

// docs/34 §7.3 approval model: accessibility is the DocStatus flag (candidate/active/rejected),
// flipped in place by the durable store. Only "active" docs are retrievable; candidate/rejected
// stay out; the flip is reversible with no new id and no file move.

let base: string
const task: TaskContext = {
  userRequest: "optimize the gemm kernel for bank conflicts",
  taskType: "code_modification",
  domain: "code",
  goals: [],
  successCriteria: [],
  riskBoundaries: [],
  validationCommands: [],
}
const tools: ToolContext = { availableTools: [], mcpServers: [], totalToolCount: 0 }

const stratInput = (over: Partial<KnowledgeDocInput> = {}): KnowledgeDocInput => ({
  type: "strategy",
  description: "diagnosis identified bank conflict; padding fixed it",
  body: "pad the shared tile",
  domain: "code",
  tags: ["learned"],
  scope: "user-global",
  sensitivity: "source_code",
  risk: "low",
  confidence: { evidence_strength: "strong", support_count: 1 },
  provenance: { source: "runner", run_ref: "run1", evidence_refs: ["run:run1"] },
  ...over,
})

const retrievedRefIds = (): string[] => {
  invalidateCache()
  const result = retrieve({ mode: "max", task, tools, round: 1, previousFailures: 0 })
  return (result?.candidateRefs ?? []).map((r) => r.ref_id)
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-approval-"))
  knowledgeSource.configure(base)
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  invalidateCache()
})

describe("docs/34 §7.3 approval (DocStatus) gating", () => {
  test("candidate (pending) entry is NOT retrievable", () => {
    const store = openUserGlobalStore(base)
    const doc = store.stageCandidate(stratInput())
    expect(retrievedRefIds()).not.toContain(doc.id)
  })

  test("approved entry IS retrievable; rejecting removes it again (reversible, no file move)", () => {
    const store = openUserGlobalStore(base)
    const doc = store.stageCandidate(stratInput())
    const v1 = doc.version

    store.approve(doc.id)
    expect(retrievedRefIds()).toContain(doc.id)

    store.reject(doc.id)
    expect(retrievedRefIds()).not.toContain(doc.id)

    store.approve(doc.id)
    expect(retrievedRefIds()).toContain(doc.id)

    // in-place flips: same id, same version (no supersede, no new id)
    const after = store.documentStore.get(doc.id)!
    expect(after.id).toBe(doc.id)
    expect(after.version).toBe(v1)
  })

  test("listByStatus surfaces candidate and rejected for the Review UI", () => {
    const store = openUserGlobalStore(base)
    const p = store.stageCandidate(stratInput({ idSlug: "pending-one", description: "pad shared memory to remove bank conflicts" }))
    const r = store.stageCandidate(stratInput({ idSlug: "rejected-one", description: "prefetch tiles into registers before the loop" }))
    store.reject(r.id)
    expect(store.listByStatus("candidate").map((e) => e.id)).toContain(p.id)
    expect(store.listByStatus("rejected").map((e) => e.id)).toContain(r.id)
    expect(store.listByStatus("candidate").map((e) => e.id)).not.toContain(r.id)
  })

  test("isApproved reflects active status only", () => {
    const store = openUserGlobalStore(base)
    const doc = store.stageCandidate(stratInput())
    expect(store.isApproved(doc.id)).toBe(false)
    store.approve(doc.id)
    expect(store.isApproved(doc.id)).toBe(true)
  })
})
