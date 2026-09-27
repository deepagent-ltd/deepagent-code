import { readdirSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import type { EvidenceBundleArtifact } from "../../src/contract/evidence-ledger"
import type { PackagedRuntimeRun } from "../../src/contract/packaged-runtime-report"
import { RuntimeIntegrityEvidenceContract } from "../../src/contract/runtime-integrity-evidence"

export function evidenceFiles(directory: string | undefined): string[] {
  if (!directory) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return evidenceFiles(filename)
    if (!entry.isFile() || !entry.name.endsWith(".json")) return []
    return [filename]
  })
}

export async function readEvidenceArtifact(
  filename: string,
  publicKeyPem: string | undefined,
): Promise<
  EvidenceBundleArtifact & {
    readonly candidateID: string
    readonly evidence: RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidence
  }
> {
  const value = await Bun.file(filename).json()
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    typeof value.schemaVersion !== "string"
  )
    throw new Error(`evidence artifact is not a recognized JSON contract: ${filename}`)
  if (value.schemaVersion === "runtime-integrity-evidence-signature.v1") {
    const signed = Schema.decodeUnknownSync(RuntimeIntegrityEvidenceContract.SignedRuntimeIntegrityEvidence, {
      onExcessProperty: "error",
    })(value)
    if (signed.evidenceDigest !== RuntimeIntegrityEvidenceContract.runtimeIntegrityEvidenceDigest(signed.evidence))
      throw new Error(`signed evidence digest mismatch: ${filename}`)
    if (
      publicKeyPem !== undefined &&
      !RuntimeIntegrityEvidenceContract.verifySignedRuntimeIntegrityEvidence({ signed, publicKeyPem })
    )
      throw new Error(`signed evidence signature invalid: ${filename}`)
    return {
      evidenceHash: signed.evidenceDigest,
      signed: publicKeyPem !== undefined,
      candidateID: signed.evidence.identity.candidateID,
      evidence: signed.evidence,
    }
  }
  if (value.schemaVersion === RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceVersion.schema) {
    const evidence = Schema.decodeUnknownSync(RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidence, {
      onExcessProperty: "error",
    })(value)
    return {
      evidenceHash: RuntimeIntegrityEvidenceContract.runtimeIntegrityEvidenceDigest(evidence),
      signed: false,
      candidateID: evidence.identity.candidateID,
      evidence,
    }
  }
  throw new Error(`unsupported evidence artifact schema: ${filename}`)
}

export function assertRunEvidenceMatch(
  run: PackagedRuntimeRun,
  artifact: Awaited<ReturnType<typeof readEvidenceArtifact>>,
) {
  const expected = artifact.evidence
  const fields = {
    sessionID: [run.sessionID, expected.sessionID],
    attemptID: [run.attemptID, expected.attemptID],
    rootCompositionDigest: [run.rootCompositionDigest, expected.identity.rootCompositionDigest],
    physicalCallCount: [run.physicalCallCount, expected.physicalCallCount],
    terminalStatus: [run.terminalStatus, expected.terminal.status],
  }
  for (const [field, [actual, recorded]] of Object.entries(fields))
    if (actual !== recorded) throw new Error(`packaged run ${field} does not match runtime evidence`)
  if (
    run.toolIDs.join("\n") !==
    expected.toolDefinitions
      .map((tool) => tool.toolID)
      .toSorted()
      .join("\n")
  )
    throw new Error("packaged run toolIDs do not match runtime evidence")
}
