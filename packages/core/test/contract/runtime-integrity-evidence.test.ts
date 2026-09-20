import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import {
  makeRuntimeIntegrityEvidence,
  runtimeIntegrityEvidenceDigest,
  signRuntimeIntegrityEvidence,
  validateRuntimeIntegrityEvidence,
  verifySignedRuntimeIntegrityEvidence,
  type RuntimeIdentity,
} from "../../src/contract/runtime-integrity-evidence"

const H = (char: string) => char.repeat(64)
const identity: RuntimeIdentity = {
  candidateID: "candidate-1",
  commit: "commit-1",
  tree: "tree-1",
  packageDigest: H("a"),
  schemaDigest: H("b"),
  rootCompositionDigest: H("c"),
  databaseSchemaDigest: H("d"),
  eventSchemaDigest: H("e"),
  capabilityManifestDigest: H("f"),
}

const input = {
  sessionID: "ses_evidence",
  attemptID: "attempt-1",
  requestHash: H("1"),
  preparedTurnHash: H("2"),
  promptSources: [{ source: "system", digest: H("3") }],
  toolDefinitions: [{ toolID: "bash", definitionDigest: H("4") }],
  effectivePermissions: [{ scope: "session", rulesDigest: H("5") }],
  route: {
    providerID: "provider",
    modelID: "model",
    protocol: "responses",
    origin: "https://provider.example",
    endpointOriginDigest: H("a"),
    capabilityDigest: H("6"),
    loweringVersion: 1,
    protocolRevision: 1,
  },
  receipts: [{ kind: "provider_turn", id: "receipt-1", digest: H("7") }],
  physicalCallCount: 1,
  terminal: { status: "settled" as const, outcomeDigest: H("8") },
  identity,
  issuedAt: "2026-09-09T00:00:00Z",
}

describe("RI-24 runtime integrity evidence contract", () => {
  test("builds a complete digest-only attempt bundle", () => {
    const evidence = makeRuntimeIntegrityEvidence(input)
    expect(evidence.schemaVersion).toBe("runtime-integrity-evidence.v1")
    expect(runtimeIntegrityEvidenceDigest(evidence)).toMatch(/^[0-9a-f]{64}$/)
    expect(() => validateRuntimeIntegrityEvidence(evidence, identity)).not.toThrow()
  })

  test("rejects a settled attempt with a missing physical call", () => {
    expect(() => makeRuntimeIntegrityEvidence({ ...input, physicalCallCount: 0 })).toThrow()
  })

  test("rejects an abandoned attempt with a physical call", () => {
    expect(() =>
      makeRuntimeIntegrityEvidence({
        ...input,
        physicalCallCount: 1,
        terminal: { status: "abandoned_before_dispatch" },
      }),
    ).toThrow()
  })

  test("does not validate evidence across commit or tree identity", () => {
    const evidence = makeRuntimeIntegrityEvidence(input)
    expect(() => validateRuntimeIntegrityEvidence(evidence, { ...identity, commit: "other" })).toThrow()
    expect(() => validateRuntimeIntegrityEvidence(evidence, { ...identity, tree: "other" })).toThrow()
  })

  test("signs and verifies the full evidence envelope with an external Ed25519 key", () => {
    const evidence = makeRuntimeIntegrityEvidence(input)
    const pair = generateKeyPairSync("ed25519")
    const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
    const signed = signRuntimeIntegrityEvidence({ evidence, keyID: "test-key", privateKeyPem })
    expect(verifySignedRuntimeIntegrityEvidence({ signed, publicKeyPem })).toBe(true)
    expect(
      verifySignedRuntimeIntegrityEvidence({
        signed: { ...signed, evidenceDigest: H("9") },
        publicKeyPem,
      }),
    ).toBe(false)
  })
})
