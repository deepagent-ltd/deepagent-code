import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  assertPackagedRuntimeReport,
  makePackagedRuntimeReport,
  PackagedRuntimeReportAuthorityError,
} from "../../src/contract/packaged-runtime-report"
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
    const runsPath = join(root.path, "runs.json")
    await Bun.write(
      runsPath,
      JSON.stringify([
        {
          ...run,
          artifactPath: "bin/deepagent",
        },
      ]),
    )
    const script = new URL("../../script/evidence-ledger/generate-packaged-report.ts", import.meta.url)
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(script),
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
  })
})
