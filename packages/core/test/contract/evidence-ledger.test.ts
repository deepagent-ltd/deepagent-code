import { describe, expect, test } from "bun:test"
import { contentDigest } from "../../src/contract/digest"
import { evidenceManifestDigest, type EvidenceManifest } from "../../src/contract/evidence-manifest"
import {
  assertAuthoritativeLedger,
  assertLedgerReleaseGo,
  evidenceLedgerDigest,
  EvidenceLedgerAuthorityError,
  EvidenceLedgerReleaseGateError,
  makeAuthoritativeLedger,
} from "../../src/contract/evidence-ledger"

const H = (value: string) => contentDigest(value)
const allPassedGates: EvidenceManifest["gates"] = [
  { gate: "G0", status: "passed", refs: ["g0"] },
  { gate: "G1", status: "passed", refs: ["g1"] },
  { gate: "G2", status: "passed", refs: ["g2"] },
  { gate: "G3", status: "passed", refs: ["g3"] },
  { gate: "G4", status: "passed", refs: ["g4"] },
  { gate: "G5", status: "passed", refs: ["g5"] },
  { gate: "G6", status: "passed", refs: ["g6"] },
  { gate: "G7", status: "passed", refs: ["g7"] },
  { gate: "G8", status: "passed", refs: ["g8"] },
]

const manifest: EvidenceManifest = {
  schemaVersion: "evidence-manifest.v1",
  candidateId: "candidate-ledger-test",
  commit: "commit-ledger-test",
  tree: "tree-ledger-test",
  buildId: "build-ledger-test",
  packageDigests: { core: H("core"), deepagent: H("deepagent") },
  schemaDigest: H("schema"),
  migrationRegistryDigest: H("migrations"),
  openapiDigest: H("openapi"),
  sdkDigest: H("sdk"),
  capabilityManifestDigest: H("capabilities"),
  eventSchemaDigest: H("events"),
  providerProfilesDigest: H("providers"),
  runtimeFlagsDigest: H("flags"),
  testEnvironmentDigest: H("environment"),
  machine: "test",
  evidenceLevel: "D4",
  gates: allPassedGates,
  openFindings: [],
  acceptedResiduals: [],
  issuedAt: "2026-09-09T00:00:00.000Z",
}

describe("RI-51 authoritative evidence ledger", () => {
  test("derives one stable ledger identity and sorts bundle references", () => {
    const ledger = makeAuthoritativeLedger({
      manifest,
      sourceManifestDigest: H("source"),
      runtimeInventoryDigest: H("runtime"),
      packagedReportDigest: H("package"),
      evidenceBundleDigests: [H("bundle-b"), H("bundle-a"), H("bundle-a")],
    })
    expect(ledger.candidateId).toBe(manifest.candidateId)
    expect(ledger.manifestDigest).toBe(evidenceManifestDigest(manifest))
    expect(ledger.evidenceBundleDigests).toEqual([H("bundle-a"), H("bundle-b")].toSorted())
    expect(ledger.ledgerDigest).toBe(evidenceLedgerDigest(ledger))
    expect(() => assertAuthoritativeLedger(ledger)).not.toThrow()
  })

  test("rejects a manifest digest or candidate cross-reference drift", () => {
    const ledger = makeAuthoritativeLedger({
      manifest,
      sourceManifestDigest: H("source"),
      runtimeInventoryDigest: H("runtime"),
      packagedReportDigest: H("package"),
      evidenceBundleDigests: [H("bundle")],
    })
    expect(() => assertAuthoritativeLedger({ ...ledger, manifestDigest: H("tampered") })).toThrow(
      EvidenceLedgerAuthorityError,
    )
    expect(() => assertAuthoritativeLedger({ ...ledger, candidateId: "other" })).toThrow(EvidenceLedgerAuthorityError)
  })

  test("rejects unsorted or duplicate evidence references", () => {
    const ledger = makeAuthoritativeLedger({
      manifest,
      sourceManifestDigest: H("source"),
      runtimeInventoryDigest: H("runtime"),
      packagedReportDigest: H("package"),
      evidenceBundleDigests: [H("bundle-a"), H("bundle-b")],
    })
    expect(() =>
      assertAuthoritativeLedger({
        ...ledger,
        evidenceBundleDigests: [ledger.evidenceBundleDigests[1], ledger.evidenceBundleDigests[0]],
        ledgerDigest: evidenceLedgerDigest({
          ...ledger,
          evidenceBundleDigests: [ledger.evidenceBundleDigests[1], ledger.evidenceBundleDigests[0]],
        }),
      }),
    ).toThrow(EvidenceLedgerAuthorityError)
    expect(() =>
      assertAuthoritativeLedger({
        ...ledger,
        evidenceBundleDigests: [H("bundle-a"), H("bundle-a")],
        ledgerDigest: evidenceLedgerDigest({ ...ledger, evidenceBundleDigests: [H("bundle-a"), H("bundle-a")] }),
      }),
    ).toThrow(EvidenceLedgerAuthorityError)
  })

  test("release gate fails closed for missing external artifacts and non-passed manifest gates", () => {
    const ledger = makeAuthoritativeLedger({
      manifest: { ...manifest, gates: manifest.gates.map((gate) => (gate.gate === "G8" ? { ...gate, status: "blocked" as const } : gate)) },
      sourceManifestDigest: H("source"),
      runtimeInventoryDigest: H("runtime"),
      packagedReportDigest: H("package"),
      evidenceBundleDigests: [],
    })
    expect(() => assertLedgerReleaseGo(ledger)).toThrow(EvidenceLedgerReleaseGateError)
    expect(() => assertLedgerReleaseGo({ ...ledger, evidenceBundleDigests: [H("bundle")] })).toThrow(EvidenceLedgerAuthorityError)
  })

  test("a complete ledger can pass only when every G0-G8 gate and external ref is present", () => {
    const ledger = makeAuthoritativeLedger({
      manifest,
      sourceManifestDigest: H("source"),
      runtimeInventoryDigest: H("runtime"),
      packagedReportDigest: H("package"),
      evidenceBundleDigests: [H("bundle")],
    })
    expect(() => assertLedgerReleaseGo(ledger)).not.toThrow()
    expect(() =>
      assertLedgerReleaseGo(ledger, {
        artifacts: [{ evidenceHash: H("bundle"), signed: false }],
      }),
    ).toThrow(EvidenceLedgerReleaseGateError)
    expect(() =>
      assertLedgerReleaseGo(ledger, {
        artifacts: [{ evidenceHash: H("bundle"), signed: true }],
      }),
    ).not.toThrow()
    expect(() =>
      assertLedgerReleaseGo(ledger, {
        artifacts: [
          { evidenceHash: H("bundle"), signed: true },
          { evidenceHash: H("bundle"), signed: true },
        ],
      }),
    ).toThrow(EvidenceLedgerReleaseGateError)
  })
})
