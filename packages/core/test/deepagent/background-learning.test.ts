import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DeepAgentCodeHome } from "../../src/deepagent/workspace"
import { DurableKnowledgeStore } from "../../src/deepagent/durable-knowledge-store"
import { LearningWorker, SkillCurator } from "../../src/deepagent/background-learning"
import { createInitialRoundState } from "../../src/deepagent/round-state"

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
  test("auto-merges safe project memory without blocking the task thread", () => {
    const { projectID, store, worker } = workerFor()
    const result = worker.run({
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

  test("manual review policy sends staged candidates to Memory Inbox", () => {
    const { store, worker } = workerFor()
    const result = worker.run({
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
    expect(inbox[0]).toMatchObject({ schema_version: "deepagent-code.memory_inbox_item.v1", status: "pending", reason: "manual review policy" })
    // docs/34 §8: under manual policy the candidate is a CANDIDATE durable doc (not retrievable
    // until approved), and nothing is active yet.
    expect(store.listByStatus("active")).toHaveLength(0)
    const candidates = store.listByStatus("candidate")
    expect(candidates.length).toBe(1)
    expect(store.documentStore.get(candidates[0]!.id)!.extensions?.knowledge_scope).toBe("project-shared")
  })

  test("strategy and anti-pattern candidates require review instead of auto-merge", () => {
    const { worker } = workerFor()
    const roundState = createInitialRoundState("max")
    roundState.diagnoses.push({ round: 1, root_cause: "missing validation", evidence_refs: ["run:run3"], next_action: "revise" })
    const strategy = worker.run({ projectID: "projA", sessionID: "sess1", runID: "run3", mode: "max", roundState, totalRounds: 2, finalStatus: "completed", trigger: "project_switch" })
    expect(strategy.auto_merged_ids).toEqual([])
    expect(strategy.inbox_ids[0]).toContain("strategy:run3:diagnosis-led-fix")

    const failedState = createInitialRoundState("max")
    failedState.diagnoses.push(
      { round: 1, root_cause: "missing validation", evidence_refs: ["run:run4:r1"], next_action: "revise" },
      { round: 2, root_cause: "missing validation", evidence_refs: ["run:run4:r2"], next_action: "block" },
    )
    const failed = worker.run({ projectID: "projA", sessionID: "sess1", runID: "run4", mode: "max", roundState: failedState, totalRounds: 2, finalStatus: "failed", trigger: "idle" })
    expect(failed.auto_merged_ids).toEqual([])
    expect(failed.inbox_ids[0]).toContain("anti_pattern:run4:repeated-failure")
  })

  test("SkillCurator merges, archives, restores, and rewrites manifest", () => {
    const paths = home.ensureProject("projA")
    const curator = new SkillCurator(paths)
    const first = curator.merge({ id: "skill:test", title: "Run tests", body: "bun test", sourceCandidateIDs: ["memory:run1:first-pass-success"] })
    expect(first.schema_version).toBe("deepagent-code.skill_record.v1")
    expect(curator.list().map((skill) => skill.id)).toEqual(["skill:test"])

    curator.merge({ id: "skill:test-v2", title: "Run focused tests", body: "bun test test/deepagent", sourceCandidateIDs: ["strategy:run3"], supersedes: ["skill:test"] })
    expect(curator.list().map((skill) => skill.id)).toEqual(["skill:test-v2"])

    const restored = curator.restore("skill:test")
    expect(restored).toMatchObject({ id: "skill:test", status: "active", restored_from: "skill:test" })
    const manifest = JSON.parse(readFileSync(path.join(paths.indexesDir, "skill-manifest.json"), "utf8"))
    expect(manifest.schema_version).toBe("deepagent-code.skill_manifest.v1")
    expect(manifest.active_skill_ids.sort()).toEqual(["skill:test", "skill:test-v2"])
  })
})
