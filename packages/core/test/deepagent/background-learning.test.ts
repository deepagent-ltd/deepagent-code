import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DeepAgentCodeHome } from "../../src/deepagent/workspace"
import { DurableKnowledgeStore } from "../../src/deepagent/durable-knowledge-store"
import { LearningWorker, SkillCurator } from "../../src/deepagent/background-learning"
import { createInitialRoundState } from "../../src/deepagent/round-state"
import { RejectedBuffer, fingerprint } from "../../src/deepagent/promotion"
import * as Learning from "../../src/deepagent/learning"

let root: string
let home: DeepAgentCodeHome

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-code-learning-"))
  home = new DeepAgentCodeHome(root)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const workerFor = (projectID = "projA") => {
  const paths = home.ensureProject(projectID)
  // docs/34 §8: durable knowledge is the single DocumentStore body at <project>/knowledge.
  const store = new DurableKnowledgeStore(path.join(paths.root, "knowledge"))
  return { paths, projectID, store, worker: new LearningWorker(paths, projectID, store) }
}

describe("V3.1 LearningWorker and SkillCurator", () => {
  test("auto-merges safe project memory without blocking the task thread", async () => {
    const { projectID, store, worker } = workerFor()
    const result = await worker.run({
      projectID: "projA",
      sessionID: "sess1",
      runID: "run1",
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
      trigger: "idle",
    })

    expect(result.trigger).toBe("idle")
    expect(result.candidate_count).toBe(1)
    expect(result.auto_merged_ids).toEqual(["memory:run1:first-pass-success"])
    expect(result.inbox_ids).toEqual([])
    expect(result.enqueue_ms).toBeGreaterThanOrEqual(0)

    // docs/34 §8: the auto-merged candidate is an ACTIVE durable doc, project-shared + tagged.
    const active = store.listByStatus("active")
    expect(active.length).toBe(1)
    const doc = store.documentStore.get(active[0]!.id)!
    expect(doc.description).toContain("Task completed in first round")
    expect(doc.scope).toBe(`durable:project:${projectID}`)
    expect(doc.extensions?.knowledge_scope).toBe("project-shared")
  })

  test("gate 3 (R3): a candidate whose fingerprint is in the RejectedBuffer is dropped, not re-learned", async () => {
    // Regression for the vacuous-gate seam bug: gate 3 fed `status === "rejected"`, but extraction always
    // emits "staged", so the durable RejectedBuffer (what the human `reject` action writes) was never
    // consulted — a rejected pattern would be re-extracted and AUTO-ADMITTED on the next run. The worker
    // now consults an injected RejectedBuffer by fingerprint.
    const runInput = {
      projectID: "projA",
      sessionID: "sess1",
      runID: "run1",
      mode: "high" as const,
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed" as const,
      trigger: "idle" as const,
    }
    // Pre-reject the exact candidate this run extracts (same fingerprint the human `reject` route stores).
    // extract() takes `runId` (the worker maps input.runID → runId internally).
    const extracted = Learning.extract({
      runId: runInput.runID,
      mode: runInput.mode,
      roundState: runInput.roundState,
      totalRounds: runInput.totalRounds,
      finalStatus: runInput.finalStatus,
    })
    expect(extracted.candidates.length).toBe(1)
    const paths = home.ensureProject("projA")
    const store = new DurableKnowledgeStore(path.join(paths.root, "knowledge"))
    const rejected = new RejectedBuffer(path.join(paths.root, "memory"))
    rejected.add(fingerprint(extracted.candidates[0]!), "human rejected this pattern")
    const worker = new LearningWorker(paths, "projA", store, rejected)

    const result = await worker.run(runInput)
    // The candidate is dropped by gate 3 — NOT auto-merged, NOT staged into the durable store.
    expect(result.auto_merged_ids).toEqual([])
    expect(result.inbox_ids).toEqual([])
    expect(store.listByStatus("active").length).toBe(0)
    expect(store.listByStatus("candidate").length).toBe(0)

    // Control: WITHOUT the buffer the same candidate auto-merges (proving the buffer is what dropped it).
    const store2 = new DurableKnowledgeStore(path.join(home.ensureProject("projB").root, "knowledge"))
    const worker2 = new LearningWorker(home.ensureProject("projB"), "projB", store2)
    const result2 = await worker2.run({ ...runInput, projectID: "projB" })
    expect(result2.auto_merged_ids.length).toBe(1)
  })

  test("manual review policy sends staged candidates to Memory Inbox", async () => {
    const { paths, store, worker } = workerFor()
    const result = await worker.run({
      projectID: "projA",
      sessionID: "sess1",
      runID: "run2",
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
      trigger: "pause",
      policy: "manual_review",
    })

    expect(result.auto_merged_ids).toEqual([])
    expect(result.inbox_ids).toEqual(["inbox:memory:run2:first-pass-success"])
    const inbox = worker.listInbox()
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      schema_version: "deepagent-code.memory_inbox_item.v1",
      status: "pending",
      reason: "manual review policy",
    })
    // docs/34 §8: under manual policy the candidate is a CANDIDATE durable doc (not retrievable
    // until approved), and nothing is active yet.
    expect(store.listByStatus("active")).toHaveLength(0)
    const candidates = store.listByStatus("candidate")
    expect(candidates.length).toBe(1)
    expect(store.documentStore.get(candidates[0]!.id)!.extensions?.knowledge_scope).toBe("project-shared")
    expect(readdirSync(path.join(paths.docsDir, "memory-inbox"))).toEqual([
      "inbox__memory__run2__first-pass-success.json",
    ])
  })

  test("strategy and anti-pattern candidates require review instead of auto-merge", async () => {
    const { worker } = workerFor()
    const roundState = createInitialRoundState("max")
    roundState.diagnoses.push({
      round: 1,
      root_cause: "missing validation",
      evidence_refs: ["run:run3"],
      next_action: "revise",
    })
    const strategy = await worker.run({
      projectID: "projA",
      sessionID: "sess1",
      runID: "run3",
      mode: "max",
      roundState,
      totalRounds: 2,
      finalStatus: "completed",
      trigger: "project_switch",
    })
    expect(strategy.auto_merged_ids).toEqual([])
    expect(strategy.inbox_ids[0]).toContain("strategy:run3:diagnosis-led-fix")

    const failedState = createInitialRoundState("max")
    failedState.diagnoses.push(
      { round: 1, root_cause: "missing validation", evidence_refs: ["run:run4:r1"], next_action: "revise" },
      { round: 2, root_cause: "missing validation", evidence_refs: ["run:run4:r2"], next_action: "block" },
    )
    const failed = await worker.run({
      projectID: "projA",
      sessionID: "sess1",
      runID: "run4",
      mode: "max",
      roundState: failedState,
      totalRounds: 2,
      finalStatus: "failed",
      trigger: "idle",
    })
    expect(failed.auto_merged_ids).toEqual([])
    expect(failed.inbox_ids[0]).toContain("anti_pattern:run4:repeated-failure")
  })

  test("reviewer failure admits only candidates that do not require review", async () => {
    const safe = workerFor("safe")
    const safeResult = await safe.worker.run({
      projectID: safe.projectID,
      sessionID: "sess-safe",
      runID: "run-safe",
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
      trigger: "idle",
      reviewer: async () => {
        throw new Error("reviewer unavailable")
      },
    })
    expect(safeResult.auto_merged_ids).toEqual(["memory:run-safe:first-pass-success"])
    expect(safe.store.listByStatus("active")).toHaveLength(1)

    const sensitive = workerFor("sensitive")
    const roundState = createInitialRoundState("max")
    roundState.diagnoses.push({
      round: 1,
      root_cause: "api_key leaked into the generated configuration",
      evidence_refs: ["run:run-sensitive:r1"],
      next_action: "revise",
    })
    const sensitiveResult = await sensitive.worker.run({
      projectID: sensitive.projectID,
      sessionID: "sess-sensitive",
      runID: "run-sensitive",
      mode: "max",
      roundState,
      totalRounds: 2,
      finalStatus: "completed",
      trigger: "session_finalization",
      reviewer: async () => {
        throw new Error("reviewer unavailable")
      },
    })
    expect(sensitiveResult.candidate_count).toBe(1)
    expect(sensitiveResult.auto_merged_ids).toEqual([])
    expect(sensitiveResult.inbox_ids).toEqual(["inbox:strategy:run-sensitive:diagnosis-led-fix:r1"])
    expect(sensitive.store.listByStatus("active")).toHaveLength(0)
    expect(sensitive.store.listByStatus("candidate")).toHaveLength(1)
    expect(sensitive.worker.listInbox()[0]?.reason).toBe("reviewer unavailable: sensitive")

    const manual = workerFor("manual-unavailable")
    const manualResult = await manual.worker.run({
      projectID: manual.projectID,
      sessionID: "sess-manual",
      runID: "run-manual",
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
      trigger: "pause",
      policy: "manual_review",
      reviewer: async () => {
        throw new Error("reviewer unavailable")
      },
    })
    expect(manualResult.auto_merged_ids).toEqual([])
    expect(manual.store.listByStatus("candidate")).toHaveLength(1)
    expect(manual.worker.listInbox()[0]?.reason).toBe("reviewer unavailable under manual review policy")
  })

  test("reviewer may select an exact subset but cannot rewrite or duplicate candidates", async () => {
    const rewritten = workerFor("rewritten")
    const rewrittenState = createInitialRoundState("max")
    rewrittenState.diagnoses.push({
      round: 1,
      root_cause: "api_key leaked into the generated configuration",
      evidence_refs: ["run:run-rewritten:r1"],
      next_action: "revise",
    })
    const rewrittenResult = await rewritten.worker.run({
      projectID: rewritten.projectID,
      sessionID: "sess-rewritten",
      runID: "run-rewritten",
      mode: "max",
      roundState: rewrittenState,
      totalRounds: 2,
      finalStatus: "completed",
      trigger: "session_finalization",
      reviewer: async (candidates) =>
        candidates.map((candidate) => ({
          ...candidate,
          summary: "Harmless configuration detail",
          confidence: 1,
        })),
    })
    expect(rewrittenResult.auto_merged_ids).toEqual([])
    expect(rewritten.store.listByStatus("active")).toHaveLength(0)
    expect(rewritten.store.listByStatus("candidate")).toHaveLength(1)
    expect(rewritten.worker.listInbox()[0]?.reason).toBe("reviewer unavailable: sensitive")

    const duplicated = workerFor("duplicated")
    const duplicatedResult = await duplicated.worker.run({
      projectID: duplicated.projectID,
      sessionID: "sess-duplicated",
      runID: "run-duplicated",
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
      trigger: "idle",
      reviewer: async (candidates) => [candidates[0]!, candidates[0]!],
    })
    expect(duplicatedResult.auto_merged_ids).toEqual(["memory:run-duplicated:first-pass-success"])
    expect(duplicated.store.listByStatus("active")).toHaveLength(1)
  })

  test("manual review cannot reinforce an existing active document before approval", async () => {
    const guarded = workerFor("manual-existing-active")
    await guarded.worker.run({
      projectID: guarded.projectID,
      sessionID: "sess-auto",
      runID: "run-auto",
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
      trigger: "session_finalization",
    })
    const before = guarded.store.documentStore.get(guarded.store.listByStatus("active")[0]!.id)!

    const reviewed = await guarded.worker.run({
      projectID: guarded.projectID,
      sessionID: "sess-manual",
      runID: "run-manual",
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
      trigger: "session_finalization",
      policy: "manual_review",
      reviewer: async () => {
        throw new Error("reviewer unavailable")
      },
    })
    const after = guarded.store.documentStore.get(before.id)!

    expect(reviewed.auto_merged_ids).toEqual([])
    expect(reviewed.inbox_ids).toHaveLength(1)
    expect(guarded.store.listByStatus("candidate")).toHaveLength(1)
    expect({ version: after.version, hash: after.hash }).toEqual({ version: before.version, hash: before.hash })
  })

  test("durable governance plans a near-duplicate as an isolated review proposal", async () => {
    const guarded = workerFor("durable-near-duplicate")
    await guarded.worker.run({
      projectID: guarded.projectID,
      sessionID: "sess-active",
      runID: "run-active",
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
      trigger: "session_finalization",
    })
    const before = guarded.store.documentStore.get(guarded.store.listByStatus("active")[0]!.id)!
    const candidate = Learning.extract({
      runId: "run-proposal",
      mode: "high",
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed",
    }).candidates[0]!

    const plan = guarded.worker.planDurableGovernance(
      {
        projectID: guarded.projectID,
        sessionID: "sess-proposal",
        runID: "run-proposal",
        mode: "high",
        roundState: createInitialRoundState("high"),
        totalRounds: 1,
        finalStatus: "completed",
        trigger: "session_finalization",
        policy: "auto_merge_safe_project",
      },
      [candidate],
      true,
    )

    expect(plan).toMatchObject([
      {
        action: "manual_review",
        candidate: { candidate_id: "memory:run-proposal:first-pass-success" },
        document: { idSlug: "memory:run-proposal:first-pass-success" },
        inbox: { id: "inbox:memory:run-proposal:first-pass-success", status: "pending" },
      },
    ])
    expect(guarded.store.documentStore.get(before.id)).toEqual(before)
  })

  test("SkillCurator merges, archives, restores, and rewrites manifest", () => {
    const paths = home.ensureProject("projA")
    const curator = new SkillCurator(paths)
    const first = curator.merge({
      id: "skill:test",
      title: "Run tests",
      body: "bun test",
      sourceCandidateIDs: ["memory:run1:first-pass-success"],
    })
    expect(first.schema_version).toBe("deepagent-code.skill_record.v1")
    expect(curator.list().map((skill) => skill.id)).toEqual(["skill:test"])

    curator.merge({
      id: "skill:test-v2",
      title: "Run focused tests",
      body: "bun test test/deepagent",
      sourceCandidateIDs: ["strategy:run3"],
      supersedes: ["skill:test"],
    })
    expect(curator.list().map((skill) => skill.id)).toEqual(["skill:test-v2"])

    const restored = curator.restore("skill:test")
    expect(restored).toMatchObject({ id: "skill:test", status: "active", restored_from: "skill:test" })
    const manifest = JSON.parse(readFileSync(path.join(paths.indexesDir, "skill-manifest.json"), "utf8"))
    expect(manifest.schema_version).toBe("deepagent-code.skill_manifest.v1")
    expect(manifest.active_skill_ids.sort()).toEqual(["skill:test", "skill:test-v2"])
  })
})
