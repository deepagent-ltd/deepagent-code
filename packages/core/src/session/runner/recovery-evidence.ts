export * as SessionRecoveryEvidence from "./recovery-evidence"

// C1B-08 / C1B-09 — external provider evidence verification (confirm_settled) and
// encrypted evidence export (export manifest).
//
// C1B-08 (`confirmSettled`): the frozen `RecoveryEvidence` is the ONLY acceptable
// form of external provider evidence. Free text is never evidence (design §9.2):
// `assertEvidenceTyped` + a typed decode refuse an evidence value that carries a
// free-text key or is not a valid typed `RecoveryEvidence`. The verdict is bound
// to the attempt through THREE independently verifiable facts:
//   1. the authoritative request hash (the wire request fingerprint the provider
//      echoes) equals G1's content-addressed `AttemptIdentity.requestHash`;
//   2. the idempotency key equals the attempt's;
//   3. the terminal payload hash equals the recorded terminal receipt payload
//      hash (the attempt's terminal row digest).
// plus a provider provenance pointer (`providerId`, `externalRequestId`,
// `retrievalRef`). All three must match, else a typed refusal.
//
// C1B-09 (`exportRecoveryEvidence`): the evidence set (commands + evidence +
// descriptor + manifest) is sealed as an AES-256-GCM artifact (a fresh random IV
// per export, same scheme as the C3 artifact store) and an export manifest is
// produced. The manifest is DEFAULT-REDACTED: it carries only hash/size/type/reason
// per item, never a prompt/tool/credential body, and the body is only revealed
// through the decrypt-and-verify permission gate (same-session actor, bounded
// expiry). Hash/refs are auditable: decrypt + recompute + compare.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { contentDigest } from "../../contract/digest"
import { RecoveryCommandContract } from "../../contract/recovery-command"
import { CanonicalJson } from "../../util/canonical-json"
import { Hash } from "../../util/hash"
import type {
  AttemptIdentity,
  CommandRecord,
  EncryptedEvidenceArtifact,
  EvidenceExportManifest,
  EvidenceExportSummaryItem,
  EvidenceRecord,
  RecoveryStoreState,
} from "./recovery-store"
import { DefaultEvidenceExportTtlMs } from "./recovery-store"

const Algorithm = "aes-256-gcm"
const IV_BYTES = 12

/** Re-export the bounded default export TTL (7 days) for callers/tests. */
export const EvidenceExportTtlMs = DefaultEvidenceExportTtlMs

// ---------------------------------------------------------------------------
// C1B-08 — confirm-settled evidence binding
// ---------------------------------------------------------------------------

/** The facts a confirm-settled verdict binds to the attempt. */
export type ConfirmSettledBinding = {
  readonly requestHash: string
  readonly providerId: string
  readonly idempotencyKey?: string
  /** The recorded terminal receipt payload hash (the attempt's terminal row digest). */
  readonly terminalPayloadHash: string
}

export type ConfirmSettledVerification =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason:
        | "terminal_state_not_settled"
        | "request_hash_mismatch"
        | "idempotency_key_mismatch"
        | "terminal_payload_hash_mismatch"
        | "provider_provenance_incomplete"
    }

/**
 * Validate external provider evidence against the attempt binding. Pure and
 * deterministic. A `RecoveryEvidence` that references a different request hash,
 * a missing/mismatched idempotency key, a mismatched terminal payload hash or an
 * incomplete provider provenance pointer is a typed refusal. All three hash/idempotency
 * facts must match for the verdict to be accepted.
 */
export function validateConfirmSettledEvidence(
  evidence: RecoveryCommandContract.RecoveryEvidence,
  binding: ConfirmSettledBinding,
): ConfirmSettledVerification {
  if (evidence.terminalState !== "settled") return { ok: false, reason: "terminal_state_not_settled" }
  if (evidence.responseFingerprint !== binding.requestHash) return { ok: false, reason: "request_hash_mismatch" }
  if (!binding.idempotencyKey || evidence.idempotencyKey !== binding.idempotencyKey) {
    return { ok: false, reason: "idempotency_key_mismatch" }
  }
  if (evidence.payloadHash !== binding.terminalPayloadHash) return { ok: false, reason: "terminal_payload_hash_mismatch" }
  if (evidence.providerId !== binding.providerId) return { ok: false, reason: "provider_provenance_incomplete" }
  if (evidence.externalRequestId.trim().length === 0 || evidence.retrievalRef.trim().length === 0) {
    return { ok: false, reason: "provider_provenance_incomplete" }
  }
  return { ok: true }
}

/**
 * Content-addressed evidence ref for a confirm-settled verdict. Deterministic over
 * the request hash + the attempt slot + the evidence (volatile `verifiedAt` is
 * stripped), so an exact retry of the same verdict converges on the SAME slot.
 */
export function confirmSettledEvidenceRef(input: {
  readonly requestHash: string
  readonly attempt: AttemptIdentity
  readonly evidence: RecoveryCommandContract.RecoveryEvidence
}): string {
  return `ev_${contentDigest({
    requestHash: input.requestHash,
    attempt: {
      sessionId: input.attempt.sessionId,
      attemptId: input.attempt.attemptId,
      providerId: input.attempt.providerId,
    },
    evidence: input.evidence,
  })}`
}

/** The recorded terminal receipt payload hash for a request, if any. */
export function terminalPayloadHashOf(state: RecoveryStoreState, requestHash: string): string | undefined {
  const record = [...state.evidence.values()].find((e) => e.requestHash === requestHash && e.payloadHash !== undefined)
  return record?.payloadHash
}

// ---------------------------------------------------------------------------
// C1B-09 — encrypted evidence export
// ---------------------------------------------------------------------------

/** The evidence set that gets sealed into the encrypted artifact. */
export type EvidenceExportSet = {
  readonly requestHash: string
  readonly attempt: AttemptIdentity
  readonly descriptor: RecoveryCommandContract.RecoveryDescriptor
  readonly commands: readonly CommandRecord[]
  readonly evidence: readonly EvidenceRecord[]
  readonly manifest: EvidenceExportManifest
}

/** Canonical plaintext payload sealed into the artifact (minus the manifest header). */
export function canonicalEvidenceExportPayload(input: Omit<EvidenceExportSet, "manifest">): string {
  return CanonicalJson.stringify({
    requestHash: input.requestHash,
    attempt: input.attempt,
    descriptor: input.descriptor,
    commands: input.commands.map((command) => ({
      commandId: command.commandId,
      requestHash: command.requestHash,
      attempt: {
        sessionId: command.attemptIdentity.sessionId,
        attemptId: command.attemptIdentity.attemptId,
        activityId: command.attemptIdentity.activityId,
        providerTurnSeq: command.attemptIdentity.providerTurnSeq,
        providerId: command.attemptIdentity.providerId,
      },
    })),
    evidence: input.evidence.map((record) => ({
      evidenceRef: record.evidenceRef,
      status: record.status,
      ...(record.requestHash ? { requestHash: record.requestHash } : {}),
      ...(record.payloadHash ? { payloadHash: record.payloadHash } : {}),
    })),
  })
}

/** Redacted summary items: hash/size/type/reason only — never prompt/tool/credential body. */
export function redactedSummary(input: {
  readonly requestHash: string
  readonly commands: readonly CommandRecord[]
  readonly evidence: readonly EvidenceRecord[]
  readonly descriptor: RecoveryCommandContract.RecoveryDescriptor
}): readonly EvidenceExportSummaryItem[] {
  const items: EvidenceExportSummaryItem[] = []
  // descriptor
  {
    const body = CanonicalJson.stringify(input.descriptor)
    items.push({
      kind: "descriptor",
      ref: input.requestHash,
      size: body.length,
      sha256: Hash.sha256(body),
      reason: "recovery_descriptor",
    })
  }
  for (const command of input.commands) {
    const body = CanonicalJson.stringify(command)
    items.push({
      kind: "command",
      ref: command.commandId,
      size: body.length,
      sha256: Hash.sha256(body),
      reason: "recovery_command",
    })
  }
  for (const record of input.evidence) {
    const body = CanonicalJson.stringify(record)
    items.push({
      kind: "evidence",
      ref: record.evidenceRef,
      size: body.length,
      sha256: Hash.sha256(body),
      reason: record.status,
    })
  }
  return items
}

/** Build the (redacted) export manifest for an evidence set. */
export function buildExportManifest(input: {
  readonly exportId: string
  readonly sessionId: string
  readonly attemptIds: readonly string[]
  readonly artifactRef: string
  readonly contentHash: string
  readonly actorType: "user" | "administrator" | "system"
  readonly actorId: string
  readonly summary: readonly EvidenceExportSummaryItem[]
  readonly now: number
  readonly ttlMs?: number
}): EvidenceExportManifest {
  const ttlMs = input.ttlMs ?? DefaultEvidenceExportTtlMs
  return {
    schemaVersion: "recovery-export-manifest.v1",
    exportId: input.exportId,
    target: { sessionId: input.sessionId, attemptIds: input.attemptIds },
    artifactRef: input.artifactRef,
    contentHash: input.contentHash,
    permission: {
      unlockActorType: input.actorType,
      unlockActorId: input.actorId,
      unlockSessionId: input.sessionId,
      crossSessionDenied: true,
    },
    redacted: true,
    summary: input.summary,
    issuedAt: input.now,
    expiresAt: input.now + ttlMs,
  }
}

/** AAD binding for an evidence artifact: binds the ciphertext to manifest identity + content hash. */
export function evidenceArtifactAAD(input: {
  readonly exportId: string
  readonly sessionId: string
  readonly artifactRef: string
  readonly contentHash: string
}): Uint8Array {
  return Buffer.from(
    CanonicalJson.stringify({
      schemaVersion: "recovery-export-artifact.v1",
      exportId: input.exportId,
      sessionId: input.sessionId,
      artifactRef: input.artifactRef,
      contentHash: input.contentHash,
    }),
  )
}

/** AES-256-GCM seal with a FRESH random IV per export (C3 scheme). */
export function encryptEvidenceArtifact(input: {
  readonly key: Uint8Array
  readonly plaintext: Uint8Array
  readonly aad: Uint8Array
}): { readonly iv: Uint8Array; readonly ciphertext: Uint8Array; readonly authTag: Uint8Array } {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(Algorithm, input.key, iv)
  cipher.setAAD(input.aad)
  const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()])
  return { iv, ciphertext, authTag: cipher.getAuthTag() }
}

/** AES-256-GCM open. A mismatched AAD/tag (tampered artifact or wrong manifest) throws. */
export function decryptEvidenceArtifact(input: {
  readonly key: Uint8Array
  readonly iv: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authTag: Uint8Array
  readonly aad: Uint8Array
}): string {
  const decipher = createDecipheriv(Algorithm, input.key, input.iv)
  decipher.setAAD(input.aad)
  decipher.setAuthTag(input.authTag)
  return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString("utf8")
}

/** Result of re-verifying an artifact against its manifest. */
export type ExportArtifactVerification =
  | { readonly ok: true; readonly contentHash: string }
  | { readonly ok: false; readonly reason: "content_hash_mismatch" | "aad_mismatch" | "expired" }

/**
 * Auditability: decrypt the artifact, recompute the content hash and compare. A
 * tampered manifest/artifact (different content, wrong AAD/tag, or expired) is a
 * typed mismatch. Pure + deterministic given the same artifact + key.
 */
export function verifyExportedArtifact(input: {
  readonly manifest: EvidenceExportManifest
  readonly artifact: EncryptedEvidenceArtifact
  readonly key: Uint8Array
  readonly now: number
}): ExportArtifactVerification {
  if (input.now > input.artifact.expiresAt || input.now > input.manifest.expiresAt) {
    return { ok: false, reason: "expired" }
  }
  if (
    input.artifact.contentHash !== input.manifest.contentHash ||
    input.artifact.exportId !== input.manifest.exportId ||
    input.artifact.artifactRef !== input.manifest.artifactRef
  ) {
    return { ok: false, reason: "content_hash_mismatch" }
  }
  let plaintext: string
  try {
    plaintext = decryptEvidenceArtifact({
      key: input.key,
      iv: input.artifact.iv,
      ciphertext: input.artifact.ciphertext,
      authTag: input.artifact.authTag,
      aad: evidenceArtifactAAD({
        exportId: input.manifest.exportId,
        sessionId: input.manifest.target.sessionId,
        artifactRef: input.manifest.artifactRef,
        contentHash: input.manifest.contentHash,
      }),
    })
  } catch {
    return { ok: false, reason: "aad_mismatch" }
  }
  const contentHash = Hash.sha256(Buffer.from(plaintext))
  if (contentHash !== input.manifest.contentHash) return { ok: false, reason: "content_hash_mismatch" }
  return { ok: true, contentHash }
}
