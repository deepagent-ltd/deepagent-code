import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { contentDigest } from "../../src/contract/digest"
import { makeAuthoritativeLedger } from "../../src/contract/evidence-ledger"
import { makeAuthoritativeManifest, type EvidenceManifest } from "../../src/contract/evidence-manifest"
import { makePackagedRuntimeReport } from "../../src/contract/packaged-runtime-report"
import {
  makeRuntimeIntegrityEvidence,
  runtimeIntegrityEvidenceDigest,
  signRuntimeIntegrityEvidence,
  type RuntimeIdentity,
} from "../../src/contract/runtime-integrity-evidence"
import { Hash } from "../../src/util/hash"
import { tmpdir } from "../fixture/tmpdir"

const H = (value: string) => contentDigest(value)
const gates: EvidenceManifest["gates"] = [
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

test("RI-51 ledger generator binds byte digests and verifies signed evidence", async () => {
  await using root = await tmpdir()
  const candidateId = "candidate-script"
  const manifest = makeAuthoritativeManifest({
    candidateId,
    commit: "commit-script",
    tree: "tree-script",
    packageDigests: { core: H("core"), deepagent: H("deepagent") },
    schemaDigest: H("schema"),
    migrationRegistryDigest: H("migration"),
    openapiDigest: H("openapi"),
    sdkDigest: H("sdk"),
    capabilityManifestDigest: H("capability"),
    eventSchemaDigest: H("event"),
    providerProfilesDigest: H("provider"),
    runtimeFlagsDigest: H("flags"),
    testEnvironmentDigest: H("environment"),
    machine: "test",
    evidenceLevel: "D6",
    gates,
    openFindings: [],
    acceptedResiduals: [],
    issuedAt: "2026-09-09T00:00:00.000Z",
  })
  const identity: RuntimeIdentity = {
    candidateID: candidateId,
    commit: "commit-script",
    tree: "tree-script",
    packageDigest: H("package-runtime"),
    schemaDigest: H("schema-runtime"),
    rootCompositionDigest: H("root-runtime"),
    databaseSchemaDigest: H("database-runtime"),
    eventSchemaDigest: H("event-runtime"),
    capabilityManifestDigest: H("capability-runtime"),
  }
  const evidence = makeRuntimeIntegrityEvidence({
    sessionID: "ses-script",
    attemptID: "attempt-script",
    requestHash: H("request"),
    preparedTurnHash: H("prepared"),
    promptSources: [],
    toolDefinitions: [],
    effectivePermissions: [],
    route: {
      providerID: "provider",
      modelID: "model",
      protocol: "protocol",
      origin: "origin",
      endpointOriginDigest: H("endpoint"),
      capabilityDigest: H("capability-route"),
      loweringVersion: 1,
      protocolRevision: 1,
    },
    receipts: [{ kind: "provider_turn", id: "receipt-script", digest: H("receipt") }],
    physicalCallCount: 1,
    terminal: { status: "settled", outcomeDigest: H("outcome") },
    identity,
    issuedAt: "2026-09-09T00:00:00.000Z",
  })
  const keyPair = generateKeyPairSync("ed25519")
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
  const signed = signRuntimeIntegrityEvidence({ evidence, keyID: "script-key", privateKeyPem })
  const packagedReport = makePackagedRuntimeReport({
    candidateId,
    commit: "commit-script",
    tree: "tree-script",
    artifacts: [{ path: "deepagent-code", bytes: 1, sha256: H("binary") }],
    runs: [
      {
        entrypoint: "deepagent-code/test",
        artifactPath: "deepagent-code",
        evidenceDigest: runtimeIntegrityEvidenceDigest(evidence),
        sessionID: evidence.sessionID,
        attemptID: evidence.attemptID,
        rootCompositionDigest: evidence.identity.rootCompositionDigest,
        toolIDs: [],
        physicalCallCount: evidence.physicalCallCount,
        terminalStatus: evidence.terminal.status,
      },
    ],
    issuedAt: "2026-09-09T00:00:00.000Z",
  })
  const manifestPath = join(root.path, "manifest.json")
  const sourcePath = join(root.path, "source.json")
  const runtimePath = join(root.path, "runtime.json")
  const packagePath = join(root.path, "package.json")
  const evidenceDir = join(root.path, "evidence")
  const publicKeyPath = join(root.path, "public.pem")
  const outputPath = join(root.path, "ledger.json")
  await Bun.write(manifestPath, JSON.stringify(manifest))
  await Bun.write(sourcePath, "source-manifest-bytes")
  await Bun.write(runtimePath, JSON.stringify({ runtime: true }))
  await Bun.write(packagePath, JSON.stringify(packagedReport))
  await Bun.write(publicKeyPath, publicKeyPem)
  await mkdir(evidenceDir)
  await Bun.write(join(evidenceDir, "bundle.json"), JSON.stringify(signed))
  const script = new URL("../../script/evidence-ledger/generate-ledger.ts", import.meta.url)
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(script),
      "--manifest",
      manifestPath,
      "--source-manifest",
      sourcePath,
      "--runtime-inventory",
      runtimePath,
      "--packaged-report",
      packagePath,
      "--evidence-dir",
      evidenceDir,
      "--public-key",
      publicKeyPath,
      "--out",
      outputPath,
    ],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect(exitCode).toBe(0)
  expect(stderr).toBe("")
  const ledger = await Bun.file(outputPath).json()
  expect(ledger.candidateId).toBe(candidateId)
  expect(ledger.evidenceBundleDigests).toEqual([runtimeIntegrityEvidenceDigest(signed.evidence)])
  expect(ledger.sourceManifestDigest).toBe(Hash.sha256(Buffer.from("source-manifest-bytes")))
  expect(makeAuthoritativeLedger({
    manifest,
    sourceManifestDigest: ledger.sourceManifestDigest,
    runtimeInventoryDigest: ledger.runtimeInventoryDigest,
    packagedReportDigest: ledger.packagedReportDigest,
    evidenceBundleDigests: ledger.evidenceBundleDigests,
  }).ledgerDigest).toBe(ledger.ledgerDigest)

  const packageDir = join(root.path, "package-dir")
  await mkdir(join(packageDir, "bin"), { recursive: true })
  await Bun.write(join(packageDir, "bin", "deepagent"), "packaged-binary")
  const runsPath = join(root.path, "runs.json")
  await Bun.write(
    runsPath,
    JSON.stringify([
      {
        entrypoint: "deepagent-code/packaged",
        artifactPath: "bin/deepagent",
        evidenceDigest: runtimeIntegrityEvidenceDigest(evidence),
        sessionID: evidence.sessionID,
        attemptID: evidence.attemptID,
        rootCompositionDigest: evidence.identity.rootCompositionDigest,
        toolIDs: [],
        physicalCallCount: evidence.physicalCallCount,
        terminalStatus: evidence.terminal.status,
      },
    ]),
  )
  const wrapperOutputPath = join(root.path, "wrapper-ledger.json")
  const wrapper = new URL("../../script/evidence-ledger/generate-candidate-ledger.ts", import.meta.url)
  const wrapperChild = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(wrapper),
      "--manifest",
      manifestPath,
      "--evidence-dir",
      evidenceDir,
      "--public-key",
      publicKeyPath,
      "--packaged-dir",
      packageDir,
      "--runs",
      runsPath,
      "--out",
      wrapperOutputPath,
    ],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  const [wrapperStderr, wrapperExitCode] = await Promise.all([
    new Response(wrapperChild.stderr).text(),
    wrapperChild.exited,
  ])
  expect(wrapperExitCode).toBe(0)
  expect(wrapperStderr).toBe("")
  expect((await Bun.file(wrapperOutputPath).json()).candidateId).toBe(candidateId)
})
