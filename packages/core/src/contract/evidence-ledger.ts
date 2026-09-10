export * as EvidenceLedgerContract from "./evidence-ledger"

import { Schema } from "effect"
import { contentDigest } from "./digest"
import {
  EvidenceManifest,
  assertAuthoritativeManifest,
  assertReleaseGo,
  decodeEvidenceManifest,
  evidenceManifestDigest,
  EvidenceReleaseGateError,
  type EvidenceManifest as EvidenceManifestType,
} from "./evidence-manifest"

/** RI-51 authoritative ledger schema. Every digest is lowercase SHA-256 hex. */
export const EvidenceLedgerVersion = {
  schema: "authoritative-evidence-ledger.v1",
} as const

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export const EvidenceLedger = Schema.Struct({
  schemaVersion: Schema.Literal(EvidenceLedgerVersion.schema),
  candidateId: Schema.String,
  manifest: EvidenceManifest,
  manifestDigest: Digest,
  sourceManifestDigest: Digest,
  runtimeInventoryDigest: Digest,
  packagedReportDigest: Digest,
  evidenceBundleDigests: Schema.Array(Digest),
  ledgerDigest: Digest,
  issuedAt: Schema.String,
})
export type EvidenceLedger = typeof EvidenceLedger.Type

export class EvidenceLedgerAuthorityError extends Schema.TaggedErrorClass<EvidenceLedgerAuthorityError>()(
  "EvidenceLedgerAuthorityError",
  { reason: Schema.String },
) {}

export class EvidenceLedgerReleaseGateError extends Schema.TaggedErrorClass<EvidenceLedgerReleaseGateError>()(
  "EvidenceLedgerReleaseGateError",
  { blockers: Schema.Array(Schema.String) },
) {}

export type EvidenceBundleArtifact = {
  readonly evidenceHash: string
  readonly signed: boolean
}

/** Stable digest over all ledger references; issuance time is intentionally excluded. */
export function evidenceLedgerDigest(ledger: Pick<EvidenceLedger, Exclude<keyof EvidenceLedger, "ledgerDigest" | "issuedAt">>): string {
  return contentDigest({
    schemaVersion: ledger.schemaVersion,
    candidateId: ledger.candidateId,
    manifestDigest: ledger.manifestDigest,
    sourceManifestDigest: ledger.sourceManifestDigest,
    runtimeInventoryDigest: ledger.runtimeInventoryDigest,
    packagedReportDigest: ledger.packagedReportDigest,
    evidenceBundleDigests: [...ledger.evidenceBundleDigests].toSorted(),
  })
}

/**
 * Build a ledger from one already-decoded candidate manifest and its external artifact refs. The
 * constructor derives both the manifest and ledger digests, so callers cannot claim a stale digest
 * for a changed manifest or reorder evidence refs to create a second identity.
 */
export function makeAuthoritativeLedger(input: {
  readonly manifest: EvidenceManifestType
  readonly sourceManifestDigest: string
  readonly runtimeInventoryDigest: string
  readonly packagedReportDigest: string
  readonly evidenceBundleDigests: readonly string[]
  readonly issuedAt?: string
}): EvidenceLedger {
  const manifest = decodeEvidenceManifest(input.manifest)
  assertAuthoritativeManifest(manifest)
  const evidenceBundleDigests = [...new Set(input.evidenceBundleDigests)].toSorted()
  const base = {
    schemaVersion: EvidenceLedgerVersion.schema,
    candidateId: manifest.candidateId,
    manifest,
    manifestDigest: evidenceManifestDigest(manifest),
    sourceManifestDigest: input.sourceManifestDigest,
    runtimeInventoryDigest: input.runtimeInventoryDigest,
    packagedReportDigest: input.packagedReportDigest,
    evidenceBundleDigests,
  }
  const ledger = EvidenceLedger.make({
    ...base,
    ledgerDigest: evidenceLedgerDigest(base),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  })
  assertAuthoritativeLedger(ledger)
  return ledger
}

/** Recompute and validate all cross-references before a ledger is accepted as authoritative. */
export function assertAuthoritativeLedger(input: unknown): EvidenceLedger {
  const ledger = Schema.decodeUnknownSync(EvidenceLedger, { onExcessProperty: "error" })(input)
  assertAuthoritativeManifest(ledger.manifest)
  if (ledger.candidateId !== ledger.manifest.candidateId)
    throw new EvidenceLedgerAuthorityError({ reason: "ledger_manifest_candidate_mismatch" })
  if (ledger.manifestDigest !== evidenceManifestDigest(ledger.manifest))
    throw new EvidenceLedgerAuthorityError({ reason: "ledger_manifest_digest_mismatch" })
  if (new Set(ledger.evidenceBundleDigests).size !== ledger.evidenceBundleDigests.length)
    throw new EvidenceLedgerAuthorityError({ reason: "ledger_evidence_refs_must_be_unique" })
  if (ledger.evidenceBundleDigests.join("\n") !== [...ledger.evidenceBundleDigests].toSorted().join("\n"))
    throw new EvidenceLedgerAuthorityError({ reason: "ledger_evidence_refs_must_be_sorted" })
  if (ledger.ledgerDigest !== evidenceLedgerDigest(ledger))
    throw new EvidenceLedgerAuthorityError({ reason: "ledger_digest_mismatch" })
  return ledger
}

/**
 * Release gate over the ledger. In addition to the manifest's G0–G8 status, packaged evidence and
 * runtime references are mandatory; a source-only or test-only ledger can never become GO.
 */
export function assertLedgerReleaseGo(
  input: unknown,
  options: { readonly artifacts?: readonly EvidenceBundleArtifact[] } = {},
): void {
  const ledger = assertAuthoritativeLedger(input)
  const blockers: string[] = []
  if (ledger.evidenceBundleDigests.length === 0) blockers.push("evidence_bundle_missing")
  if (ledger.sourceManifestDigest === contentDigest({ present: false })) blockers.push("source_manifest_missing")
  if (ledger.runtimeInventoryDigest === contentDigest({ present: false })) blockers.push("runtime_inventory_missing")
  if (ledger.packagedReportDigest === contentDigest({ present: false })) blockers.push("packaged_report_missing")
  if (options.artifacts !== undefined) {
    const artifactRefs = options.artifacts.map((artifact) => artifact.evidenceHash)
    const duplicates = artifactRefs.filter((evidenceHash, index) => artifactRefs.indexOf(evidenceHash) !== index)
    for (const evidenceHash of [...new Set(duplicates)].toSorted())
      blockers.push(`evidence_bundle_artifacts_duplicate:${evidenceHash}`)
    const artifacts = new Map(options.artifacts.map((artifact) => [artifact.evidenceHash, artifact]))
    for (const evidenceHash of ledger.evidenceBundleDigests) {
      // 2026-09-10 ruling: package/release signing is descoped for the open-source model (anyone
      // may fork, modify, and rebuild, so a signed "official" artifact proves nothing about the
      // package). Release integrity is the unsigned digest chain plus distribution-channel trust;
      // signature status stays informational for callers that verify with an optional public key.
      const artifact = artifacts.get(evidenceHash)
      if (artifact === undefined) blockers.push(`evidence_bundle_artifact_missing:${evidenceHash}`)
    }
  }
  try {
    assertReleaseGo(ledger.manifest)
  } catch (error) {
    if (error instanceof EvidenceReleaseGateError) blockers.push(...error.blockers)
    else throw error
  }
  if (blockers.length > 0) throw new EvidenceLedgerReleaseGateError({ blockers })
}
