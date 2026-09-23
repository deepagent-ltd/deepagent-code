import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { contentDigest } from "../../src/contract/digest"
import {
  assertPackagedRuntimeReport,
  makePackagedRuntimeReport,
  PackagedRuntimeReportAuthorityError,
} from "../../src/contract/packaged-runtime-report"
import { makeRuntimeIntegrityEvidence, runtimeIntegrityEvidenceDigest } from "../../src/contract/runtime-integrity-evidence"
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
    expect(() =>
      assertPackagedRuntimeReport({ ...report, runs: [{ ...run, toolIDs: ["z", "a"] }] }),
    ).toThrow(PackagedRuntimeReportAuthorityError)
  })

  test("packaged report generator hashes package files and accepts run descriptors", async () => {
    await using root = await tmpdir()
    const packageDir = join(root.path, "package")
    await mkdir(join(packageDir, "bin"), { recursive: true })
    await Bun.write(join(packageDir, "bin", "deepagent"), "binary")
    const evidence = makeRuntimeIntegrityEvidence({
      sessionID: run.sessionID,
      attemptID: run.attemptID,
      requestHash: contentDigest("request"),
      preparedTurnHash: contentDigest("prepared"),
      promptSources: [],
      toolDefinitions: [],
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
        candidateID: "candidate-1",
        commit: "commit-1",
        tree: "tree-1",
        packageDigest: contentDigest("package"),
        schemaDigest: contentDigest("schema"),
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
          artifactPath: "bin/deepagent",
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
        "candidate-1",
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
    expect(report.artifacts).toHaveLength(1)
    expect(report.artifacts[0]?.path).toBe("bin/deepagent")

    await Bun.write(runsPath, JSON.stringify([{ ...report.runs[0], evidenceDigest: digest("a") }]))
    const mismatch = Bun.spawn(
      [
        process.execPath,
        script.pathname,
        "--candidate",
        "candidate-1",
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
  })
})
