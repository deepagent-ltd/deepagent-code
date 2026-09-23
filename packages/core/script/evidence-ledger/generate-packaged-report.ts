#!/usr/bin/env bun
/**
 * Build the packaged-runtime report consumed by RI-24/RI-51.
 *
 *   bun run script/evidence-ledger/generate-packaged-report.ts \
 *     --candidate <id> --commit <sha> --tree <sha> \
 *     --package-dir <unpacked-or-extracted-package> --runs <runs.json> \
 *     --evidence-dir <runtime-evidence-dir> \
 *     [--out <packaged-report.json>]
 *
 * `runs.json` is an array of PackagedRuntimeRun records. The package directory is walked in
 * lexical order and every file is content-addressed; no directory mtime or absolute path enters
 * the report. A report with no run is valid as a diagnostic artifact but cannot satisfy the
 * evidence ledger because the ledger still requires signed evidence bundles.
 */
import { readdirSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { PackagedRuntimeReportContract } from "../../src/contract/packaged-runtime-report"
import { Hash } from "../../src/util/hash"
import { evidenceFiles, readEvidenceArtifact } from "./read-evidence"

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

function files(directory: string, root = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return files(filename, root)
    if (!entry.isFile()) return []
    return [path.relative(root, filename).replaceAll(path.sep, "/")]
  }).sort()
}

const packageDir = required("--package-dir")
const runsPath = required("--runs")
const runs = Schema.decodeUnknownSync(Schema.Array(PackagedRuntimeReportContract.PackagedRuntimeRun), {
  onExcessProperty: "error",
})(await Bun.file(runsPath).json())
const candidateId = required("--candidate")
const evidence = await Promise.all(evidenceFiles(required("--evidence-dir")).map((filename) => readEvidenceArtifact(filename, undefined)))
if (evidence.some((artifact) => artifact.candidateID !== candidateId))
  throw new Error("evidence artifact candidate does not match packaged report candidate")
const evidenceHashes = new Set(evidence.map((artifact) => artifact.evidenceHash))
if (evidenceHashes.size !== evidence.length) throw new Error("duplicate runtime evidence digest")
for (const run of runs) {
  if (!evidenceHashes.has(run.evidenceDigest))
    throw new Error(`packaged run evidenceDigest does not match evidence artifact: ${run.evidenceDigest}`)
}
if (runs.length !== evidence.length) throw new Error("runtime evidence artifact is not referenced by packaged run")
const artifacts = await Promise.all(
  files(packageDir).map(async (relativePath) => {
    const bytes = await Bun.file(path.join(packageDir, relativePath)).bytes()
    return {
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: Hash.sha256(Buffer.from(bytes)),
    }
  }),
)
const report = PackagedRuntimeReportContract.makePackagedRuntimeReport({
  candidateId,
  commit: required("--commit"),
  tree: required("--tree"),
  artifacts,
  runs,
})
const body = `${JSON.stringify(report, null, 2)}\n`
const out = option("--out")
if (out) await Bun.write(out, body)
else process.stdout.write(body)
