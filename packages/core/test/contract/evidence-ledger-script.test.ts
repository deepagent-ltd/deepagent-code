import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
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
      script.pathname,
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
  expect(
    makeAuthoritativeLedger({
      manifest,
      sourceManifestDigest: ledger.sourceManifestDigest,
      runtimeInventoryDigest: ledger.runtimeInventoryDigest,
      packagedReportDigest: ledger.packagedReportDigest,
      evidenceBundleDigests: ledger.evidenceBundleDigests,
    }).ledgerDigest,
  ).toBe(ledger.ledgerDigest)

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
  const productDir = join(root.path, "products")
  const gateInput = JSON.stringify(
    Object.fromEntries(gates.map((gate) => [gate.gate, { status: gate.status, refs: gate.refs }])),
  )
  await mkdir(productDir)
  await Bun.write(join(productDir, "gates.json"), gateInput)
  const wrapper = new URL("../../script/evidence-ledger/generate-candidate-ledger.ts", import.meta.url)
  const wrapperChild = Bun.spawn(
    [
      process.execPath,
      wrapper.pathname,
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
      "--artifact-dir",
      productDir,
    ],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  const [wrapperStderr, wrapperExitCode] = await Promise.all([
    new Response(wrapperChild.stderr).text(),
    wrapperChild.exited,
  ])
  expect(wrapperExitCode).toBe(0)
  expect(wrapperStderr).toBe("")
  const wrapperLedger = await Bun.file(wrapperOutputPath).json()
  expect(wrapperLedger.candidateId).toBe(candidateId)
  expect(Hash.sha256(Buffer.from(await Bun.file(join(productDir, "source-manifest.json")).arrayBuffer()))).toBe(
    wrapperLedger.sourceManifestDigest,
  )
  expect(Hash.sha256(Buffer.from(await Bun.file(join(productDir, "runtime-inventory.tsv")).arrayBuffer()))).toBe(
    wrapperLedger.runtimeInventoryDigest,
  )
  expect(Hash.sha256(Buffer.from(await Bun.file(join(productDir, "packaged-runtime-report.json")).arrayBuffer()))).toBe(
    wrapperLedger.packagedReportDigest,
  )
  expect(await Bun.file(join(productDir, "caller-inventory/report.json")).exists()).toBe(true)

  const verifier = new URL("../../script/evidence-ledger/verify-ledger-products.ts", import.meta.url)
  const verify = async () => {
    const child = Bun.spawn(
      [process.execPath, verifier.pathname, "--ledger", wrapperOutputPath, "--artifact-dir", productDir],
      { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    )
    return { exitCode: await child.exited, stderr: await new Response(child.stderr).text() }
  }
  expect((await verify()).exitCode).toBe(0)
  for (const name of [
    "source-manifest.json",
    "runtime-inventory.tsv",
    "caller-inventory/report.json",
    "packaged-runtime-report.json",
  ]) {
    const file = join(productDir, name)
    const original = await Bun.file(file).text()
    await Bun.write(file, `${original}\n`)
    expect((await verify()).exitCode).not.toBe(0)
    await Bun.write(file, original)
  }
  await rm(join(productDir, "gates.json"))
  const missingGates = await verify()
  expect(missingGates.exitCode).not.toBe(0)
  expect(missingGates.stderr).toContain("gates.json is required when a ledger gate has passed")
  await Bun.write(join(productDir, "gates.json"), gateInput)
  expect((await verify()).exitCode).toBe(0)
  await Bun.write(join(productDir, "gates.json"), JSON.stringify({ G0: { status: "passed", refs: ["tampered"] } }))
  expect((await verify()).stderr).toContain("gates.json G0 does not match ledger manifest")
  await Bun.write(join(productDir, "gates.json"), gateInput)

  const runs = (await Bun.file(join(productDir, "runs.json")).json()) as Array<{ attemptID: string }>
  await Bun.write(join(productDir, "runs.json"), JSON.stringify(runs.map((run) => ({ ...run, attemptID: "tampered" }))))
  expect((await verify()).stderr).toContain("runs.json does not match packaged runtime report")

  // A prebuilt report cannot launder an unrelated runtime evidence artifact through the direct
  // ledger entrypoint, even when candidateID and evidenceDigest were copied correctly.
  await Bun.write(
    packagePath,
    JSON.stringify(
      makePackagedRuntimeReport({
        candidateId,
        commit: "commit-script",
        tree: "tree-script",
        artifacts: packagedReport.artifacts,
        runs: packagedReport.runs.map((run) => ({ ...run, sessionID: "ses-unrelated" })),
      }),
    ),
  )
  const unrelated = Bun.spawn(
    [
      process.execPath,
      script.pathname,
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
  const [unrelatedStderr, unrelatedExitCode] = await Promise.all([
    new Response(unrelated.stderr).text(),
    unrelated.exited,
  ])
  expect(unrelatedExitCode).not.toBe(0)
  expect(unrelatedStderr).toContain("sessionID does not match runtime evidence")
})

test("RI-51 source-only NO-GO readback accepts all-pending gates without gates.json", async () => {
  await using root = await tmpdir()
  const ledgerPath = join(root.path, "ledger.json")
  const artifactDir = join(root.path, "release-evidence-products")
  const gate = new URL("../../script/evidence-ledger/release-gate.ts", import.meta.url)
  const child = Bun.spawn([process.execPath, gate.pathname, "--out", ledgerPath], {
    cwd: join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode).not.toBe(0)
  expect(stderr).toContain("RI-51 RELEASE-NO-GO: evidence_bundle_missing,packaged_report_missing")
  expect(stdout).toContain("RI-51 archived products match ledger")
  expect(
    (await Bun.file(ledgerPath).json()).manifest.gates.every((entry: { status: string }) => entry.status === "pending"),
  ).toBe(true)
  expect(await Bun.file(join(artifactDir, "gates.json")).exists()).toBe(false)

  const verifier = new URL("../../script/evidence-ledger/verify-ledger-products.ts", import.meta.url)
  const readback = Bun.spawn(
    [process.execPath, verifier.pathname, "--ledger", ledgerPath, "--artifact-dir", artifactDir],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  const [readbackStderr, readbackExitCode] = await Promise.all([new Response(readback.stderr).text(), readback.exited])
  expect(readbackExitCode).toBe(0)
  expect(readbackStderr).toBe("")
})
