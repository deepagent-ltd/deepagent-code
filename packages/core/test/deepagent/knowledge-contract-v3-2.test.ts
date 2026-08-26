import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import {
  openUserGlobalStore,
  projectIdForWorkspace,
  type KnowledgeDocInput,
} from "../../src/deepagent/durable-knowledge-store"
import { seedCoreKnowledge } from "../../src/deepagent/knowledge-seed"
import { retrieve, invalidateCache } from "../../src/deepagent/knowledge-retriever"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"
import { releasedUserGlobalSelection } from "./released-selection-fixture"

// V3.2.1 decision B (docs/34) regression guards for the knowledge-retrieval contract:
//   P1-4 dynamic global cap of selected refs across all types (docs/review_38 §八: 5/8/12 by
//     task complexity; hard ceiling 12), with per-pack quota so primaries are not preempted
//   P0-2 anti_pattern / failure_dossier never injected as positive memory
//   only status=active durable docs are retrievable
const task: TaskContext = {
  userRequest: "optimize the matmul kernel and fix the failing typecheck",
  taskType: "code_modification",
  domain: "code",
  goals: [],
  successCriteria: [],
  riskBoundaries: [],
  validationCommands: [],
}
const tools: ToolContext = { availableTools: [], mcpServers: [], totalToolCount: 0 }

let base: string

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

const seedApproved = (input: KnowledgeDocInput): string => {
  const store = openUserGlobalStore(base)
  const doc = store.stageCandidate(input)
  store.approve(doc.id)
  return doc.id
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-knowledge-contract-"))
  knowledgeSource.configure(base)
  // Seed core strategies/methodologies so total selected can exceed global cap of 5 (P1-4).
  seedCoreKnowledge(openUserGlobalStore(base))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  invalidateCache()
})

describe("docs/34 knowledge retrieval contract", () => {
  test("P1-4: selected refs respect the dynamic global cap (hard ceiling 12) with overflow recorded", () => {
    for (let i = 0; i < 20; i++) {
      seedApproved(memInput(`optimize matmul kernel tip ${i}`, { idSlug: `matmul-${i}` }))
    }
    invalidateCache()
    const result = retrieve({
      mode: "max",
      task,
      tools,
      round: 1,
      previousFailures: 0,
      releasedSelection: releasedUserGlobalSelection(base),
    })
    expect(result).not.toBeNull()
    if (!result) throw new Error("expected retrieval result")
    // dynamic cap: never exceeds the hard ceiling of 12 regardless of task complexity
    expect((result.selectedRefs ?? []).length).toBeLessThanOrEqual(12)
    // per-type top-k still trims the 20-memory pool well below the cap → recorded as topk gaps
    expect((result.gapAnalysis ?? []).some((g) => g.excluded_by === "topk")).toBe(true)
  })

  test("P0-2: failure_dossier (negative knowledge) is never injected as a positive memory", () => {
    seedApproved(memInput("optimize matmul kernel by unrolling everything (this failed)", { type: "failure_dossier" }))
    invalidateCache()
    const result = retrieve({
      mode: "max",
      task,
      tools,
      round: 1,
      previousFailures: 0,
      releasedSelection: releasedUserGlobalSelection(base),
    })
    // failure_dossier is not a knowledge doc type → never in memoryRefs/selectedRefs
    expect(result?.memoryRefs ?? []).toHaveLength(0)
  })

  test("only active docs are retrievable (candidate excluded)", () => {
    const store = openUserGlobalStore(base)
    store.stageCandidate(memInput("optimize matmul kernel pending tip")) // left as candidate
    invalidateCache()
    const result = retrieve({
      mode: "max",
      task,
      tools,
      round: 1,
      previousFailures: 0,
      releasedSelection: releasedUserGlobalSelection(base),
    })
    expect(result?.memoryRefs ?? []).toHaveLength(0)
  })

  // V3.6 P0-2: a fresh install seeds ~3k pre-approved domain-pack docs into the user-global store.
  // The Review queue must hide those (they are built-in, not user-learned) so it does not look like
  // the app arrived with thousands of "already-approved" knowledge entries. Only genuinely learned
  // docs (no pack id) belong in the queue.
  test("P0-2: built-in seeded pack docs are excluded from the review queue", () => {
    // The beforeEach already seeded the full built-in pack set (all carry a pack id / pack: tag).
    // A learned candidate + a learned-then-approved doc are the only things a reviewer should see.
    const store = openUserGlobalStore(base)
    store.stageCandidate(memInput("learned: prefer tiled matmul on this repo", { idSlug: "learned-pending" }))
    const approvedId = seedApproved(memInput("learned: build runs green after bun install", { idSlug: "learned-ok" }))
    invalidateCache()

    const queue = knowledgeSource.listAllForWorkspace(base)
    const ids = queue.map((item) => item.id)

    // exactly the two learned docs, none of the seeded pack docs
    expect(queue.length).toBe(2)
    expect(ids).toContain(approvedId)
    expect(queue.some((item) => item.approval_status === "pending")).toBe(true)
    expect(queue.some((item) => item.approval_status === "approved")).toBe(true)
  })

  test("review decisions use exact store and reject a stale page without writing", () => {
    const workspace = path.join(base, "workspace")
    const candidate = memInput("same bare id in two authorities", { idSlug: "same-review-id" })
    const userGlobalStore = knowledgeSource.userGlobalStoreFor()
    const userGlobal = userGlobalStore.stageCandidate(candidate, { requireExactCandidate: true })
    const projectStore = knowledgeSource.projectStoreFor(workspace)
    const project = projectStore.stageCandidate(
      {
        ...candidate,
        scope: "project-shared",
        projectId: projectIdForWorkspace(workspace),
      },
      { requireExactCandidate: true },
    )
    expect(project.id).toBe(userGlobal.id)

    const listed = knowledgeSource.listAllForWorkspace(workspace)
    expect(listed.filter((item) => item.id === project.id)).toHaveLength(2)
    const projectRef = listed.find((item) => item.sourceStore === "project")!
    const userGlobalRef = listed.find((item) => item.sourceStore === "user_global")!
    const projectVersionBeforeDecision = projectStore.documentStore.get(project.id)!.version
    for (const mismatch of [
      { ...projectRef, hash: "sha256:mismatched" },
      { ...projectRef, candidateId: "different-candidate" },
      { ...projectRef, fingerprint: "sha256:mismatched" },
      { ...projectRef, governanceRevision: "sha256:mismatched" },
    ]) {
      expect(() =>
        knowledgeSource.commitReviewDecisionForWorkspace(workspace, mismatch, "approve", {
          type: "human",
          id: "reviewer",
        }),
      ).toThrow(knowledgeSource.ReviewAuthorityConflictError)
      expect(projectStore.documentStore.get(project.id)!.version).toBe(projectVersionBeforeDecision)
    }
    const updated = knowledgeSource.commitReviewDecisionForWorkspace(workspace, projectRef, "approve", {
      type: "human",
      id: "reviewer",
    })

    expect(updated.approval_status).toBe("approved")
    expect(projectStore.documentStore.get(project.id)?.status).toBe("active")
    expect(userGlobalStore.documentStore.get(userGlobal.id)?.status).toBe("candidate")
    const projectVersion = projectStore.documentStore.get(project.id)!.version
    const userGlobalVersion = userGlobalStore.documentStore.get(userGlobal.id)!.version

    expect(() =>
      knowledgeSource.commitReviewDecisionForWorkspace(workspace, projectRef, "reject", {
        type: "human",
        id: "reviewer",
      }),
    ).toThrow(knowledgeSource.ReviewAuthorityConflictError)
    expect(() =>
      knowledgeSource.commitReviewDecisionForWorkspace(
        workspace,
        { ...userGlobalRef, fingerprint: "sha256:mismatched" },
        "approve",
        { type: "human", id: "reviewer" },
      ),
    ).toThrow(knowledgeSource.ReviewAuthorityConflictError)
    expect(projectStore.documentStore.get(project.id)!.version).toBe(projectVersion)
    expect(userGlobalStore.documentStore.get(userGlobal.id)!.version).toBe(userGlobalVersion)
  })

  test("replays only the exact original human rejection without another document revision", () => {
    const workspace = path.join(base, "rejection-replay-workspace")
    const store = knowledgeSource.projectStoreFor(workspace)
    const staged = store.stageCandidate(
      {
        ...memInput("rejection replay", { idSlug: "rejection-replay" }),
        scope: "project-shared",
        projectId: projectIdForWorkspace(workspace),
      },
      { requireExactCandidate: true },
    )
    const expected = knowledgeSource
      .listAllForWorkspace(workspace)
      .find((item) => item.sourceStore === "project" && item.id === staged.id)!
    const actor = { type: "human" as const, id: "reviewer" }
    const first = knowledgeSource.commitReviewDecisionForWorkspace(workspace, expected, "reject", actor)
    const replay = knowledgeSource.commitReviewDecisionForWorkspace(workspace, expected, "reject", actor)

    expect(replay).toEqual(first)
    expect(store.documentStore.get(staged.id)?.version).toBe(expected.version + 1)
    expect(() =>
      knowledgeSource.commitReviewDecisionForWorkspace(workspace, expected, "reject", {
        type: "human",
        id: "different-reviewer",
      }),
    ).toThrow(knowledgeSource.ReviewAuthorityConflictError)
  })
})
