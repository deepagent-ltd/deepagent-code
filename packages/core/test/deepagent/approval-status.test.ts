import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { openUserGlobalStore, type KnowledgeDocInput } from "../../src/deepagent/durable-knowledge-store"
import { retrieve, invalidateCache } from "../../src/deepagent/knowledge-retriever"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"
import { DeepAgentReleasedSnapshot, type Selection } from "../../src/deepagent/released-snapshot"
import { CanonicalJson } from "../../src/util/canonical-json"
import { Hash } from "../../src/util/hash"

// docs/34 §7.3 approval model: accessibility is the DocStatus flag (candidate/active/rejected),
// recorded as immutable revisions by the durable store. Only "active" docs are retrievable;
// candidate/rejected stay out; the decision is reversible without changing the document identity.

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

const retrievedRefIds = (releasedSelection?: Selection): string[] => {
  invalidateCache()
  const result = retrieve({ mode: "max", task, tools, round: 1, previousFailures: 0, releasedSelection })
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

  test("approval is not visibility; a released revision stays replayable across later governance changes", () => {
    const store = openUserGlobalStore(base)
    const doc = store.stageCandidate(stratInput())
    const v1 = doc.version

    store.approve(doc.id)
    expect(retrievedRefIds()).not.toContain(doc.id)
    const released = selection(store.documentStore.get(doc.id)!)
    expect(retrievedRefIds(released)).toContain(doc.id)
    expect(
      retrieve({ mode: "max", task, tools, round: 1, previousFailures: 0, releasedSelection: released })
        ?.selectedDocumentRefs,
    ).toEqual(released.documents)

    store.reject(doc.id)
    expect(retrievedRefIds()).not.toContain(doc.id)
    expect(retrievedRefIds(released)).toContain(doc.id)

    store.approve(doc.id)
    expect(retrievedRefIds()).not.toContain(doc.id)
    expect(retrievedRefIds(selection(store.documentStore.get(doc.id)!))).toContain(doc.id)

    // Governance transitions keep one canonical id and append one revision per distinct decision.
    const after = store.documentStore.get(doc.id)!
    expect(after.id).toBe(doc.id)
    expect(after.version).toBe(v1 + 3)
  })

  test("listByStatus surfaces candidate and rejected for the Review UI", () => {
    const store = openUserGlobalStore(base)
    const p = store.stageCandidate(
      stratInput({ idSlug: "pending-one", description: "pad shared memory to remove bank conflicts" }),
    )
    const r = store.stageCandidate(
      stratInput({ idSlug: "rejected-one", description: "prefetch tiles into registers before the loop" }),
    )
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

function selection(doc: NonNullable<ReturnType<ReturnType<typeof openUserGlobalStore>["documentStore"]["get"]>>) {
  const documents = [DeepAgentReleasedSnapshot.documentRef(doc, "user_global")]
  return {
    snapshotId: `snapshot:${doc.id}:${doc.version}`,
    securityNamespaceId: "namespace-test",
    projectScopeKey: "project-test",
    legacyProjectId: "global",
    parentSnapshotId: null,
    generation: 1,
    membershipHash: Hash.sha256(CanonicalJson.stringify(documents)),
    manifestHash: Hash.sha256(`manifest:${doc.id}:${doc.version}`),
    documents,
  }
}
