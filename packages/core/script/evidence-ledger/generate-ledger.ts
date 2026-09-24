#!/usr/bin/env bun
/**
 * RI-51 authoritative ledger generator.
 *
 *   bun run script/evidence-ledger/generate-ledger.ts \
 *     --manifest <evidence-manifest.json> \
 *     --source-manifest <deterministic-manifest.json> \
 *     --runtime-inventory <inventory.json> \
 *     --packaged-report <packaged-report.json> \
 *     --evidence-dir <signed-evidence-dir> \
 *     --public-key <ed25519-public-key.pem> \
 *     [--out <authoritative-ledger.json>]
 *
 * Source/runtime/package inputs are hashed from the exact bytes supplied to this command. Missing
 * optional inputs become explicit sentinel digests; the release gate then remains NO-GO instead of
 * silently manufacturing a green ledger. Evidence files may be raw runtime evidence or signed
 * envelopes; only signed envelopes are eligible for RELEASE-GO.
 */
import { contentDigest } from "../../src/contract/digest"
import {
  assertLedgerReleaseGo,
  EvidenceLedgerReleaseGateError,
  makeAuthoritativeLedger,
} from "../../src/contract/evidence-ledger"
import { decodeEvidenceManifest } from "../../src/contract/evidence-manifest"
import { assertPackagedRuntimeReport } from "../../src/contract/packaged-runtime-report"
import { Hash } from "../../src/util/hash"
import { assertRunEvidenceMatch, evidenceFiles, readEvidenceArtifact } from "./read-evidence"

const args = process.argv.slice(2)

function option(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function requiredOption(name: string): string {
  const value = option(name)
  if (!value) throw new Error(`missing required option ${name}`)
  return value
}

async function digestFile(filename: string | undefined): Promise<string> {
  if (!filename) return contentDigest({ present: false })
  const bytes = await Bun.file(filename).arrayBuffer()
  return Hash.sha256(Buffer.from(bytes))
}

const manifestPath = requiredOption("--manifest")
const manifest = decodeEvidenceManifest(await Bun.file(manifestPath).json())
const sourceManifestPath = option("--source-manifest")
const sourceDigest = sourceManifestPath
  ? Hash.sha256(Buffer.from(await Bun.file(sourceManifestPath).arrayBuffer()))
  : contentDigest({ present: false })
const runtimeDigest = await digestFile(option("--runtime-inventory"))
const packagedDigest = await digestFile(option("--packaged-report"))
const publicKeyPath = option("--public-key")
const publicKeyPem = publicKeyPath ? await Bun.file(publicKeyPath).text() : undefined
const artifactRows = await Promise.all(
  evidenceFiles(option("--evidence-dir")).map((filename) => readEvidenceArtifact(filename, publicKeyPem)),
)
const candidateMismatches = artifactRows.filter(
  (artifact) => artifact.candidateID !== undefined && artifact.candidateID !== manifest.candidateId,
)
if (candidateMismatches.length > 0) throw new Error("evidence artifact candidate does not match manifest candidate")
const evidenceBundleDigests = artifactRows.map((artifact) => artifact.evidenceHash)
const packagedReportPath = option("--packaged-report")
if (packagedReportPath) {
  const packagedReport = assertPackagedRuntimeReport(await Bun.file(packagedReportPath).json())
  if (packagedReport.candidateId !== manifest.candidateId)
    throw new Error("packaged report candidate does not match manifest candidate")
  if (packagedReport.commit !== manifest.commit)
    throw new Error("packaged report commit does not match manifest commit")
  if (packagedReport.tree !== manifest.tree) throw new Error("packaged report tree does not match manifest tree")
  const artifacts = new Map(artifactRows.map((artifact) => [artifact.evidenceHash, artifact]))
  const ledgerEvidenceHashes = new Set(packagedReport.runs.map((run) => run.evidenceDigest))
  for (const run of packagedReport.runs) {
    const artifact = artifacts.get(run.evidenceDigest)
    if (!artifact)
      throw new Error(`packaged report references evidence not present in evidence dir: ${run.evidenceDigest}`)
    assertRunEvidenceMatch(run, artifact)
  }
  for (const evidenceHash of artifacts.keys()) {
    if (!ledgerEvidenceHashes.has(evidenceHash))
      throw new Error(`evidence artifact is not referenced by packaged report: ${evidenceHash}`)
  }
}
const ledger = makeAuthoritativeLedger({
  manifest,
  sourceManifestDigest: sourceDigest,
  runtimeInventoryDigest: runtimeDigest,
  packagedReportDigest: packagedDigest,
  evidenceBundleDigests,
})
let releaseGo = true
try {
  assertLedgerReleaseGo(ledger, { artifacts: artifactRows })
} catch (error) {
  if (!(error instanceof EvidenceLedgerReleaseGateError)) throw error
  releaseGo = false
  console.error(`RI-51 RELEASE-NO-GO: ${error.blockers.join(",")}`)
}
const body = `${JSON.stringify(ledger, null, 2)}\n`
const out = option("--out")
if (out) {
  await Bun.write(out, body)
} else {
  process.stdout.write(body)
}
if (!releaseGo) process.exitCode = 1
