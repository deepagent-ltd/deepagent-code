import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { contentDigest } from "../../src/contract/digest"
import {
  assertPackagedRuntimeReport,
  makePackagedRuntimeReport,
  PackagedRuntimeReportAuthorityError,
} from "../../src/contract/packaged-runtime-report"
import {
  makeRuntimeIntegrityEvidence,
  runtimeIntegrityEvidenceDigest,
} from "../../src/contract/runtime-integrity-evidence"
import { V2ProviderTurn } from "../../src/session/runner/v2-provider-turn"
import { Hash } from "../../src/util/hash"
import { tmpdir } from "../fixture/tmpdir"

const digest = (seed: string) => seed.repeat(64).slice(0, 64)

const run = {
  entrypoint: "deepagent-code/cli",
  artifactPath: "deepagent-code",
  evidenceDigest: digest("a"),
  sessionID: "session-1",
  attemptID: "attempt-1",
  rootCompositionDigest: digest("b"),
  toolIDs: ["file.read", "file.write"],
  physicalCallCount: 1,
  terminalStatus: "settled" as const,
}

describe("RI-24 packaged runtime report", () => {
  test("derives a stable digest and validates run-to-artifact references", () => {
    const report = makePackagedRuntimeReport({
      candidateId: "candidate-1",
      commit: "commit-1",
      tree: "tree-1",
      artifacts: [{ path: "deepagent-code", bytes: 12, sha256: digest("c") }],
      runs: [run],
      issuedAt: "2026-09-09T00:00:00.000Z",
    })
    expect(assertPackagedRuntimeReport(report)).toEqual(report)
    expect(report.reportDigest).toHaveLength(64)
  })

  test("rejects digest, ordering and cross-reference drift", () => {
    const report = makePackagedRuntimeReport({
      candidateId: "candidate-1",
      commit: "commit-1",
      tree: "tree-1",
      artifacts: [{ path: "deepagent-code", bytes: 12, sha256: digest("c") }],
      runs: [run],
    })
    expect(() => assertPackagedRuntimeReport({ ...report, reportDigest: digest("0") })).toThrow(
      PackagedRuntimeReportAuthorityError,
    )
    expect(() => assertPackagedRuntimeReport({ ...report, runs: [{ ...run, artifactPath: "missing" }] })).toThrow(
      PackagedRuntimeReportAuthorityError,
    )
    expect(() => assertPackagedRuntimeReport({ ...report, runs: [{ ...run, toolIDs: ["z", "a"] }] })).toThrow(
      PackagedRuntimeReportAuthorityError,
    )
  })

  test("packaged report generator hashes package files and accepts run descriptors", async () => {
    await using root = await tmpdir()
    const packageDir = join(root.path, "package")
    const build = V2ProviderTurn.buildIdentityFromVersion("2.0.2")
    const candidateId = `candidate:${build.buildID}`
    await mkdir(join(packageDir, "bin"), { recursive: true })
    await Bun.write(join(packageDir, "bin", "deepagent-code"), "binary")
    await Bun.write(
      join(packageDir, "package.json"),
      JSON.stringify({
        version: "2.0.2",
        deepagentCodeBuild: { sourceCommit: "commit-1", binarySha256: Hash.sha256(Buffer.from("binary")) },
      }),
    )
    const evidence = makeRuntimeIntegrityEvidence({
      sessionID: run.sessionID,
      attemptID: run.attemptID,
      requestHash: contentDigest("request"),
      preparedTurnHash: contentDigest("prepared"),
      promptSources: [],
      toolDefinitions: run.toolIDs.map((toolID) => ({ toolID, definitionDigest: contentDigest(toolID) })),
      effectivePermissions: [],
      route: {
        providerID: "provider",
        modelID: "model",
        protocol: "protocol",
        origin: "origin",
        endpointOriginDigest: contentDigest("endpoint"),
        capabilityDigest: contentDigest("capability"),
        loweringVersion: 1,
        protocolRevision: 1,
      },
      receipts: [{ kind: "provider_turn", id: "receipt", digest: contentDigest("receipt") }],
      physicalCallCount: run.physicalCallCount,
      terminal: { status: run.terminalStatus, outcomeDigest: contentDigest("outcome") },
      identity: {
        candidateID: candidateId,
        commit: build.subjectCommit,
        tree: build.subjectTree,
        packageDigest: build.packageDigest,
        schemaDigest: build.schemaDigest,
        rootCompositionDigest: run.rootCompositionDigest,
        databaseSchemaDigest: contentDigest("database"),
        eventSchemaDigest: contentDigest("event"),
        capabilityManifestDigest: contentDigest("capability-manifest"),
      },
      issuedAt: "2026-09-09T00:00:00.000Z",
    })
    const evidenceDir = join(root.path, "evidence")
    await mkdir(evidenceDir)
    await Bun.write(join(evidenceDir, "runtime.json"), JSON.stringify(evidence))
    const runsPath = join(root.path, "runs.json")
    await Bun.write(
      runsPath,
      JSON.stringify([
        {
          ...run,
          artifactPath: "bin/deepagent-code",
          evidenceDigest: runtimeIntegrityEvidenceDigest(evidence),
        },
      ]),
    )
    const script = new URL("../../script/evidence-ledger/generate-packaged-report.ts", import.meta.url)
    const child = Bun.spawn(
      [
        process.execPath,
        script.pathname,
        "--candidate",
        candidateId,
        "--commit",
        "commit-1",
        "--tree",
        "tree-1",
        "--package-dir",
        packageDir,
        "--runs",
        runsPath,
        "--evidence-dir",
        evidenceDir,
      ],
      { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    const report = assertPackagedRuntimeReport(JSON.parse(stdout))
    expect(report.artifacts).toHaveLength(2)
    expect(report.artifacts.some((artifact) => artifact.path === "bin/deepagent-code")).toBe(true)

    await Bun.write(runsPath, JSON.stringify([{ ...report.runs[0], evidenceDigest: digest("a") }]))
    const mismatch = Bun.spawn(
      [
        process.execPath,
        script.pathname,
        "--candidate",
        candidateId,
        "--commit",
        "commit-1",
        "--tree",
        "tree-1",
        "--package-dir",
        packageDir,
        "--runs",
        runsPath,
        "--evidence-dir",
        evidenceDir,
      ],
      { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    )
    const [mismatchStderr, mismatchExitCode] = await Promise.all([
      new Response(mismatch.stderr).text(),
      mismatch.exited,
    ])
    expect(mismatchExitCode).not.toBe(0)
    expect(mismatchStderr).toContain("evidenceDigest does not match evidence artifact")

    await Bun.write(runsPath, JSON.stringify([{ ...report.runs[0], attemptID: "attempt-from-another-run" }]))
    const wrongAttempt = Bun.spawn(
      [
        process.execPath,
        script.pathname,
        "--candidate",
        candidateId,
        "--commit",
        "commit-1",
        "--tree",
        "tree-1",
        "--package-dir",
        packageDir,
        "--runs",
        runsPath,
        "--evidence-dir",
        evidenceDir,
      ],
      { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    )
    const [wrongAttemptStderr, wrongAttemptExitCode] = await Promise.all([
      new Response(wrongAttempt.stderr).text(),
      wrongAttempt.exited,
    ])
    expect(wrongAttemptExitCode).not.toBe(0)
    expect(wrongAttemptStderr).toContain("attemptID does not match runtime evidence")

    await Bun.write(runsPath, JSON.stringify(report.runs))
    await Bun.write(
      join(packageDir, "package.json"),
      JSON.stringify({
        version: "2.0.2",
        deepagentCodeBuild: { sourceCommit: "unrelated-commit", binarySha256: Hash.sha256(Buffer.from("binary")) },
      }),
    )
    const wrongPackage = Bun.spawn(
      [
        process.execPath,
        script.pathname,
        "--candidate",
        candidateId,
        "--commit",
        "commit-1",
        "--tree",
        "tree-1",
        "--package-dir",
        packageDir,
        "--runs",
        runsPath,
        "--evidence-dir",
        evidenceDir,
      ],
      { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    )
    const [wrongPackageStderr, wrongPackageExitCode] = await Promise.all([
      new Response(wrongPackage.stderr).text(),
      wrongPackage.exited,
    ])
    expect(wrongPackageExitCode).not.toBe(0)
    expect(wrongPackageStderr).toContain("sourceCommit does not match candidate Git commit")

    await Bun.write(
      join(packageDir, "package.json"),
      JSON.stringify({
        version: "2.0.2",
        deepagentCodeBuild: { sourceCommit: "commit-1", binarySha256: digest("0") },
      }),
    )
    const wrongBinary = Bun.spawn(
      [
        process.execPath,
        script.pathname,
        "--candidate",
        candidateId,
        "--commit",
        "commit-1",
        "--tree",
        "tree-1",
        "--package-dir",
        packageDir,
        "--runs",
        runsPath,
        "--evidence-dir",
        evidenceDir,
      ],
      { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    )
    const [wrongBinaryStderr, wrongBinaryExitCode] = await Promise.all([
      new Response(wrongBinary.stderr).text(),
      wrongBinary.exited,
    ])
    expect(wrongBinaryExitCode).not.toBe(0)
    expect(wrongBinaryStderr).toContain("binary SHA-256 does not match package metadata")
  })
})
