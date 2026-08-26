import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import { evaluateSnapshot } from "../../src/deepagent/knowledge-gate"
import { retrieve, invalidateCache } from "../../src/deepagent/knowledge-retriever"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"
import { DeepAgentReleasedSnapshot } from "../../src/deepagent/released-snapshot"
import { Hash } from "../../src/util/hash"
import { documentRevision } from "../../src/deepagent/document-store"

// docs/34: the ablation ship gate has TEETH. evaluateSnapshot consumes a REAL measured metric
// matrix. Governance status and model visibility are separate: a released revision remains replayable
// until a later passed snapshot changes the exact manifest.
const task: TaskContext = {
  userRequest: "optimize the matmul kernel",
  taskType: "code_modification",
  domain: "code",
  goals: [],
  successCriteria: [],
  riskBoundaries: [],
  validationCommands: [],
}
const tools: ToolContext = { availableTools: [], mcpServers: [], totalToolCount: 0 }

let base: string
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-shipgate-"))
  knowledgeSource.configure(base)
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  invalidateCache()
})

describe("docs/34 ablation ship gate enforcement", () => {
  test("PASS verdict when MAX does not regress vs HIGH", () => {
    const runner = (group: "general" | "high" | "max") => (group === "max" ? 0.9 : group === "high" ? 0.8 : 0.5)
    const decision = evaluateSnapshot("snap1", ["t1", "t2"], runner, { tolerance: 0 })
    expect(decision.ship).toBe(true)
    expect(decision.offenders).toEqual([])
  })

  test("FAIL verdict names offending tasks when MAX regresses below HIGH", () => {
    const runner = (group: "general" | "high" | "max", task: string) => {
      if (group === "high") return 0.8
      if (group === "max") return task === "t2" ? 0.6 : 0.9
      return 0.5
    }
    const decision = evaluateSnapshot("snap2", ["t1", "t2"], runner, { tolerance: 0 })
    expect(decision.ship).toBe(false)
    expect(decision.offenders).toContain("t2")
  })

  test("teeth: governance demotion preserves the old release until a new manifest removes the ref", () => {
    const store = openUserGlobalStore(base)
    const doc = store.stageCandidate({
      type: "memory",
      description: "optimize matmul kernel by tiling",
      body: "tile it",
      domain: "code",
      tags: ["learned"],
      scope: "user-global",
      sensitivity: "source_code",
      risk: "low",
      confidence: { evidence_strength: "strong", support_count: 1 },
      provenance: { source: "runner", run_ref: "run1", evidence_refs: [] },
    })
    store.approve(doc.id)
    const active = store.documentStore.get(doc.id)!
    const released = selection([DeepAgentReleasedSnapshot.documentRef(active, "user_global")])
    invalidateCache()
    const before = retrieve({ mode: "max", task, tools, round: 1, previousFailures: 0, releasedSelection: released })
    expect((before?.memoryRefs ?? []).includes(doc.id)).toBe(true)

    // Gate FAIL demotes it (what the ship-gate handler does on a blocking verdict).
    store.rejectCandidate(doc.id, documentRevision(active), { type: "system", id: "ship-gate-test" }, "regression")
    invalidateCache()

    const replay = retrieve({ mode: "max", task, tools, round: 1, previousFailures: 0, releasedSelection: released })
    expect((replay?.memoryRefs ?? []).includes(doc.id)).toBe(true)
    const after = retrieve({
      mode: "max",
      task,
      tools,
      round: 1,
      previousFailures: 0,
      releasedSelection: selection([]),
    })
    expect((after?.memoryRefs ?? []).includes(doc.id)).toBe(false)
  })
})

function selection(documents: readonly DeepAgentReleasedSnapshot.DocumentRef[]) {
  return {
    snapshotId: `ship-gate:${documents.length}`,
    securityNamespaceId: "ship-gate-namespace",
    projectScopeKey: "ship-gate-project",
    legacyProjectId: "global",
    parentSnapshotId: null,
    generation: 1,
    membershipHash: DeepAgentReleasedSnapshot.exactRefsFingerprint(documents),
    manifestHash: Hash.sha256(`ship-gate:${documents.length}`),
    documents: DeepAgentReleasedSnapshot.normalizeDocumentRefs(documents),
  }
}
