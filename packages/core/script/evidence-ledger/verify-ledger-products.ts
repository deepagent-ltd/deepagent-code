#!/usr/bin/env bun
// Reopen the archived RI-51 inputs and compare their exact bytes with the authoritative ledger.
// This runs before release upload and can be rerun on an extracted evidence asset.
import path from "node:path"
import { Schema } from "effect"
import { contentDigest } from "../../src/contract/digest"
import { assertAuthoritativeLedger } from "../../src/contract/evidence-ledger"
import { PackagedRuntimeReportContract } from "../../src/contract/packaged-runtime-report"
import { Hash } from "../../src/util/hash"
import { assertManifestMatches, assertManifestShape } from "../manifest-digest/manifest"
import { verifyQualificationBundle } from "./verify-qualification-bundle"

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const ledgerPath = option("--ledger")
const artifactDir = option("--artifact-dir")
if (!ledgerPath || !artifactDir)
  throw new Error("usage: verify-ledger-products.ts --ledger <ledger.json> --artifact-dir <dir>")

const ledger = assertAuthoritativeLedger(await Bun.file(ledgerPath).json())
const read = async (name: string, expected: string) => {
  const file = path.join(artifactDir, name)
  const bytes = Buffer.from(await Bun.file(file).arrayBuffer())
  if (Hash.sha256(bytes) !== expected) throw new Error(`${name} bytes do not match ledger digest`)
  return bytes
}

const source = assertManifestShape(
  JSON.parse((await read("source-manifest.json", ledger.sourceManifestDigest)).toString()),
)
assertManifestMatches(source, source)
const callerDigest = source.inputs["c0-01-inventory-report"]?.["packages/core/.artifacts/caller-inventory/report.json"]
if (!callerDigest) throw new Error("source manifest is missing caller-inventory report binding")
await read("caller-inventory/report.json", callerDigest)
await read("runtime-inventory.tsv", ledger.runtimeInventoryDigest)

if (ledger.packagedReportDigest !== contentDigest({ present: false })) {
  const packaged = PackagedRuntimeReportContract.assertPackagedRuntimeReport(
    JSON.parse((await read("packaged-runtime-report.json", ledger.packagedReportDigest)).toString()),
  )
  if (
    packaged.candidateId !== ledger.candidateId ||
    packaged.commit !== ledger.manifest.commit ||
    packaged.tree !== ledger.manifest.tree
  )
    throw new Error("packaged report identity does not match ledger manifest")
  const runs = Schema.decodeUnknownSync(Schema.Array(PackagedRuntimeReportContract.PackagedRuntimeRun))(
    await Bun.file(path.join(artifactDir, "runs.json")).json(),
  )
  const ordered = [...runs].toSorted((a, b) =>
    `${a.entrypoint}\u0000${a.evidenceDigest}`.localeCompare(`${b.entrypoint}\u0000${b.evidenceDigest}`),
  )
  if (contentDigest(ordered) !== contentDigest(packaged.runs))
    throw new Error("runs.json does not match packaged runtime report")
}

const gatesFile = Bun.file(path.join(artifactDir, "gates.json"))
const gatesPresent = await gatesFile.exists()
if (!gatesPresent && ledger.manifest.gates.some((entry) => entry.status === "passed"))
  throw new Error("gates.json is required when a ledger gate has passed")
if (gatesPresent) {
  const gates = (await gatesFile.json()) as Record<string, unknown>
  for (const entry of ledger.manifest.gates) {
    const value = gates[entry.gate]
    const status =
      typeof value === "string"
        ? value
        : value && typeof value === "object" && "status" in value
          ? value.status
          : undefined
    const refs = value && typeof value === "object" && "refs" in value ? value.refs : []
    if (status !== entry.status || contentDigest(refs) !== contentDigest(entry.refs))
      throw new Error(`gates.json ${entry.gate} does not match ledger manifest`)
  }
}
const qualificationDir = path.join(artifactDir, "qualification")
const qualificationPresent = await Bun.file(path.join(qualificationDir, "qualification.json")).exists()
if (Boolean(ledger.manifest.packageDigests["qualification-source-run"]) !== qualificationPresent)
  throw new Error("qualification source run presence does not match ledger")
if (qualificationPresent) {
  await read("qualification/source-run.json", ledger.manifest.packageDigests["qualification-source-run"]!)
  await read("qualification/gates.json", ledger.manifest.packageDigests["qualification-gates"]!)
  await verifyQualificationBundle({
    directory: qualificationDir,
    commit: ledger.manifest.commit,
    tree: ledger.manifest.tree,
  })
  if (
    Hash.sha256(Buffer.from(await Bun.file(path.join(qualificationDir, "gates.json")).arrayBuffer())) !==
    Hash.sha256(Buffer.from(await gatesFile.arrayBuffer()))
  )
    throw new Error("archived qualification gates differ from ledger gates")
}
const assetManifest = Bun.file(path.join(artifactDir, "release-assets.json"))
const assetManifestPresent = await assetManifest.exists()
if (Boolean(ledger.manifest.packageDigests["release-assets-manifest"]) !== assetManifestPresent)
  throw new Error("release asset manifest presence does not match ledger")
if (assetManifestPresent) {
  const bytes = Buffer.from(await assetManifest.arrayBuffer())
  if (Hash.sha256(bytes) !== ledger.manifest.packageDigests["release-assets-manifest"])
    throw new Error("release asset manifest bytes do not match ledger")
  const parsed = JSON.parse(bytes.toString()) as {
    candidateCommit: string
    candidateTree: string
    assets: { name: string; sha256: string }[]
  }
  if (parsed.candidateCommit !== ledger.manifest.commit || parsed.candidateTree !== ledger.manifest.tree)
    throw new Error("release asset manifest candidate does not match ledger")
  for (const asset of parsed.assets)
    if (ledger.manifest.packageDigests[`release-asset:${asset.name}`] !== asset.sha256)
      throw new Error(`release asset ${asset.name} digest does not match ledger`)
}

console.log(`RI-51 archived products match ledger ${ledger.ledgerDigest}`)
