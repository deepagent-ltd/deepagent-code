import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { verifyQualificationBundle } from "../../script/evidence-ledger/verify-qualification-bundle"
import { Hash } from "../../src/util/hash"
import { tmpdir } from "../fixture/tmpdir"

test("external G0-G8 decisions bind candidate, source run and exact evidence bytes", async () => {
  await using root = await tmpdir()
  const repository = join(import.meta.dir, "../../../..")
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repository }).stdout.toString().trim()
  const tree = Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], { cwd: repository }).stdout.toString().trim()
  await mkdir(join(root.path, "evidence"))
  const evidence = await Promise.all(
    Array.from({ length: 9 }, async (_, index) => {
      const file = `evidence/G${index}.json`
      const bytes = JSON.stringify({ gate: `G${index}`, observed: true })
      await Bun.write(join(root.path, file), bytes)
      return { path: file, sha256: Hash.sha256(Buffer.from(bytes)) }
    }),
  )
  const metadata = {
    schemaVersion: "release-qualification.v1",
    sourceRunID: "123",
    sourceRepository: "deepagent-ltd/deepagent-code",
    candidateCommit: commit,
    candidateTree: tree,
    evidence,
  }
  const qualificationBytes = JSON.stringify(metadata)
  await Bun.write(join(root.path, "qualification.json"), qualificationBytes)
  await Bun.write(
    join(root.path, "source-run.json"),
    JSON.stringify({
      id: 123,
      head_sha: commit,
      conclusion: "success",
      event: "workflow_dispatch",
      path: ".github/workflows/release-qualification-v2.yml@release-candidates/v2.0.2",
      repository: { full_name: "deepagent-ltd/deepagent-code" },
    }),
  )
  const gates = Object.fromEntries(
    evidence.map((entry, index) => [
      `G${index}`,
      {
        status: "passed",
        refs: [
          ...(index === 0 ? [`sha256:${Hash.sha256(Buffer.from(qualificationBytes))}`] : []),
          `sha256:${entry.sha256}`,
        ],
      },
    ]),
  )
  await Bun.write(join(root.path, "gates.json"), JSON.stringify(gates))
  const input = { directory: root.path, commit, tree, runID: "123", repository: "deepagent-ltd/deepagent-code" }
  expect((await verifyQualificationBundle(input)).sourceRunID).toBe("123")
  await Bun.write(
    join(root.path, "source-run.json"),
    JSON.stringify({
      id: 123,
      head_sha: commit,
      conclusion: "success",
      event: "workflow_dispatch",
      path: ".github/workflows/other.yml@release-candidates/v2.0.2",
      repository: { full_name: "deepagent-ltd/deepagent-code" },
    }),
  )
  await expect(verifyQualificationBundle(input)).rejects.toThrow("producer run")
  await Bun.write(
    join(root.path, "source-run.json"),
    JSON.stringify({
      id: 123,
      head_sha: commit,
      conclusion: "success",
      event: "workflow_dispatch",
      path: ".github/workflows/release-qualification-v2.yml@release-candidates/v2.0.2",
      repository: { full_name: "deepagent-ltd/deepagent-code" },
    }),
  )
  await expect(verifyQualificationBundle({ ...input, tree: "other" })).rejects.toThrow("candidate")
  await expect(verifyQualificationBundle({ ...input, runID: "124" })).rejects.toThrow("input run ID")
  await Bun.write(join(root.path, evidence[3]!.path), "tampered")
  await expect(verifyQualificationBundle(input)).rejects.toThrow("evidence digest mismatch")
  await Bun.write(join(root.path, evidence[3]!.path), JSON.stringify({ gate: "G3", observed: true }))
  await Bun.write(join(root.path, "gates.json"), JSON.stringify({ ...gates, G0: { status: "passed", refs: [] } }))
  await expect(verifyQualificationBundle(input)).rejects.toThrow("passed without refs")
  await Bun.write(join(root.path, "gates.json"), JSON.stringify(gates))

  const out = join(root.path, "ledger.json")
  const gate = new URL("../../script/evidence-ledger/release-gate.ts", import.meta.url)
  const child = Bun.spawn(
    [
      process.execPath,
      gate.pathname,
      "--qualification-dir",
      root.path,
      "--qualification-run-id",
      "123",
      "--qualification-repo",
      "deepagent-ltd/deepagent-code",
      "--out",
      out,
    ],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect(exitCode).not.toBe(0)
  expect(stderr).toContain("packaged_report_missing")
  const archived = join(root.path, "release-evidence-products/qualification/evidence/G2.json")
  expect(await Bun.file(archived).exists()).toBe(true)
  await Bun.write(archived, "tampered")
  const verifier = new URL("../../script/evidence-ledger/verify-ledger-products.ts", import.meta.url)
  const verify = Bun.spawn(
    [
      process.execPath,
      verifier.pathname,
      "--ledger",
      out,
      "--artifact-dir",
      join(root.path, "release-evidence-products"),
    ],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  expect(await verify.exited).not.toBe(0)
  expect(await new Response(verify.stderr).text()).toContain("qualification evidence digest mismatch")
  await Bun.write(archived, JSON.stringify({ gate: "G2", observed: true }))
  const archivedRun = join(root.path, "release-evidence-products/qualification/source-run.json")
  await Bun.write(archivedRun, `${await Bun.file(archivedRun).text()}\n`)
  const verifyRun = Bun.spawn(
    [
      process.execPath,
      verifier.pathname,
      "--ledger",
      out,
      "--artifact-dir",
      join(root.path, "release-evidence-products"),
    ],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  expect(await verifyRun.exited).not.toBe(0)
  expect(await new Response(verifyRun.stderr).text()).toContain(
    "qualification/source-run.json bytes do not match ledger",
  )
}, 30_000)
