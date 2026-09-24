#!/usr/bin/env bun
// Package reviewed G0-G8 decisions without interpreting check output as a passing gate.
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { Hash } from "../../src/util/hash"

const gateIDs = ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"] as const
type Gate = (typeof gateIDs)[number]
type Decision = { status: "passed" | "pending" | "failed" | "stale" | "blocked"; refs: string[] }
const digest = async (file: string) => Hash.sha256(Buffer.from(await Bun.file(file).arrayBuffer()))

export function assertQualificationEnvironment(environment: unknown) {
  if (!environment || typeof environment !== "object" || !("protection_rules" in environment))
    throw new Error("release-qualification environment protection is unavailable")
  const rules = environment.protection_rules
  if (
    !Array.isArray(rules) ||
    !rules.some(
      (rule) =>
        rule &&
        typeof rule === "object" &&
        rule.type === "required_reviewers" &&
        rule.prevent_self_review === true &&
        Array.isArray(rule.reviewers) &&
        rule.reviewers.length > 0,
    )
  )
    throw new Error("release-qualification requires reviewers and prevent_self_review")
}

export async function produceQualificationBundle(input: {
  out: string
  commit: string
  tree: string
  runID: string
  repository: string
  checks: string
  reviewDir?: string
  reviewRef?: string
  reviewCommit?: string
}) {
  if (!/^[0-9a-f]{40}$/.test(input.commit) || !/^[0-9a-f]{40}$/.test(input.tree))
    throw new Error("qualification candidate identity must be full Git SHA-1 values")
  if (!/^\d+$/.test(input.runID) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    throw new Error("qualification run identity is invalid")
  if (input.reviewDir && (!/^refs\/heads\/release-evidence\/[A-Za-z0-9._/-]+$/.test(input.reviewRef ?? "") || !/^[0-9a-f]{40}$/.test(input.reviewCommit ?? "")))
    throw new Error("qualification review requires a pinned branch and commit")
  if (!input.reviewDir && (input.reviewRef || input.reviewCommit))
    throw new Error("qualification review source has no evidence directory")
  await mkdir(input.out, { recursive: true })
  if ((await readdir(input.out)).length) throw new Error("qualification output directory must be empty")
  await mkdir(path.join(input.out, "evidence"), { recursive: true })
  const checks = (await Bun.file(input.checks).json()) as {
    candidateCommit?: string
    candidateTree?: string
    checks?: { command?: string; exitCode?: number }[]
  }
  if (
    checks.candidateCommit !== input.commit ||
    checks.candidateTree !== input.tree ||
    !Array.isArray(checks.checks) ||
    checks.checks.length === 0 ||
    checks.checks.some((check) => !check.command || check.exitCode !== 0)
  )
    throw new Error("qualification checks are incomplete, failed or from another candidate")
  const evidence: { path: string; sha256: string }[] = []
  const gates = Object.fromEntries(gateIDs.map((gate) => [gate, { status: "pending", refs: [] }])) as Record<string, Decision>
  if (!input.reviewDir) {
    await copyFile(input.checks, path.join(input.out, "evidence/checks.json"))
    evidence.push({ path: "evidence/checks.json", sha256: await digest(input.checks) })
    gates.G1.refs.push(`sha256:${evidence[0]!.sha256}`)
  }
  if (input.reviewDir) {
    const reviewFile = path.join(input.reviewDir, "review.json")
    if (!(await lstat(reviewFile)).isFile()) throw new Error("qualification review manifest is not a regular file")
    const review = (await Bun.file(reviewFile).json()) as {
      schemaVersion?: string
      candidateCommit?: string
      candidateTree?: string
      gates?: Record<string, Decision>
      evidence?: { path: string; sha256: string }[]
    }
    if (
      review.schemaVersion !== "release-qualification-review.v1" ||
      review.candidateCommit !== input.commit ||
      review.candidateTree !== input.tree
    )
      throw new Error("qualification review candidate mismatch")
    if (!review.gates || Object.keys(review.gates).toSorted().join() !== [...gateIDs].toSorted().join())
      throw new Error("qualification review must decide exactly G0-G8")
    if (!Array.isArray(review.evidence) || review.evidence.length === 0)
      throw new Error("qualification review evidence is empty")
    const names = review.evidence.map((entry) => entry.path)
    if (
      new Set(names).size !== names.length ||
      names.some(
        (name) =>
          !/^evidence\/[A-Za-z0-9._/-]+$/.test(name) ||
          name.split("/").some((part) => !part || part === "." || part === ".."),
      )
    )
      throw new Error("qualification review evidence path is unsafe or duplicated")
    const actual = await readdir(path.join(input.reviewDir, "evidence"), { recursive: true, withFileTypes: true })
    if (actual.some((entry) => entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())))
      throw new Error("qualification review evidence has a non-regular entry")
    const present = actual
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path
          .join("evidence", entry.parentPath.slice(path.join(input.reviewDir!, "evidence").length), entry.name)
          .replaceAll(path.sep, "/"),
      )
      .toSorted()
    if (present.join("\n") !== names.toSorted().join("\n"))
      throw new Error("qualification review evidence inventory is incomplete")
    for (const entry of review.evidence) {
      if (!/^[0-9a-f]{64}$/.test(entry.sha256) || (await digest(path.join(input.reviewDir, entry.path))) !== entry.sha256)
        throw new Error(`qualification review evidence digest mismatch: ${entry.path}`)
      const observed = (await Bun.file(path.join(input.reviewDir, entry.path)).json()) as {
        candidateCommit?: string
        candidateTree?: string
      }
      if (observed.candidateCommit !== input.commit || observed.candidateTree !== input.tree)
        throw new Error(`qualification review evidence candidate mismatch: ${entry.path}`)
      const target = path.join(input.out, "evidence/review", entry.path.slice("evidence/".length))
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(path.join(input.reviewDir, entry.path), target)
      evidence.push({ path: path.relative(input.out, target).replaceAll(path.sep, "/"), sha256: entry.sha256 })
    }
    const reviewedRefs = review.evidence.map((entry) => `sha256:${entry.sha256}`)
    for (const gate of gateIDs) {
      const decision = review.gates[gate]
      if (
        !decision ||
        !["passed", "pending", "failed", "stale", "blocked"].includes(decision.status) ||
        !Array.isArray(decision.refs) ||
        decision.refs.some((ref) => typeof ref !== "string" || !reviewedRefs.includes(ref)) ||
        (decision.status === "passed" && !decision.refs.length)
      )
        throw new Error(`qualification review ${gate} lacks bound gate evidence`)
      gates[gate] = { status: decision.status, refs: [...decision.refs, ...gates[gate].refs] }
    }
    if (reviewedRefs.some((ref) => !gateIDs.some((gate) => gates[gate].refs.includes(ref))))
      throw new Error("qualification review has unbound evidence")
  }

  const qualification = {
    schemaVersion: "release-qualification.v1",
    sourceRunID: input.runID,
    sourceRepository: input.repository,
    candidateCommit: input.commit,
    candidateTree: input.tree,
    ...(input.reviewDir
      ? {
          reviewSource: {
            ref: input.reviewRef,
            commit: input.reviewCommit,
            manifestSha256: await digest(path.join(input.reviewDir, "review.json")),
          },
        }
      : {}),
    evidence,
  }
  const bytes = `${JSON.stringify(qualification, null, 2)}\n`
  await Bun.write(path.join(input.out, "qualification.json"), bytes)
  gates.G0.refs.push(`sha256:${Hash.sha256(Buffer.from(bytes))}`)
  await Bun.write(path.join(input.out, "gates.json"), `${JSON.stringify(gates, null, 2)}\n`)
  return gates
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined)
  const environment = option("--assert-environment")
  if (environment) {
    assertQualificationEnvironment(await Bun.file(environment).json())
    process.exit(0)
  }
  const out = option("--out")
  const commit = option("--commit")
  const tree = option("--tree")
  const runID = option("--run-id")
  const repository = option("--repo")
  const checks = option("--checks")
  if (!out || !commit || !tree || !runID || !repository || !checks)
    throw new Error("usage: produce-qualification-bundle.ts --out DIR --commit SHA --tree SHA --run-id ID --repo OWNER/REPO --checks FILE [--review-dir DIR]")
  await produceQualificationBundle({
    out,
    commit,
    tree,
    runID,
    repository,
    checks,
    reviewDir: option("--review-dir"),
    reviewRef: option("--review-ref"),
    reviewCommit: option("--review-commit"),
  })
}
