import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import {
  openUserGlobalStore,
  openProjectStore,
  projectIdForWorkspace,
  type KnowledgeDocInput,
} from "../../src/deepagent/durable-knowledge-store"
import { retrieve, invalidateCache } from "../../src/deepagent/knowledge-retriever"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"
import { DeepAgentReleasedSnapshot } from "../../src/deepagent/released-snapshot"
import { Hash } from "../../src/util/hash"

// V3.2.1 decision B (docs/34 §8): workspace isolation must be ENFORCED on the durable read path.
// The retriever reads the DocumentStore via knowledge-source, which unions user-global with THIS
// workspace's project-shared docs and never reads another workspace's project store.

let base: string
const tools: ToolContext = { availableTools: [], mcpServers: [], totalToolCount: 0 }
const task: TaskContext = {
  userRequest: "optimize the matmul kernel",
  taskType: "code_modification",
  domain: "code",
  goals: [],
  successCriteria: [],
  riskBoundaries: [],
  validationCommands: [],
}

const WORK_A = "/work/repo-a"
const WORK_B = "/work/repo-b"

const memInput = (summary: string, over: Partial<KnowledgeDocInput> = {}): KnowledgeDocInput => ({
  type: "memory",
  description: summary,
  body: summary,
  domain: "code",
  scope: "user-global",
  sensitivity: "public",
  risk: "low",
  confidence: { evidence_strength: "strong", support_count: 3 },
  provenance: { source: "runner", run_ref: "run1", evidence_refs: [] },
  ...over,
})

// Seed an approved memory into the right durable store for the given workspace, return its doc id.
const seedProjectMemory = (workspacePath: string, summary: string, idSlug?: string): string => {
  const store = openProjectStore(base, workspacePath)
  const doc = store.stageCandidate(
    memInput(summary, {
      scope: "project-shared",
      projectId: projectIdForWorkspace(workspacePath),
      ...(idSlug ? { idSlug } : {}),
    }),
  )
  store.approve(doc.id)
  return doc.id
}
const seedGlobalMemory = (summary: string, idSlug?: string): string => {
  const store = openUserGlobalStore(base)
  const doc = store.stageCandidate(memInput(summary, { scope: "user-global", ...(idSlug ? { idSlug } : {}) }))
  store.approve(doc.id)
  return doc.id
}

const memoryRefsFor = (workspacePath?: string): readonly string[] => {
  invalidateCache()
  const userGlobal = openUserGlobalStore(base)
  const project = workspacePath ? openProjectStore(base, workspacePath) : undefined
  const documents = DeepAgentReleasedSnapshot.normalizeDocumentRefs([
    ...userGlobal
      .listByStatus("active")
      .map((doc) => DeepAgentReleasedSnapshot.documentRef(userGlobal.documentStore.get(doc.id)!, "user_global")),
    ...(project
      ? project
          .listByStatus("active")
          .map((doc) => DeepAgentReleasedSnapshot.documentRef(project.documentStore.get(doc.id)!, "project"))
      : []),
  ])
  const r = retrieve({
    mode: "max",
    task,
    tools,
    round: 1,
    previousFailures: 0,
    ...(workspacePath ? { workspacePath } : {}),
    releasedSelection: {
      snapshotId: `workspace-isolation:${workspacePath ?? "global"}`,
      securityNamespaceId: "workspace-isolation-namespace",
      projectScopeKey: `workspace-isolation:${workspacePath ?? "global"}`,
      legacyProjectId: workspacePath ? projectIdForWorkspace(workspacePath) : "global",
      parentSnapshotId: null,
      generation: 1,
      membershipHash: DeepAgentReleasedSnapshot.exactRefsFingerprint(documents),
      manifestHash: Hash.sha256(`workspace-isolation:${workspacePath ?? "global"}:${documents.length}`),
      documents,
    },
  })
  return r?.memoryRefs ?? []
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-ws-iso-"))
  knowledgeSource.configure(base)
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  invalidateCache()
})

describe("docs/34 §8: workspace isolation enforced at durable retrieval", () => {
  test("project-shared memory from another project is NOT retrieved", () => {
    const idA = seedProjectMemory(WORK_A, "matmul kernel tip A")
    const idB = seedProjectMemory(WORK_B, "matmul kernel tip B")

    const seenInA = memoryRefsFor(WORK_A)
    expect(seenInA).toContain(idA)
    expect(seenInA).not.toContain(idB)

    const seenInB = memoryRefsFor(WORK_B)
    expect(seenInB).toContain(idB)
    expect(seenInB).not.toContain(idA)
  })

  test("user-global memory is visible in every workspace", () => {
    const idG = seedGlobalMemory("matmul kernel global tip")
    expect(memoryRefsFor(WORK_A)).toContain(idG)
    expect(memoryRefsFor(WORK_B)).toContain(idG)
  })

  test("user-global memory is visible even with no workspace path", () => {
    const idG = seedGlobalMemory("matmul kernel global tip")
    expect(memoryRefsFor(undefined)).toContain(idG)
  })

  test("preserves user-global and project released refs when their store-local ids collide", () => {
    const globalId = seedGlobalMemory("matmul kernel shared id global tip", "same-memory")
    const projectId = seedProjectMemory(WORK_A, "matmul kernel shared id project tip", "same-memory")
    expect(globalId).toBe(projectId)

    const globalStore = openUserGlobalStore(base)
    const projectStore = openProjectStore(base, WORK_A)
    const globalDoc = globalStore.documentStore.get(globalId)!
    const projectDoc = projectStore.documentStore.get(projectId)!
    const documents = DeepAgentReleasedSnapshot.normalizeDocumentRefs([
      DeepAgentReleasedSnapshot.documentRef(globalDoc, "user_global"),
      DeepAgentReleasedSnapshot.documentRef(projectDoc, "project"),
    ])
    const selection = {
      snapshotId: "collision-selection",
      securityNamespaceId: "collision-namespace",
      projectScopeKey: "collision-project-scope",
      legacyProjectId: projectIdForWorkspace(WORK_A),
      parentSnapshotId: null,
      generation: 1,
      membershipHash: DeepAgentReleasedSnapshot.exactRefsFingerprint(documents),
      manifestHash: Hash.sha256("collision-manifest"),
      documents,
    } as const
    const results = knowledgeSource.queryKnowledge({
      types: ["memory"],
      workspacePath: WORK_A,
      releasedSelection: selection,
      limit: 10,
    })

    expect(results.map((result) => result.documentRef.sourceStore).sort()).toEqual(["project", "user_global"])
    expect(results.map((result) => result.doc.description).sort()).toEqual([
      "matmul kernel shared id global tip",
      "matmul kernel shared id project tip",
    ])
    expect(
      retrieve({
        mode: "max",
        task,
        tools,
        round: 1,
        previousFailures: 0,
        workspacePath: WORK_A,
        releasedSelection: selection,
      })
        ?.selectedDocumentRefs?.map((ref) => ref.sourceStore)
        .sort(),
    ).toEqual(["project", "user_global"])
  })

  test("a candidate (unapproved) memory is never retrieved", () => {
    const store = openUserGlobalStore(base)
    const doc = store.stageCandidate(memInput("matmul kernel pending tip"))
    expect(memoryRefsFor(WORK_A)).not.toContain(doc.id)
  })

  test("projectIdForWorkspace is stable and path-derived", () => {
    const a = projectIdForWorkspace("/work/repo-x")
    expect(a).toBe(projectIdForWorkspace("/work/repo-x"))
    expect(a).not.toBe(projectIdForWorkspace("/work/repo-y"))
    expect(a.startsWith("project_")).toBe(true)
  })
})
