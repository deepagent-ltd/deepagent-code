import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  assertQualificationEnvironment,
  produceQualificationBundle,
} from "../../script/evidence-ledger/produce-qualification-bundle"
import { verifyQualificationBundle } from "../../script/evidence-ledger/verify-qualification-bundle"
import { Hash } from "../../src/util/hash"
import { tmpdir } from "../fixture/tmpdir"

const commit = "a".repeat(40)
const tree = "b".repeat(40)
const repository = "deepagent-ltd/deepagent-code"
const gates = Array.from({ length: 9 }, (_, index) => `G${index}`)

test("qualification producer records real check bytes while keeping every gate pending", async () => {
  await using root = await tmpdir()
  const checks = join(root.path, "checks.json")
  const out = join(root.path, "bundle")
  await Bun.write(checks, JSON.stringify({ candidateCommit: commit, candidateTree: tree, checks: [{ command: "bun typecheck", exitCode: 0 }] }))
  await produceQualificationBundle({ out, commit, tree, runID: "123", repository, checks })
  await Bun.write(
    join(out, "source-run.json"),
    JSON.stringify({ id: 123, head_sha: commit, conclusion: "success", event: "workflow_dispatch", path: ".github/workflows/release-qualification-v2.yml@release-candidates/v2.0.2", repository: { full_name: repository } }),
  )
  const result = await verifyQualificationBundle({ directory: out, commit, tree, runID: "123", repository })
  expect(Object.values(result.gates).map((entry) => (entry as { status: string }).status)).toEqual(Array(9).fill("pending"))
  expect(result.evidence.map((entry) => entry.path)).toEqual(["evidence/checks.json"])
  await Bun.write(checks, JSON.stringify({ candidateCommit: commit, candidateTree: tree, checks: [{ command: "bun typecheck", exitCode: 1 }] }))
  await expect(produceQualificationBundle({ out: join(root.path, "bad"), commit, tree, runID: "123", repository, checks }))
    .rejects.toThrow("checks are incomplete")
})

test("reviewed decisions require exact candidate, complete evidence and protected reviewers", async () => {
  await using root = await tmpdir()
  const checks = join(root.path, "checks.json")
  const reviewDir = join(root.path, "review")
  const out = join(root.path, "bundle")
  await mkdir(join(reviewDir, "evidence"), { recursive: true })
  await Bun.write(checks, JSON.stringify({ candidateCommit: commit, candidateTree: tree, checks: [{ command: "bun typecheck", exitCode: 0 }] }))
  const evidence = await Promise.all(
    gates.map(async (gate) => {
      const file = `evidence/${gate}.json`
      const bytes = JSON.stringify({ candidateCommit: commit, candidateTree: tree, gate, observation: "reviewed raw result" })
      await Bun.write(join(reviewDir, file), bytes)
      return { path: file, sha256: Hash.sha256(Buffer.from(bytes)) }
    }),
  )
  const review = {
    schemaVersion: "release-qualification-review.v1",
    candidateCommit: commit,
    candidateTree: tree,
    evidence,
    gates: Object.fromEntries(gates.map((gate, index) => [gate, { status: "passed", refs: [`sha256:${evidence[index]!.sha256}`] }])),
  }
  await Bun.write(join(reviewDir, "review.json"), JSON.stringify(review))
  expect(() => assertQualificationEnvironment({ protection_rules: [] })).toThrow("requires reviewers")
  expect(() =>
    assertQualificationEnvironment({
      protection_rules: [{ type: "required_reviewers", prevent_self_review: false, reviewers: [{ type: "User" }] }],
    }),
  ).toThrow("requires reviewers")
  expect(() =>
    assertQualificationEnvironment({
      protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User" }] }],
    }),
  ).not.toThrow()
  await produceQualificationBundle({
    out,
    commit,
    tree,
    runID: "123",
    repository,
    checks,
    reviewDir,
    reviewRef: "refs/heads/release-evidence/v2.0.2",
    reviewCommit: "c".repeat(40),
  })
  await Bun.write(
    join(out, "source-run.json"),
    JSON.stringify({ id: 123, head_sha: commit, conclusion: "success", event: "workflow_dispatch", path: ".github/workflows/release-qualification-v2.yml@release-candidates/v2.0.2", repository: { full_name: repository } }),
  )
  const result = await verifyQualificationBundle({ directory: out, commit, tree, runID: "123", repository })
  expect(Object.values(result.gates).every((entry) => (entry as { status: string }).status === "passed")).toBe(true)
  expect(result.evidence.map((entry) => entry.path)).toEqual(evidence.map((entry) => entry.path.replace("evidence/", "evidence/review/")))
  expect((result.gates.G1 as { refs: string[] }).refs).toEqual(review.gates.G1.refs)
  expect((result.gates.G0 as { refs: string[] }).refs).toHaveLength(2)
  await Bun.write(join(out, "evidence/review/G3.json"), "tampered")
  await expect(verifyQualificationBundle({ directory: out, commit, tree, runID: "123", repository })).rejects.toThrow(
    "evidence digest mismatch",
  )
  await Bun.write(join(reviewDir, "review.json"), JSON.stringify({ ...review, candidateTree: "c".repeat(40) }))
  await expect(produceQualificationBundle({
    out: join(root.path, "bad"),
    commit,
    tree,
    runID: "123",
    repository,
    checks,
    reviewDir,
    reviewRef: "refs/heads/release-evidence/v2.0.2",
    reviewCommit: "c".repeat(40),
  }))
    .rejects.toThrow("review candidate mismatch")
  const wrong = JSON.stringify({ candidateCommit: "d".repeat(40), candidateTree: tree, gate: "G3" })
  await Bun.write(join(reviewDir, "evidence/G3.json"), wrong)
  await Bun.write(join(reviewDir, "review.json"), JSON.stringify({
    ...review,
    evidence: review.evidence.map((entry) =>
      entry.path === "evidence/G3.json" ? { ...entry, sha256: Hash.sha256(Buffer.from(wrong)) } : entry,
    ),
  }))
  await expect(produceQualificationBundle({
    out: join(root.path, "wrong-file"),
    commit,
    tree,
    runID: "123",
    repository,
    checks,
    reviewDir,
    reviewRef: "refs/heads/release-evidence/v2.0.2",
    reviewCommit: "c".repeat(40),
  })).rejects.toThrow("evidence candidate mismatch")
})
