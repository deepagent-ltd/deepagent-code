import { describe, expect, test } from "bun:test"
import * as Gov from "../../src/deepagent/memory-governance"
import type { LearningCandidate } from "../../src/deepagent/learning"
import type { Doc } from "../../src/deepagent/document-store"

// U6 memory governance routing (S1 §P1). Default fully automatic; only four reasons route to a
// human. These assert the PURE routing + classification; the worker integration (stage/approve/
// inbox) is covered by background-learning.test.ts.

const candidate = (over: Partial<LearningCandidate> = {}): LearningCandidate => ({
  candidate_id: "memory:run:x",
  type: "memory",
  status: "staged",
  source_run_id: "run",
  source_round: 1,
  summary: "Project uses bun as the test runner.",
  evidence_refs: ["run:run"],
  confidence: 0.7,
  ...over,
})

describe("gate 1 — sensitivity detection", () => {
  test("keyword secrets are sensitive", () => {
    expect(Gov.looksSensitive("the api_key is rotated weekly")).toBe(true)
    expect(Gov.looksSensitive("set the password in env")).toBe(true)
  })
  test("literal credential values are sensitive even without keywords", () => {
    expect(Gov.looksSensitive("AKIA1234567890ABCDEF")).toBe(true)
    expect(Gov.looksSensitive("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(true)
    expect(
      Gov.looksSensitive(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36",
      ),
    ).toBe(true)
    expect(Gov.looksSensitive("-----BEGIN RSA PRIVATE KEY-----")).toBe(true)
  })
  test("ordinary project facts are not sensitive", () => {
    expect(Gov.looksSensitive("the build command is bun run build")).toBe(false)
  })
})

describe("gate 2 — classification + blast radius", () => {
  test("memory is low blast radius", () => {
    expect(Gov.classify(candidate({ type: "memory" })).blastRadius).toBe("low")
  })
  test("strategy/methodology/anti_pattern are medium blast radius", () => {
    expect(Gov.classify(candidate({ type: "strategy" })).blastRadius).toBe("medium")
    expect(Gov.classify(candidate({ type: "methodology" })).blastRadius).toBe("medium")
    expect(Gov.classify(candidate({ type: "anti_pattern" })).blastRadius).toBe("medium")
  })
})

describe("confidence floor scales with blast radius (D7 decision)", () => {
  test("low-blast memory auto-admits at 0.6", () => {
    expect(
      Gov.meetsConfidenceFloor(
        candidate({ type: "memory", confidence: 0.6 }),
        Gov.classify(candidate({ type: "memory" })),
      ),
    ).toBe(true)
  })
  test("medium-blast strategy needs 0.8 — 0.7 is below the bar", () => {
    const c = candidate({ type: "strategy", confidence: 0.7 })
    expect(Gov.meetsConfidenceFloor(c, Gov.classify(c))).toBe(false)
    const hi = candidate({ type: "strategy", confidence: 0.85 })
    expect(Gov.meetsConfidenceFloor(hi, Gov.classify(hi))).toBe(true)
  })
})

describe("route — the four human-review triggers, everything else automatic", () => {
  const base = {
    classification: Gov.classify(candidate()),
    inRejectedBuffer: false,
    contradictsHighTrust: false,
    promotesIntoPack: false,
    promotesToGlobal: false,
  }

  test("clean candidate auto-admits", () => {
    expect(Gov.route(base).kind).toBe("auto_admit")
  })
  test("gate 3: rejected-buffer hit drops (never relearn)", () => {
    expect(Gov.route({ ...base, inRejectedBuffer: true })).toEqual({ kind: "drop", reason: "rejected_buffer" })
  })
  test("gate 1: sensitive -> review", () => {
    const sensitive = {
      ...base,
      classification: Gov.classify(candidate({ summary: "token=ghp_abcdefghijklmnopqrstuvwxyz0123" })),
    }
    expect(Gov.route(sensitive)).toEqual({ kind: "review", reason: "sensitive" })
  })
  test("gate 5: high-trust contradiction -> review", () => {
    expect(Gov.route({ ...base, contradictsHighTrust: true })).toEqual({ kind: "review", reason: "contradiction" })
  })
  test("gate 6: pack promotion -> review", () => {
    expect(Gov.route({ ...base, promotesIntoPack: true })).toEqual({ kind: "review", reason: "pack_promotion" })
  })
  test("gate 7: global promotion -> review", () => {
    expect(Gov.route({ ...base, promotesToGlobal: true })).toEqual({ kind: "review", reason: "global_promotion" })
  })
  test("rejected-buffer takes precedence over review reasons", () => {
    expect(Gov.route({ ...base, inRejectedBuffer: true, promotesToGlobal: true }).kind).toBe("drop")
  })
})

describe("isHighTrust", () => {
  const doc = (over: Partial<Doc>): Doc => ({
    id: "d",
    type: "memory",
    scope: "durable:project:p",
    status: "active",
    version: 1,
    superseded_by: null,
    hash: "h",
    created_round: null,
    domain: null,
    tags: [],
    description: "d",
    provenance: { source: "runner" },
    links: [],
    body: "b",
    ...over,
  })
  test("human-authored / global-scope / pack / strong-evidence docs are high trust", () => {
    expect(Gov.isHighTrust(doc({ provenance: { source: "human" } }))).toBe(true)
    expect(Gov.isHighTrust(doc({ scope: "durable" }))).toBe(true)
    expect(Gov.isHighTrust(doc({ extensions: { pack_id: "code.core" } }))).toBe(true)
    expect(Gov.isHighTrust(doc({ confidence: { evidence_strength: "strong", support_count: 3 } }))).toBe(true)
  })
  test("a weak project-scoped runner memory is not high trust", () => {
    expect(Gov.isHighTrust(doc({ confidence: { evidence_strength: "weak", support_count: 1 } }))).toBe(false)
  })
})
