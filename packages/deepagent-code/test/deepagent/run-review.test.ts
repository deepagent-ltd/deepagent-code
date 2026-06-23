import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { buildRunReview, listRunIds } from "../../src/deepagent/run-review"

let runsDir: string
beforeEach(() => { runsDir = mkdtempSync(path.join(tmpdir(), "deepagent-review-")) })
afterEach(() => rmSync(runsDir, { recursive: true, force: true }))

function writeRun(id: string, files: Record<string, unknown | string>) {
  const dir = path.join(runsDir, id)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content))
  }
  return dir
}

describe("A7 reviewer projection", () => {
  test("requires the document graph instead of reconstructing review state from flat artifacts", async () => {
    const dir = writeRun("run_1", {
      "CANDIDATE_LINEAGE.json": { nodes: [{ round: 1, candidate_ref: "cand:a", parent_candidate_ref: null, status: "runtime_failed", decision_ref: "MODEL_ROUTER_AUDIT.json", notes: ["failed"] }] },
      "DEEPAGENT_RUN_STATE.json": { agent_mode: "max", state: "failed" },
      "DIAGNOSIS_RESULT.json": { status: "required", root_cause: "compile_error", next_action: "review_required_before_resume" },
      "RUN_CONTEXT.md": "# Run Context\nstatus: failed",
    })
    const review = await buildRunReview(dir)
    expect(review.runId).toBe("run_1")
    expect(review.agentMode).toBeNull()
    expect(review.status).toBe("document_graph_missing")
    expect(review.candidates).toEqual([])
    expect(review.diagnosis?.rootCause).toBe("document_graph_missing")
    expect(review.nextAction).toBe("rebuild_document_graph_required")
    expect(review.runContext).toBeNull()
  })

  test("projects review and learning candidates from document graph first", async () => {
    const dir = writeRun("run_graph", {})
    const store = new AgentGateway.DeepAgentDocumentStore.DocumentStore(path.join(dir, "graph"))
    AgentGateway.DeepAgentRunGraph.buildRunGraph(store, {
      runId: "run_graph",
      taskId: "task_graph",
      agentMode: "max",
      status: "completed",
      round: 1,
      nextActionPolicy: "continue_or_complete",
      runContextMarkdown: "# graph run context",
      candidate: { summary: "candidate from graph", status: "validated" },
      decision: { verdict: "accept", reason: "validated" },
      learningCandidates: [
        {
          candidate_id: "strategy_candidate:run_graph:strategy:first-fast-design",
          type: "strategy",
          status: "staged",
          source_run_id: "run_graph",
          source_round: 1,
          summary: "use first fast design",
          evidence_refs: ["KNOWLEDGE_RETRIEVAL_RESULT.json", "strategy:first-fast-design"],
          confidence: 0.9,
        },
      ],
    })

    const review = await buildRunReview(dir)
    expect(review.runId).toBe("run_graph")
    expect(review.agentMode).toBe("max")
    expect(review.status).toBe("completed")
    expect(review.runContext).toContain("graph run context")
    expect(review.candidates[0]!.notes).toEqual(["candidate from graph"])
    expect(review.candidates[0]!.status).toBe("validated")
    expect(review.learningCandidates).toEqual([
      expect.objectContaining({
        candidateId: "strategy_candidate:run_graph:strategy:first-fast-design",
        type: "strategy",
        status: "staged",
        summary: "use first fast design",
        confidence: 0.9,
      }),
    ])
  })

  test("marks runs without graph as requiring document graph rebuild", async () => {
    const dir = writeRun("run_partial", { "DEEPAGENT_RUN_STATE.json": { agent_mode: "high", state: "completed" } })
    const review = await buildRunReview(dir)
    expect(review.status).toBe("document_graph_missing")
    expect(review.candidates).toEqual([])
    expect(review.diagnosis?.nextAction).toBe("rebuild_document_graph_required")
    expect(review.runContext).toBeNull()
  })

  test("lists run ids most-recent-first", async () => {
    writeRun("run_a", { "x.json": {} })
    writeRun("run_b", { "x.json": {} })
    const ids = await listRunIds(runsDir)
    expect(ids).toEqual(["run_b", "run_a"])
  })
})
