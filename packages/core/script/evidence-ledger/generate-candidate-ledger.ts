#!/usr/bin/env bun
/**
 * Candidate release wrapper for RI-24/RI-51.
 *
 * It materializes the source manifest and runtime-state inventory from the current checkout,
 * optionally builds a packaged-runtime report from a package directory, and delegates the final
 * decision to the single authoritative ledger generator. The candidate manifest remains an
 * explicit input because gate statuses and approvals are evidence, not facts this script may
 * infer. Omitting a packaged directory intentionally produces a fail-closed NO-GO ledger.
 */
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { generateManifest, serializeManifest } from "../manifest-digest/manifest"
import { encodeRuntimeStateInventory, runtimeStateInventory } from "../runtime-state-inventory"

const args = process.argv.slice(2)

function option(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function required(name: string): string {
  const value = option(name)
  if (!value) throw new Error(`missing required option ${name}`)
  return value
}

async function run(script: string, scriptArgs: readonly string[]) {
  const child = Bun.spawn([process.execPath, script, ...scriptArgs], {
    cwd: path.resolve(import.meta.dir, "../../../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

const repository = path.resolve(import.meta.dir, "../../../..")
const manifestPath = required("--manifest")
const evidenceDir = required("--evidence-dir")
// 2026-09-10 ruling: release signing descoped — the public key is OPTIONAL verification
// (when provided, signatures are checked and failures reject); unsigned runs stay eligible.
const publicKeyPath = option("--public-key")
const outputPath = option("--out")
const temporary = await mkdtemp(path.join(os.tmpdir(), "deepagent-evidence-ledger-"))

try {
  const sourcePath = path.join(temporary, "source-manifest.json")
  const runtimePath = path.join(temporary, "runtime-inventory.tsv")
  const callerInventoryDirectory = path.join(temporary, "caller-inventory")
  const callerInventory = await run(path.join(repository, "packages/core/script/caller-inventory/run-inventory.ts"), [
    "--out",
    callerInventoryDirectory,
  ])
  if (callerInventory.exitCode !== 0)
    throw new Error(`caller inventory generation failed (${callerInventory.exitCode}): ${callerInventory.stderr}`)
  const callerReport = await Bun.file(path.join(callerInventoryDirectory, "report.json")).text()
  await Bun.write(
    sourcePath,
    `${serializeManifest(
      generateManifest({
        repoRoot: repository,
        extraInputs: {
          "c0-01-inventory-report": {
            "packages/core/.artifacts/caller-inventory/report.json": callerReport,
          },
        },
      }),
    )}\n`,
  )
  await Bun.write(runtimePath, encodeRuntimeStateInventory(await runtimeStateInventory(repository)))

  const packagedDirectory = option("--packaged-dir")
  const runsPath = option("--runs")
  const packagedPath = path.join(temporary, "packaged-runtime-report.json")
  const manifestIdentity = JSON.parse(await Bun.file(manifestPath).text()) as {
    readonly candidateId: string
    readonly commit: string
    readonly tree: string
  }
  if (packagedDirectory && !runsPath) throw new Error("--runs is required with --packaged-dir")
  if (packagedDirectory && runsPath) {
    const report = await run(path.join(import.meta.dir, "generate-packaged-report.ts"), [
      "--candidate",
      manifestIdentity.candidateId,
      "--commit",
      manifestIdentity.commit,
      "--tree",
      manifestIdentity.tree,
      "--package-dir",
      packagedDirectory,
      "--runs",
      runsPath,
      "--out",
      packagedPath,
    ])
    if (report.stderr) process.stderr.write(report.stderr)
    if (report.exitCode !== 0) throw new Error(`packaged report generation failed (${report.exitCode})`)
  }

  const ledgerArgs = [
    "--manifest",
    manifestPath,
    "--source-manifest",
    sourcePath,
    "--runtime-inventory",
    runtimePath,
    "--evidence-dir",
    evidenceDir,
    ...(publicKeyPath ? ["--public-key", publicKeyPath] : []),
    ...(packagedDirectory ? ["--packaged-report", packagedPath] : []),
    ...(outputPath ? ["--out", outputPath] : []),
  ]
  const ledger = await run(path.join(import.meta.dir, "generate-ledger.ts"), ledgerArgs)
  if (ledger.stdout) process.stdout.write(ledger.stdout)
  if (ledger.stderr) process.stderr.write(ledger.stderr)
  process.exitCode = ledger.exitCode
} finally {
  await rm(temporary, { recursive: true, force: true })
}
