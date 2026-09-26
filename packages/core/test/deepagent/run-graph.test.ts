import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DocumentStore, getGovernanceEnvelope } from "../../src/deepagent/document-store"
import { buildRunGraph, type RunSummary } from "../../src/deepagent/run-graph"
import { explainCandidate } from "../../src/deepagent/reviewer"
import { tmpRoot } from "../fixture/tmpdir"

let root: string
let store: DocumentStore
beforeEach(() => {
  root = mkdtempSync(tmpRoot())
  store = new DocumentStore(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  runId: "run_1",
  taskId: "task_1",
  agentMode: "max",
  status: "completed",
  round: 1,
  nextActionPolicy: "continue_or_complete",
  runContextMarkdown: "# Run Context\nstatus: completed",
  design: { summary: "short design" },
  candidate: { summary: "the candidate solution", status: "generated" },
  decision: { verdict: "accept", reason: "validation passed, metric improved" },
  ...over,
})

describe("V3 run graph as working memory", () => {
  test("materializes a linked graph the reviewer can explain", () => {
    const refs = buildRunGraph(store, summary())
    expect(store.verify().ok).toBe(true)
    const ex = explainCandidate(store, refs.candidateId)
    expect(ex.decision?.verdict).toBe("accept")
    expect(ex.decision?.reason).toContain("validation passed")
    expect(ex.parents.some((p) => p.type === "design")).toBe(true) // candidate derived_from design
  })

  test("failed run links diagnosis into the decision", () => {
    const refs = buildRunGraph(
      store,
      summary({
        status: "runtime_failed",
        diagnosis: {
          summary: "compile error in module X",
          rootCause: "compile_error",
          nextAction: "review_required_before_resume",
        },
        decision: { verdict: "rollback", reason: "compile failed; rolled back to baseline" },
      }),
    )
    const ex = explainCandidate(store, refs.candidateId)
    expect(ex.decision?.verdict).toBe("rollback")
    expect(ex.diagnoses.length).toBe(1)
    expect(ex.diagnoses[0]!.description).toContain("compile_error")
  })

  test("run graph survives reopen (files are the truth)", () => {
    const refs = buildRunGraph(store, summary())
    const reopened = new DocumentStore(root)
    expect(reopened.verify().ok).toBe(true)
    expect(explainCandidate(reopened, refs.candidateId).decision?.verdict).toBe("accept")
  })

  test("re-materializing a run updates the same control-plane docs", () => {
    buildRunGraph(store, summary({ status: "in_progress", runContextMarkdown: "# Run Context\nstatus: in_progress" }))
    const refs = buildRunGraph(
      store,
      summary({ status: "completed", runContextMarkdown: "# Run Context\nstatus: completed" }),
    )
    const contexts = store.list({ type: "run_context", scope: "run:run_1" })
    expect(contexts).toHaveLength(1)
    expect(store.get(refs.runContextId)?.body).toContain("status: completed")
    expect(store.verify().ok).toBe(true)
  })

  test("learning candidate decisions carry governance on the original graph identity", () => {
    buildRunGraph(
      store,
      summary({
        learningCandidates: [
          {
            candidate_id: "learn-staged",
            type: "memory",
            status: "staged",
            source_run_id: "run_1",
            source_round: 1,
            summary: "Preserve durable admission",
            evidence_refs: ["receipt:1"],
            confidence: 0.9,
          },
          {
            candidate_id: "learn-rejected",
            type: "memory",
            status: "rejected",
            source_run_id: "run_1",
            source_round: 1,
            summary: "Skip durable admission",
            evidence_refs: ["receipt:2"],
            confidence: 0.4,
          },
        ],
      }),
    )
    const docs = store.list({ type: "memory", scope: "run:run_1" }).map((ref) => store.get(ref.id)!)
    expect(docs).toHaveLength(2)
    expect(docs.map((doc) => getGovernanceEnvelope(doc)?.review_status).sort()).toEqual(["pending", "rejected"])
    expect(docs.every((doc) => getGovernanceEnvelope(doc)?.source_doc_ref === `${doc.id}@v1`)).toBe(true)
    expect(new DocumentStore(root).verify().ok).toBe(true)
  })
})
