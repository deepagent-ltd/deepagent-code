import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { validate, promote, reject, fingerprint, persistPromoted, RejectedBuffer } from "../../src/deepagent/promotion"
import * as knowledgeSource from "../../src/deepagent/knowledge-source"
import { openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import { retrieve, invalidateCache } from "../../src/deepagent/knowledge-retriever"
import type { LearningCandidate } from "../../src/deepagent/learning"
import type { TaskContext, ToolContext } from "../../src/deepagent/prompt-policy"

let dir: string
let rejected: RejectedBuffer
const NOW = "2026-06-13T00:00:00.000Z"

const cand = (over: Partial<LearningCandidate> = {}): LearningCandidate => ({
  candidate_id: "strategy:run1:diagnosis-led-fix:r2",
  type: "strategy",
  status: "staged",
  source_run_id: "run1",
  source_round: 2,
  summary: "diagnosis identified bank conflict; padding fixed it",
  evidence_refs: ["run:run1"],
  confidence: 0.7,
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "deepagent-promo-"))
  rejected = new RejectedBuffer(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("V3 promotion gate", () => {
  test("validate: replay fail / regress / dedupe", () => {
    const c = cand()
    expect(validate(c, rejected, () => ({ pass: false, metricDelta: 0 })).pass).toBe(false)
    expect(validate(c, rejected, () => ({ pass: true, metricDelta: -0.1 })).pass).toBe(false)
    const ok = validate(c, rejected, () => ({ pass: true, metricDelta: 0.1, evidenceRef: "eval:1" }))
    expect(ok.pass).toBe(true)
    reject(c, rejected, "manual")
    expect(validate(c, rejected, () => ({ pass: true, metricDelta: 0.1 })).pass).toBe(false) // deduped
  })

  test("R2: promotion requires human approval", () => {
    const c = cand()
    const v = validate(c, rejected, () => ({ pass: true, metricDelta: 0.2, evidenceRef: "eval:1" }))
    expect(() => promote(c, "run_local", v, { approver: "x", approved: false }, NOW)).toThrow(/R2/)
    const rec = promote(c, "run_local", v, { approver: "lead", approved: true }, NOW)
    expect(rec.id).not.toBe(c.candidate_id) // R4 new id
    expect(rec.id.startsWith("durable:")).toBe(true)
    expect(rec.evidence_strength).toBe("medium")
    expect(rec.source_candidate_id).toBe(c.candidate_id)
  })

  test("R1: sealed candidate never promotes", () => {
    const c = cand()
    expect(() => promote(c, "sealed", { pass: true, evidence: ["e"] }, { approver: "x", approved: true }, NOW)).toThrow(
      /R1/,
    )
  })

  test("external_trace promotes only through the gate + approval", () => {
    const c = cand({ candidate_id: "strategy:ext:1" })
    const v = validate(c, rejected, () => ({ pass: true, metricDelta: 0.1, evidenceRef: "replay:1" }))
    const rec = promote(c, "external_trace", v, { approver: "lead", approved: true }, NOW)
    expect(rec.evidence_strength).toBe("medium")
  })

  test("fingerprint stable per content", () => {
    expect(fingerprint(cand())).toBe(fingerprint(cand()))
  })

  test("persistPromoted writes durable knowledge the retriever can load (self-learning loop)", () => {
    knowledgeSource.configure(dir)
    const store = openUserGlobalStore(dir)
    const c = cand({
      candidate_id: "strategy:run1:padding-fix",
      summary: "pad shared memory tile to avoid bank conflict",
    })
    const v = validate(c, rejected, () => ({ pass: true, metricDelta: 0.2, evidenceRef: "eval:1" }))
    const rec = promote(c, "run_local", v, { approver: "lead", approved: true }, NOW)
    const docId = persistPromoted(rec, store)
    invalidateCache()

    // durable store now contains the promoted doc as active (retrievable)
    const active = store.listByStatus("active")
    expect(active.some((r) => r.id === docId)).toBe(true)

    // the retriever (max mode) now sees it in its candidate pool (selected or gap)
    const tools: ToolContext = { availableTools: [], mcpServers: [], totalToolCount: 0 }
    const task: TaskContext = {
      userRequest: "fix bank conflict in shared memory tile",
      taskType: "code_modification",
      domain: "code",
      goals: [],
      successCriteria: [],
      riskBoundaries: [],
      validationCommands: [],
    }
    const r = retrieve({ mode: "max", task, tools, round: 1, previousFailures: 2 })
    const seen = [...(r!.strategyRefs ?? []), ...(r!.gapAnalysis ?? []).map((g) => g.ref_id)]
    expect(seen).toContain(docId)
  })
})
