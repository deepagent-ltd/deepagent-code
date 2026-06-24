import { describe, expect, test } from "bun:test"
import { classifyReview, DEFAULT_CONFIG, type ReviewableDoc } from "../../src/deepagent/auto-reviewer"

// docs/39 §5: auto-review routing. Goal — minimize human review for safe, scoped candidates.
const base: ReviewableDoc = {
  scope: "project-shared",
  memory_kind: "context_memory",
  type: "memory",
  sensitivity: "public",
  approval_risk: "low",
  body: "short body",
  evidence_strength: "strong",
}

describe("auto-reviewer classifyReview (docs/39 §5)", () => {
  test("project-scoped low-risk context memory → auto_approve", () => {
    expect(classifyReview(base).path).toBe("auto_approve")
  })

  test("project_fact with strong evidence → auto_approve", () => {
    expect(classifyReview({ ...base, memory_kind: "project_fact" }).path).toBe("auto_approve")
  })

  test("strategy → human_review regardless of scope", () => {
    expect(classifyReview({ ...base, type: "strategy", memory_kind: "strategy" }).path).toBe("human_review")
  })

  test("methodology → human_review", () => {
    expect(classifyReview({ ...base, type: "methodology", memory_kind: "methodology" }).path).toBe("human_review")
  })

  test("pii sensitivity → human_review", () => {
    expect(classifyReview({ ...base, sensitivity: "pii" }).path).toBe("human_review")
  })

  test("secret sensitivity → human_review", () => {
    expect(classifyReview({ ...base, sensitivity: "secret" }).path).toBe("human_review")
  })

  test("high approval_risk → human_review", () => {
    expect(classifyReview({ ...base, approval_risk: "high" }).path).toBe("human_review")
  })

  test("user-global fact with weak evidence → blank_thread (not auto)", () => {
    const r = classifyReview({ ...base, scope: "user-global", memory_kind: "global_fact", evidence_strength: "weak" })
    expect(r.path).toBe("blank_thread")
  })

  test("global_fact auto-approve only when config opts in", () => {
    const doc: ReviewableDoc = { ...base, scope: "user-global", memory_kind: "global_fact", evidence_strength: "strong" }
    expect(classifyReview(doc).path).toBe("blank_thread")
    expect(classifyReview(doc, { ...DEFAULT_CONFIG, global_fact_auto_approve: true }).path).toBe("auto_approve")
  })

  test("weak evidence project memory falls to blank_thread (not auto)", () => {
    expect(classifyReview({ ...base, evidence_strength: "weak" }).path).toBe("blank_thread")
  })

  test("long body project memory falls to blank_thread (quality guard)", () => {
    expect(classifyReview({ ...base, body: "x".repeat(600) }).path).toBe("blank_thread")
  })

  test("no automated reviewer configured → human_review", () => {
    const r = classifyReview(
      { ...base, evidence_strength: "weak" },
      { ...DEFAULT_CONFIG, project_scoped_low_risk: false, blank_thread_review: false },
    )
    expect(r.path).toBe("human_review")
  })
})
