export * as RecoveryCommandContract from "./recovery-command"

import { Schema } from "effect"
import { contentDigest } from "./digest"

// C0-02 Phase 1 - Recovery command contract (freeze base)
// Design authority: docs/core-v2.0-beta/design.md §9.1-9.2 (provider unknown
// result and maintenance recovery): five descriptor classes, the command
// discriminant union, the evidence schema and the rule that free text is never
// acceptable as evidence (typed fields only).

/** Version matrix for the recovery command contract. */
export const RecoveryVersion = {
  command: "recovery-command.v1",
  descriptor: "recovery-descriptor.v1",
  evidence: "recovery-evidence.v1",
  descriptorKind: 1,
  commandKind: 1,
  terminal: 1,
  reasonCode: 1,
  providerState: 1,
} as const

/** Five descriptor classes (design §9.1). */
export const RecoveryDescriptorKind = Schema.Literals(["exact", "repairable", "fork", "coordination", "resolved"])
export type RecoveryDescriptorKind = typeof RecoveryDescriptorKind.Type

/** Command discriminant union (design §9.2). */
export const RecoveryCommandKind = Schema.Literals([
  "recover",
  "abandon_exact",
  "repair_baseline_and_abandon",
  "fork_from_safe_boundary",
  "confirm_settled",
  "query_command",
])
export type RecoveryCommandKind = typeof RecoveryCommandKind.Type

/** Terminal outcome of a resolution / bridge. */
export const RecoveryTerminal = Schema.Literals(["settled", "abandoned", "forked", "unknown"])
export type RecoveryTerminal = typeof RecoveryTerminal.Type

/** External provider evidence state (design §9.2, C1B-08). */
export const RecoveryProviderEvidenceState = Schema.Literals(["settled", "rejected", "unknown"])
export type RecoveryProviderEvidenceState = typeof RecoveryProviderEvidenceState.Type

/** Bounded reason code — never free text. */
export const RecoveryReasonCode = Schema.Literals([
  "network_unknown",
  "baseline_missing",
  "baseline_corrupt",
  "source_snapshot_unavailable",
  "provider_lookup_incomplete",
  "placement_unresolved",
  "workspace_conflict",
  "permission_incomplete",
  "history_unverified",
  "safe_boundary_none",
  "request_hash_mismatch",
  "cas_lost",
  "unsupported_state",
])
export type RecoveryReasonCode = typeof RecoveryReasonCode.Type

/** Who must coordinate a non-local resolution. */
export const RecoveryCoordinationActor = Schema.Literals(["admin", "external", "provider_lookup"])
export type RecoveryCoordinationActor = typeof RecoveryCoordinationActor.Type

/** Provenance of the descriptor source (design §9.1: never fabricate history). */
export const RecoveryProvenance = Schema.Struct({
  origin: Schema.Literals(["recorded", "reconstructed", "external"]),
  sourceRefs: Schema.Array(Schema.String),
  reconstructionRef: Schema.String.pipe(Schema.optional),
})
export type RecoveryProvenance = typeof RecoveryProvenance.Type

/** Baseline reference: the committed history baseline a descriptor can prove. */
export const RecoveryBaselineRef = Schema.Struct({
  baselineHash: Schema.String.pipe(Schema.optional),
  sourceSnapshotRef: Schema.String.pipe(Schema.optional),
  verified: Schema.Boolean,
})
export type RecoveryBaselineRef = typeof RecoveryBaselineRef.Type

/** Terminal bridge that links a recovery to its terminal authority. */
export const RecoveryTerminalBridge = Schema.Struct({
  bridgeId: Schema.String,
  bridgeType: Schema.String,
  terminalRef: Schema.String.pipe(Schema.optional),
})
export type RecoveryTerminalBridge = typeof RecoveryTerminalBridge.Type

/** CAS tokens used to fence a recovery write (design §9.2, C1B-11). */
export const RecoveryCasTokens = Schema.Struct({
  expectedState: Schema.String,
  expectedVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ownerToken: Schema.String,
})
export type RecoveryCasTokens = typeof RecoveryCasTokens.Type

const descriptorCommon = {
  schemaVersion: Schema.Literal(RecoveryVersion.descriptor),
  requestHash: Schema.String,
  provenance: RecoveryProvenance,
  baseline: RecoveryBaselineRef,
  terminalBridge: RecoveryTerminalBridge,
  casTokens: RecoveryCasTokens,
}

/** Descriptor: everything about an attempt is verifiable (design §9.1 resolvable_exact). */
export class ExactDescriptor extends Schema.Class<ExactDescriptor>("Recovery.ExactDescriptor")({
  ...descriptorCommon,
  descriptorKind: Schema.Literal("exact"),
  exact: Schema.Struct({
    attemptHash: Schema.String,
    selectionHash: Schema.String,
    historyHash: Schema.String,
    baselineHash: Schema.String,
    allVerified: Schema.Boolean,
  }),
}) {}

/** Descriptor: baseline is corrupt/missing but a trusted snapshot can be rebuilt (design §9.1 repairable_exact). */
export class RepairableDescriptor extends Schema.Class<RepairableDescriptor>("Recovery.RepairableDescriptor")({
  ...descriptorCommon,
  descriptorKind: Schema.Literal("repairable"),
  repairable: Schema.Struct({
    baselineState: Schema.Literals(["corrupt", "missing"]),
    sourceSnapshotRef: Schema.String,
    canReconstruct: Schema.Boolean,
  }),
}) {}

/** Descriptor: the original turn is unrecoverable but a safe boundary exists (design §9.1 fork_only). */
export class ForkDescriptor extends Schema.Class<ForkDescriptor>("Recovery.ForkDescriptor")({
  ...descriptorCommon,
  descriptorKind: Schema.Literal("fork"),
  fork: Schema.Struct({
    safeBoundaryRef: Schema.String,
    safeBoundaryHash: Schema.String,
    reasonCode: RecoveryReasonCode,
    originalSessionReadOnly: Schema.Boolean,
  }),
}) {}

/** Descriptor: local resolution is not provable and needs admin/external coordination (design §9.1). */
export class CoordinationDescriptor extends Schema.Class<CoordinationDescriptor>("Recovery.CoordinationDescriptor")({
  ...descriptorCommon,
  descriptorKind: Schema.Literal("coordination"),
  coordination: Schema.Struct({
    reason: RecoveryReasonCode,
    requiredActor: RecoveryCoordinationActor,
    evidenceExportRef: Schema.String.pipe(Schema.optional),
  }),
}) {}

/** Descriptor: a resolution/bridge/terminal is complete (design §9.1 resolved). */
export class ResolvedDescriptor extends Schema.Class<ResolvedDescriptor>("Recovery.ResolvedDescriptor")({
  ...descriptorCommon,
  descriptorKind: Schema.Literal("resolved"),
  resolved: Schema.Struct({
    resolutionRef: Schema.String,
    bridgeRef: Schema.String,
    terminal: RecoveryTerminal,
  }),
}) {}

/** Descriptor discriminant union (design §9.1). */
export const RecoveryDescriptor = Schema.Union([
  ExactDescriptor,
  RepairableDescriptor,
  ForkDescriptor,
  CoordinationDescriptor,
  ResolvedDescriptor,
])
export type RecoveryDescriptor = typeof RecoveryDescriptor.Type

/**
 * Evidence manifest (design §9.2). External provider evidence is carried as
 * typed, hash-addressed fields only: a provider id, external request id,
 * idempotency key, terminal state, payload hash, response fingerprint and
 * retrieval ref. There is deliberately no free-text body field — free text is
 * never acceptable as evidence (C1B-08).
 */
export class RecoveryEvidence extends Schema.Class<RecoveryEvidence>("Recovery.Evidence")({
  schemaVersion: Schema.Literal(RecoveryVersion.evidence),
  providerId: Schema.String,
  externalRequestId: Schema.String,
  idempotencyKey: Schema.String,
  terminalState: RecoveryProviderEvidenceState,
  payloadHash: Schema.String,
  responseFingerprint: Schema.String,
  retrievalRef: Schema.String,
  attestationRef: Schema.String.pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.String),
  verifiedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

const commandCommon = {
  schemaVersion: Schema.Literal(RecoveryVersion.command),
  commandId: Schema.String,
  sessionId: Schema.String,
  actorId: Schema.String,
  permissionFingerprint: Schema.String,
  expectedAttemptVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  requestedHash: Schema.String,
  decision: Schema.Literals(["proceed", "query_only"]),
  commandCreatedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}

/** Command: inspect or resolve following a descriptor. */
export class RecoverCommand extends Schema.Class<RecoverCommand>("Recovery.RecoverCommand")({
  ...commandCommon,
  commandKind: Schema.Literal("recover"),
  recover: Schema.Struct({
    descriptor: RecoveryDescriptor,
    intent: Schema.Literals(["resolve", "inspect"]),
  }),
}) {}

/** Command: abandon the exact attempt (design §9.2). */
export class AbandonExactCommand extends Schema.Class<AbandonExactCommand>("Recovery.AbandonExactCommand")({
  ...commandCommon,
  commandKind: Schema.Literal("abandon_exact"),
  abandonExact: Schema.Struct({
    descriptorRef: Schema.String,
    reasonCode: RecoveryReasonCode,
    acknowledgment: Schema.Boolean,
  }),
}) {}

/** Command: rebuild the baseline and abandon (design §9.2). */
export class RepairBaselineCommand extends Schema.Class<RepairBaselineCommand>("Recovery.RepairBaselineCommand")({
  ...commandCommon,
  commandKind: Schema.Literal("repair_baseline_and_abandon"),
  repairBaselineAndAbandon: Schema.Struct({
    descriptorRef: Schema.String,
    baselineHash: Schema.String,
    verificationHash: Schema.String,
  }),
}) {}

/** Command: fork from a proven safe boundary (design §9.2). */
export class ForkFromSafeBoundaryCommand extends Schema.Class<ForkFromSafeBoundaryCommand>(
  "Recovery.ForkFromSafeBoundaryCommand",
)({
  ...commandCommon,
  commandKind: Schema.Literal("fork_from_safe_boundary"),
  forkFromSafeBoundary: Schema.Struct({
    descriptorRef: Schema.String,
    safeBoundaryRef: Schema.String,
    forkManifestRef: Schema.String,
  }),
}) {}

/** Command: confirm settled with external provider evidence (design §9.2, C1B-08). */
export class ConfirmSettledCommand extends Schema.Class<ConfirmSettledCommand>("Recovery.ConfirmSettledCommand")({
  ...commandCommon,
  commandKind: Schema.Literal("confirm_settled"),
  confirmSettled: Schema.Struct({
    descriptorRef: Schema.String,
    evidence: RecoveryEvidence,
  }),
}) {}

/** Command: query a prior command by reference without creating a new one (design §9.2). */
export class QueryCommand extends Schema.Class<QueryCommand>("Recovery.QueryCommand")({
  ...commandCommon,
  commandKind: Schema.Literal("query_command"),
  queryCommand: Schema.Struct({
    commandRef: Schema.String,
  }),
}) {}

/** Command discriminant union (design §9.2). */
export const RecoveryCommand = Schema.Union([
  RecoverCommand,
  AbandonExactCommand,
  RepairBaselineCommand,
  ForkFromSafeBoundaryCommand,
  ConfirmSettledCommand,
  QueryCommand,
])
export type RecoveryCommand = typeof RecoveryCommand.Type

// ---- typed violations ------------------------------------------------------

/** Typed violation: an illegal command decodes when commandKind is unknown. */
export class RecoveryDecodeError extends Schema.TaggedErrorClass<RecoveryDecodeError>()(
  "Recovery.DecodeError",
  { message: Schema.String, path: Schema.Array(Schema.String) },
) {}

/** Typed violation: free text is never acceptable as evidence (design §9.2). */
export class FreeTextEvidenceError extends Schema.TaggedErrorClass<FreeTextEvidenceError>()(
  "Recovery.FreeTextEvidenceError",
  { reason: Schema.String },
) {}

export type RecoveryValidation =
  | { readonly ok: true; readonly value: RecoveryCommand }
  | { readonly ok: false; readonly error: RecoveryDecodeError }

function extractErrorPath(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const atIndex = message.indexOf("\n  at ")
  if (atIndex === -1) return []
  const lineStart = atIndex + 6
  const lineEnd = message.indexOf("\n", lineStart)
  const tail = lineEnd === -1 ? message.slice(lineStart) : message.slice(lineStart, lineEnd)
  const segments: string[] = []
  const re = /\[([^\]]*)\]/g
  let current: RegExpExecArray | null
  while ((current = re.exec(tail)) !== null) {
    const raw = current[1]!
    segments.push(raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw)
  }
  return segments
}

/** Decode a RecoveryCommand. Extra properties are rejected. */
export const decodeRecoveryCommand = (input: unknown): RecoveryCommand => {
  try {
    return Schema.decodeUnknownSync(RecoveryCommand, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new RecoveryDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Encode a RecoveryCommand to its schema-derived JSON shape. */
export const encodeRecoveryCommand = (value: RecoveryCommand): RecoveryCommand => Schema.encodeSync(RecoveryCommand)(value)

/** Non-throwing validation of a RecoveryCommand. */
export const validateRecoveryCommand = (input: unknown): RecoveryValidation => {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(RecoveryCommand, { onExcessProperty: "error" })(input) }
  } catch (error) {
    return {
      ok: false,
      error: new RecoveryDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) }),
    }
  }
}

/** Encode a single RecoveryDescriptor to its schema-derived JSON shape. */
export const encodeRecoveryDescriptor = (value: RecoveryDescriptor): RecoveryDescriptor => Schema.encodeSync(RecoveryDescriptor)(value)

/** Encode a single RecoveryEvidence to its schema-derived JSON shape. */
export const encodeRecoveryEvidence = (value: RecoveryEvidence): RecoveryEvidence => Schema.encodeSync(RecoveryEvidence)(value)

/** Decode a single RecoveryDescriptor. */
export const decodeRecoveryDescriptor = (input: unknown): RecoveryDescriptor => {
  try {
    return Schema.decodeUnknownSync(RecoveryDescriptor, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new RecoveryDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Decode a single RecoveryEvidence (typed fields only). */
export const decodeRecoveryEvidence = (input: unknown): RecoveryEvidence => {
  try {
    return Schema.decodeUnknownSync(RecoveryEvidence, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new RecoveryDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

// Free-text keys that are never acceptable as evidence. Presence of any of these
// is a typed `FreeTextEvidenceError` violation (design §9.2).
const FORBIDDEN_FREE_TEXT_KEYS = ["note", "notes", "description", "detail", "free_text", "evidence_text", "reason_text"]

/**
 * Enforce the "typed fields only" evidence rule. Throws `FreeTextEvidenceError`
 * if a value carries a free-text-as-evidence key; valid evidence is typed, hash
 * and ref-addressed and passes.
 */
export const assertEvidenceTyped = (evidence: RecoveryEvidence): void => {
  if (Object.keys(evidence).some((key) => FORBIDDEN_FREE_TEXT_KEYS.includes(key))) {
    throw new FreeTextEvidenceError({ reason: "free_text_evidence_is_forbidden" })
  }
}

/** Byte-stable canonical content digest of a RecoveryCommand (timestamp-independent). */
export const recoveryCommandDigest = (value: RecoveryCommand): string => contentDigest(value)

/** Byte-stable canonical content digest of a RecoveryDescriptor. */
export const recoveryDescriptorDigest = (value: RecoveryDescriptor): string => contentDigest(value)

/** Byte-stable canonical content digest of a RecoveryEvidence (timestamp-independent). */
export const recoveryEvidenceDigest = (value: RecoveryEvidence): string => contentDigest(value)
