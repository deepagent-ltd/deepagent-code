export * as EvidenceManifestContract from "./evidence-manifest"

import { Schema } from "effect"
import { contentDigest } from "./digest"

// C0-07 - Evidence manifest schema (freeze).
// Design authority: docs/core-v2.0-beta/evidence-ledger.md §5 (candidate
// manifest template) and §1 (§ current candidate fields), design §15
// (evidence levels), worklist C0-07.
// Pure-new contract module: not imported by any production module this wave.

export const EvidenceManifestVersion = {
  schema: "evidence-manifest.v1",
  gateId: 1,
  gateStatus: 1,
  evidenceLevel: 1,
  digest: 1,
} as const

/** Evidence levels per design §15 (D0-D6, 0-6). */
export const EvidenceLevel = Schema.Literals(["D0", "D1", "D2", "D3", "D4", "D5", "D6"])
export type EvidenceLevel = typeof EvidenceLevel.Type

/** Frozen gate ids in authoritative order (evidence-ledger §2). */
export const GateId = Schema.Literals(["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"])
export type GateId = typeof GateId.Type

export const GateStatus = Schema.Literals(["pending", "passed", "failed", "stale", "blocked"])
export type GateStatus = typeof GateStatus.Type

/** One gate entry: status + content-addressed refs to its evidence. */
export const GateEntry = Schema.Struct({
  gate: GateId,
  status: GateStatus,
  refs: Schema.Array(Schema.String),
})
export type GateEntry = typeof GateEntry.Type

/** Accepted residual with bounded impact and a non-blocking justification. */
export const AcceptedResidual = Schema.Struct({
  id: Schema.String,
  candidateId: Schema.String,
  ownerTask: Schema.String,
  boundedImpact: Schema.String,
  whyNotP0P1: Schema.String,
  deadline: Schema.String,
  workaroundOrFailClosed: Schema.String,
  approver: Schema.String,
})
export type AcceptedResidual = typeof AcceptedResidual.Type

/**
 * The frozen evidence manifest identity. Bindings are content digests; every
 * identity field is REQUIRED, so evidence can never be claimed for a
 * candidate whose commit/tree/schema/registry/package/config/test identity is
 * unverifiable. IssuedAt is a volatile issuance stamp (stripped from digest).
 */
export const EvidenceManifest = Schema.Struct({
  schemaVersion: Schema.Literal(EvidenceManifestVersion.schema),
  candidateId: Schema.String,
  commit: Schema.String,
  tree: Schema.String,
  buildId: Schema.String,
  packageDigests: Schema.Record(Schema.String, Schema.String),
  schemaDigest: Schema.String,
  migrationRegistryDigest: Schema.String,
  openapiDigest: Schema.String,
  sdkDigest: Schema.String,
  capabilityManifestDigest: Schema.String,
  eventSchemaDigest: Schema.String,
  providerProfilesDigest: Schema.String,
  runtimeFlagsDigest: Schema.String,
  testEnvironmentDigest: Schema.String,
  machine: Schema.String,
  evidenceLevel: EvidenceLevel,
  gates: Schema.Array(GateEntry),
  openFindings: Schema.Array(Schema.String),
  acceptedResiduals: Schema.Array(AcceptedResidual),
  issuedAt: Schema.String,
})
export type EvidenceManifest = typeof EvidenceManifest.Type

export class EvidenceManifestDecodeError extends Schema.TaggedErrorClass<EvidenceManifestDecodeError>()(
  "error",
  { path: Schema.String, summary: Schema.String },
) {}

function describeError(error: unknown): { path: string; summary: string } {
  const e = error as { path?: unknown; message?: string }
  const path = Array.isArray(e.path) ? JSON.stringify(e.path) : typeof e.path === "string" ? e.path : ""
  return { path, summary: typeof e.message === "string" ? e.message : "decode failed" }
}

export function decodeEvidenceManifest(input: unknown): EvidenceManifest {
  try {
    return Schema.decodeUnknownSync(EvidenceManifest)(input, { onExcessProperty: "error" })
  } catch (error) {
    const { path, summary } = describeError(error)
    throw new EvidenceManifestDecodeError({ path, summary })
  }
}

export function encodeEvidenceManifest(manifest: EvidenceManifest): string {
  return JSON.stringify(Schema.decodeUnknownSync(EvidenceManifest)(manifest))
}

export class EvidenceIdentityMismatchError extends Schema.TaggedErrorClass<EvidenceIdentityMismatchError>()(
  "error",
  { field: Schema.String, expected: Schema.String, actual: Schema.String },
) {}

/** Minimal identity struct consumers must provide to validate a manifest. */
export const CandidateIdentity = Schema.Struct({
  candidateId: Schema.String,
  commit: Schema.String,
  tree: Schema.String,
  schemaDigest: Schema.String,
  migrationRegistryDigest: Schema.String,
  packageVersionsDigest: Schema.String,
  testEnvironmentDigest: Schema.String,
})
export type CandidateIdentity = typeof CandidateIdentity.Type

/**
 * Evidence cannot cross candidates: every identity binding in the manifest
 * must equal the candidate being claimed. Fields compared: candidateId,
 * commit, tree, schemaDigest, migrationRegistryDigest, packageDigests
 * (consolidated via packageDigestsDigest), testEnvironmentDigest.
 */
export function validateManifestIdentity(
  manifest: Readonly<EvidenceManifest>,
  identity: CandidateIdentity,
): EvidenceManifest | null {
  const checks: readonly { field: string; expected: string; actual: string }[] = [
    { field: "candidateId", expected: identity.candidateId, actual: manifest.candidateId },
    { field: "commit", expected: identity.commit, actual: manifest.commit },
    { field: "tree", expected: identity.tree, actual: manifest.tree },
    { field: "schemaDigest", expected: identity.schemaDigest, actual: manifest.schemaDigest },
    { field: "migrationRegistryDigest", expected: identity.migrationRegistryDigest, actual: manifest.migrationRegistryDigest },
    { field: "testEnvironmentDigest", expected: identity.testEnvironmentDigest, actual: manifest.testEnvironmentDigest },
  ]
  for (const check of checks) {
    if (check.expected !== check.actual) {
      throw new EvidenceIdentityMismatchError(check)
    }
  }
  const consolidated = contentDigest(manifest.packageDigests)
  if (consolidated !== identity.packageVersionsDigest) {
    throw new EvidenceIdentityMismatchError({
      field: "packageDigests",
      expected: identity.packageVersionsDigest,
      actual: consolidated,
    })
  }
  return manifest
}

/** Volatile keys stripped by the evidence digest (shared digest.ts lacks issuedAt). */
const EVIDENCE_VOLATILE_KEYS = new Set(["issuedAt"])

function stripEvidenceVolatile(input: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(input)) return input.map((item) => stripEvidenceVolatile(item, seen))
  if (input !== null && typeof input === "object" && !(input instanceof Date)) {
    if (seen.has(input)) throw new TypeError("Evidence digest cannot encode cyclic values")
    seen.add(input)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(input as Record<string, unknown>)) {
      if (EVIDENCE_VOLATILE_KEYS.has(key)) continue
      out[key] = stripEvidenceVolatile((input as Record<string, unknown>)[key], seen)
    }
    seen.delete(input)
    return out
  }
  return input
}

/** Deterministic digest of the evidence manifest (issuedAt stripped). */
export function evidenceManifestDigest(manifest: Readonly<EvidenceManifest>): string {
  return contentDigest(stripEvidenceVolatile(manifest, new WeakSet()))
}
