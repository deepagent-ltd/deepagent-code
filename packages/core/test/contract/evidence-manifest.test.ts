import { describe, expect, test } from "bun:test"
import {
  decodeEvidenceManifest,
  encodeEvidenceManifest,
  validateManifestIdentity,
  evidenceManifestDigest,
  EvidenceManifestDecodeError,
  EvidenceIdentityMismatchError,
  type EvidenceManifest,
  type CandidateIdentity,
  EvidenceManifestVersion,
} from "../../src/contract/evidence-manifest"

const base: EvidenceManifest = {
  schemaVersion: "evidence-manifest.v1",
  candidateId: "cand-1",
  commit: "abc123",
  tree: "tree1",
  buildId: "b-1",
  packageDigests: { core: "p1", app: "p2" },
  schemaDigest: "sd-1",
  migrationRegistryDigest: "mr-1",
  openapiDigest: "oa-1",
  sdkDigest: "sdk-1",
  capabilityManifestDigest: "cap-1",
  eventSchemaDigest: "es-1",
  providerProfilesDigest: "pp-1",
  runtimeFlagsDigest: "rf-1",
  testEnvironmentDigest: "te-1",
  machine: "macos-26-arm64",
  evidenceLevel: "D2",
  gates: [
    { gate: "G0", status: "passed", refs: ["ref-1"] },
    { gate: "G1", status: "pending", refs: [] },
  ],
  openFindings: ["P3-hygiene-1"],
  acceptedResiduals: [
    {
      id: "res-1",
      candidateId: "cand-1",
      ownerTask: "C6",
      boundedImpact: "cosmetic",
      whyNotP0P1: "cosmetic only",
      deadline: "2026-09-30",
      workaroundOrFailClosed: "none",
      approver: "coordinator",
    },
  ],
  issuedAt: "2026-08-28T00:00:00Z",
}

const identity: CandidateIdentity = {
  candidateId: "cand-1",
  commit: "abc123",
  tree: "tree1",
  schemaDigest: "sd-1",
  migrationRegistryDigest: "mr-1",
  packageVersionsDigest: "pkgdigest1", // replaced below by the real consolidated value
  testEnvironmentDigest: "te-1",
}

describe("C0-07 evidence manifest contract", () => {
  test("round-trip encode/decode", () => {
    const decoded = decodeEvidenceManifest(JSON.parse(encodeEvidenceManifest(base)))
    expect(decoded.candidateId).toBe("cand-1")
    expect(decoded.gates[0].gate).toBe("G0")
  })

  test("missing required identity field rejected", () => {
    const bad = { ...base } as Record<string, unknown>
    delete bad.commit
    expect(() => decodeEvidenceManifest(bad)).toThrow(EvidenceManifestDecodeError)
  })

  test("unknown gate id rejected", () => {
    const bad = { ...base, gates: [{ gate: "G9", status: "pending", refs: [] }] }
    expect(() => decodeEvidenceManifest(bad)).toThrow(EvidenceManifestDecodeError)
  })

  test("unknown gate status rejected", () => {
    const bad = { ...base, gates: [{ gate: "G0", status: "maybe", refs: [] }] }
    expect(() => decodeEvidenceManifest(bad)).toThrow(EvidenceManifestDecodeError)
  })

  test("unknown evidence level rejected", () => {
    const bad = { ...base, evidenceLevel: "D7" }
    expect(() => decodeEvidenceManifest(bad)).toThrow(EvidenceManifestDecodeError)
  })

  test("extra field rejected", () => {
    const bad = { ...base, secret: true }
    expect(() => decodeEvidenceManifest(bad)).toThrow(EvidenceManifestDecodeError)
  })

  test("accepted residual requires full bounded fields", () => {
    const bad = { ...base, acceptedResiduals: [{ id: "r", candidateId: "cand-1" }] }
    expect(() => decodeEvidenceManifest(bad)).toThrow(EvidenceManifestDecodeError)
  })

  test("identity validation passes only for the matching candidate", () => {
    const consolidated = evidenceManifestDigest(base.packageDigests as never)
    const good: CandidateIdentity = { ...identity, packageVersionsDigest: consolidated }
    expect(() => validateManifestIdentity(base, good)).not.toThrow()
    const bad: CandidateIdentity = { ...good, commit: "other" }
    expect(() => validateManifestIdentity(base, bad)).toThrow(EvidenceIdentityMismatchError)
  })

  test("evidence cannot cross candidates (candidateId binding)", () => {
    const consolidated = evidenceManifestDigest(base.packageDigests as never)
    const wrong: CandidateIdentity = { ...identity, packageVersionsDigest: consolidated, candidateId: "cand-2" }
    expect(() => validateManifestIdentity(base, wrong)).toThrow(EvidenceIdentityMismatchError)
  })

  test("manifest digest is deterministic and strips issuance time", () => {
    const a = evidenceManifestDigest(base)
    const b = evidenceManifestDigest({ ...base, issuedAt: "2026-09-01T00:00:00Z" })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test("digest changes on identity fields", () => {
    const a = evidenceManifestDigest(base)
    const b = evidenceManifestDigest({ ...base, commit: "def456" })
    expect(a).not.toBe(b)
  })

  test("version literal enforces the schema version", () => {
    expect(EvidenceManifestVersion.schema).toBe("evidence-manifest.v1")
    const bad = { ...base, schemaVersion: "evidence-manifest.v2" }
    expect(() => decodeEvidenceManifest(bad)).toThrow(EvidenceManifestDecodeError)
  })
})
