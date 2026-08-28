export * as SessionProviderRecovery from "./recovery"

// C1B-01/02 — unified `SessionProviderRecovery` V2 recovery service + five-class descriptor.
//
// Design authority: docs/core-v2.0-beta/design.md §9 (provider unknown result &
// maintenance recovery: descriptor / command / evidence / safe exits; no automatic
// replay), §2.2 (durable receipt before dispatch; indeterminate is never auto-replayed),
// §2.3 (exact retry identity). Frozen contract: contract/recovery-command.ts (C0-02 —
// the discriminated union + request-hash semantics are AUTHORITATIVE and read-only).
//
// C1B-01: the single production resolve entry for a session's provider-unknown /
// indeterminate state. The legacy session_tool_request_receipt / prompt-epoch recovery
// path is reachable ONLY through the adapter, and the adapter never commits a successor
// epoch.
// C1B-02: the five-class descriptor (exact / repairable / fork / coordination / resolved)
// mapped onto the frozen contract vocabulary (resolvable_exact / repairable_exact /
// fork_only / coordination_required / resolved), each with the user exit + least-privilege
// permission requirement.
// C1B-04: `abandonExact` — abandon a classified `exact` attempt in ONE transaction with
// the command/evidence store's CAS semantics, with the network-unknown query-command-first
// refusal and same-tx-or-nothing crash behavior.
//
// Command / evidence store semantics live in ./recovery-store (C1B-03); this service owns
// the single-writer serialize + classify + authorize + command-record path.

import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Ref, Schema, Semaphore } from "effect"
import { RecoveryCommandContract } from "../../contract/recovery-command"
import { contentDigest } from "../../contract/digest"
import { Hash } from "../../util/hash"
import type {
  AbandonRecord,
  AbandonTransactionOutcome,
  AttemptIdentity,
  BaselineEvidence,
  BaselineFragment,
  BaselineRecord,
  BaselineReconstruction,
  BaselineVerificationOutcome,
  CommandRecord,
  CommandWriteOutcome,
  EncryptedEvidenceArtifact,
  EvidenceExportManifest,
  EvidenceRecord,
  EvidenceSettleOutcome,
  ForkManifest,
  ForkRecord,
  ForkTransactionOutcome,
  RecoveryStoreState,
  RepairAndAbandonOutcome,
} from "./recovery-store"
import {
  abandonAttemptKey,
  abandonTransaction,
  baselinesOf,
  commandCas,
  commandsOf,
  DefaultEvidenceExportTtlMs,
  emptyRecoveryStoreState,
  evidenceOf,
  evidenceSettleCas,
  exportsOf,
  evidenceArtifactsOf,
  forkManifestRef,
  forkTransaction,
  forksOf,
  readOnlySessionsOf,
  recoveryCommandContentAddress,
  repairAndAbandonTransaction,
  scanTerminalEvidence,
  verifyBaselineReconstruction,
} from "./recovery-store"
import { SessionRecoverySafeBoundary } from "./recovery-safe-boundary"
import {
  buildExportManifest,
  canonicalEvidenceExportPayload,
  confirmSettledEvidenceRef,
  decryptEvidenceArtifact,
  encryptEvidenceArtifact,
  evidenceArtifactAAD,
  redactedSummary,
  validateConfirmSettledEvidence,
  verifyExportedArtifact,
} from "./recovery-evidence"

// Re-export the store's value functions so consumers reach them through the service namespace.
export {
  abandonAttemptKey,
  abandonTransaction,
  commandCas,
  emptyRecoveryStoreState,
  evidenceSettleCas,
  forkManifestRef,
  recoveryCommandContentAddress,
  repairAndAbandonTransaction,
  verifyBaselineReconstruction,
} from "./recovery-store"

export * as SessionRecoverySafeBoundary from "./recovery-safe-boundary"
export * as SessionRecoveryEvidence from "./recovery-evidence"

// ---------------------------------------------------------------------------
// Attempt identity (C2-04 protocol identity where present)
// ---------------------------------------------------------------------------

export type { AttemptIdentity }

/** The five descriptor classes, mapped onto the frozen contract vocabulary. */
export type DescriptorKind = RecoveryCommandContract.RecoveryDescriptorKind

// ---------------------------------------------------------------------------
// User exit + least-privilege permission requirement (design §9.1, §9.3)
// ---------------------------------------------------------------------------

/** The actionable exit a recovery descriptor presents to a user. */
export const DescriptorAction = {
  resolvable_exact: "abandon",
  repairable_exact: "repair",
  fork_only: "fork",
  coordination_required: "coordinate",
  resolved: "refresh",
} as const
export type DescriptorAction = (typeof DescriptorAction)[keyof typeof DescriptorAction]

/**
 * Least-privilege permission required to invoke an exit. `abandon` of a verifiable
 * attempt is user-grade; `repair` (writes a reconstructed baseline) and `coordinate`
 * (export evidence / external authority) are administrator-grade; `fork` and `refresh`
 * are user-grade (design §9.3). The typed refusal never mutates state.
 */
export const DescriptorPermission = {
  resolvable_exact: "user",
  repairable_exact: "administrator",
  fork_only: "user",
  coordination_required: "administrator",
  resolved: "user",
} as const
export type DescriptorPermission = (typeof DescriptorPermission)[keyof typeof DescriptorPermission]

/** The user exit available for a descriptor class. */
export function exitFor(kind: DescriptorKind): DescriptorAction {
  return DescriptorAction[kind]
}

/** The permission required to invoke the exit for a descriptor class. */
export function requiredPermissionFor(kind: DescriptorKind): DescriptorPermission {
  return DescriptorPermission[kind]
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionProviderRecovery.NotFoundError", {}) {}
export class MismatchError extends Schema.TaggedErrorClass<MismatchError>()("SessionProviderRecovery.MismatchError", {
  reason: Schema.String,
}) {}
export class CasLostError extends Schema.TaggedErrorClass<CasLostError>()("SessionProviderRecovery.CasLostError", {
  reason: Schema.String,
}) {}
export class PermissionDeniedError extends Schema.TaggedErrorClass<PermissionDeniedError>()(
  "SessionProviderRecovery.PermissionDeniedError",
  { required: Schema.String, granted: Schema.String },
) {}
export class AdapterOutOfAuthorityError extends Schema.TaggedErrorClass<AdapterOutOfAuthorityError>()(
  // The typed result for invoking the legacy adapter: the adapter is a read-only
  // historical reader with no execution authority (design §2.1) and therefore can never
  // commit a successor epoch. Reaching this beyond read-only classification is a caller
  // defect, not a path.
  "SessionProviderRecovery.AdapterOutOfAuthorityError",
  { reason: Schema.String },
) {}
export class RecoveryDecodeError extends Schema.TaggedErrorClass<RecoveryDecodeError>()(
  "SessionProviderRecovery.RecoveryDecodeError",
  { message: Schema.String },
) {}
/**
 * Typed refusal for the network-unknown abandon path: a settled/terminal
 * provider evidence already exists for the request, so the attempt may have
 * dispatched and produced a result — the user is NOT offered abandon and is
 * pointed to confirm-settled instead (design §9.1 / §11.3 query-command-first).
 */
export class RefuseAbandonWithTerminalEvidenceError extends Schema.TaggedErrorClass<RefuseAbandonWithTerminalEvidenceError>()(
  "SessionProviderRecovery.RefuseAbandonWithTerminalEvidenceError",
  { evidenceRef: Schema.String, requestHash: Schema.String },
) {}
/**
 * C1B-11 typed conflict: MORE than one terminal (settled) row already exists for one
 * attempt. This is a duplicate-terminal data anomaly — the store must surface it as a
 * typed conflict naming the canonical row and NEVER as a raw defect that kills the
 * startup/data layer (design §10.7 "CAS lost 重读 canonical state 并返回 conflict/existing").
 */
export class DuplicateTerminalConflictError extends Schema.TaggedErrorClass<DuplicateTerminalConflictError>()(
  "SessionProviderRecovery.DuplicateTerminalConflictError",
  { evidenceRef: Schema.String, requestHash: Schema.String, duplicateRef: Schema.String },
) {}
/** Typed refusal for a transaction that was torn by a crash/simulated fault: no state was committed. */
export class RecoveryTransactionAbortedError extends Schema.TaggedErrorClass<RecoveryTransactionAbortedError>()(
  "SessionProviderRecovery.RecoveryTransactionAbortedError",
  { operation: Schema.String },
) {}
/** Typed refusal: a reconstructed baseline failed C1B-05 verification. */
export class BaselineVerifyRefusedError extends Schema.TaggedErrorClass<BaselineVerifyRefusedError>()(
  "SessionProviderRecovery.BaselineVerifyRefusedError",
  { reason: Schema.String },
) {}
/** Typed refusal: free text is never acceptable as external evidence (design §9.2, C1B-08). */
export class TextIsNotEvidenceError extends Schema.TaggedErrorClass<TextIsNotEvidenceError>()(
  "SessionProviderRecovery.TextIsNotEvidenceError",
  { reason: Schema.Literal("text_is_not_evidence") },
) {}
/** Typed refusal: no safe boundary exists before the first indeterminate turn (C1B-07). */
export class SafeBoundaryNoneError extends Schema.TaggedErrorClass<SafeBoundaryNoneError>()(
  "SessionProviderRecovery.SafeBoundaryNoneError",
  { reason: Schema.Literal("safe_boundary_none") },
) {}
/** Typed refusal: the original session is fenced read-only after a fork (C1B-07). */
export class SessionReadOnlyError extends Schema.TaggedErrorClass<SessionReadOnlyError>()(
  "SessionProviderRecovery.SessionReadOnlyError",
  { sessionId: Schema.String, reason: Schema.Literal("fork_fence") },
) {}
/** Typed refusal: an external evidence binding failed to verify (C1B-08). */
export class EvidenceBindingError extends Schema.TaggedErrorClass<EvidenceBindingError>()(
  "SessionProviderRecovery.EvidenceBindingError",
  {
    reason: Schema.Union([
      Schema.Literal("terminal_state_not_settled"),
      Schema.Literal("request_hash_mismatch"),
      Schema.Literal("idempotency_key_mismatch"),
      Schema.Literal("terminal_payload_hash_mismatch"),
      Schema.Literal("provider_provenance_incomplete"),
    ]),
  },
) {}
/** Typed refusal: no recorded terminal receipt payload hash to verify against (C1B-08). */
export class MissingTerminalEvidenceError extends Schema.TaggedErrorClass<MissingTerminalEvidenceError>()(
  "SessionProviderRecovery.MissingTerminalEvidenceError",
  { requestHash: Schema.String },
) {}
/** Typed refusal: an export manifest/artifact is unknown (C1B-09). */
export class ExportNotFoundError extends Schema.TaggedErrorClass<ExportNotFoundError>()(
  "SessionProviderRecovery.ExportNotFoundError",
  { exportId: Schema.String },
) {}
/** Typed refusal: a cross-session unlock of an evidence export (C1B-09). */
export class ExportCrossSessionDeniedError extends Schema.TaggedErrorClass<ExportCrossSessionDeniedError>()(
  "SessionProviderRecovery.ExportCrossSessionDeniedError",
  { exportId: Schema.String, requestedSessionId: Schema.String, ownerSessionId: Schema.String },
) {}
/** Typed refusal: an evidence export has passed its expiry (C1B-09). */
export class ExportExpiredError extends Schema.TaggedErrorClass<ExportExpiredError>()(
  "SessionProviderRecovery.ExportExpiredError",
  { exportId: Schema.String, expiredAt: Schema.Int },
) {}
/** Typed refusal: a tampered export manifest/artifact (C1B-09). */
export class ExportTamperError extends Schema.TaggedErrorClass<ExportTamperError>()(
  "SessionProviderRecovery.ExportTamperError",
  { exportId: Schema.String, reason: Schema.String },
) {}

export type Error =
  | NotFoundError
  | MismatchError
  | CasLostError
  | PermissionDeniedError
  | AdapterOutOfAuthorityError
  | RecoveryDecodeError
  | RefuseAbandonWithTerminalEvidenceError
  | DuplicateTerminalConflictError
  | RecoveryTransactionAbortedError
  | BaselineVerifyRefusedError
  | TextIsNotEvidenceError
  | SafeBoundaryNoneError
  | SessionReadOnlyError
  | EvidenceBindingError
  | MissingTerminalEvidenceError
  | ExportNotFoundError
  | ExportCrossSessionDeniedError
  | ExportExpiredError
  | ExportTamperError

export type {
  AbandonRecord,
  AbandonTransactionOutcome,
  BaselineEvidence,
  BaselineFragment,
  BaselineRecord,
  BaselineReconstruction,
  BaselineVerificationOutcome,
  CommandRecord,
  CommandWriteOutcome,
  EncryptedEvidenceArtifact,
  EvidenceExportManifest,
  EvidenceRecord,
  EvidenceSettleOutcome,
  ForkManifest,
  ForkRecord,
  ForkTransactionOutcome,
  RecoveryStoreState,
  RepairAndAbandonOutcome,
}

// ---------------------------------------------------------------------------
// Evidence store statuses — typed (pending / external / settled)
// ---------------------------------------------------------------------------

import type { EvidenceStatus } from "./recovery-store"
export type { EvidenceStatus }

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Everything the classifier needs to produce the frozen descriptor. Missing
 * verification is never fabricated: if a baseline hash / history hash is absent the
 * descriptor falls to `coordination_required` (or `fork_only` when a proven safe
 * boundary exists) rather than inventing a committed baseline (design §9.1).
 */
export type ClassifyInput = {
  readonly attempt: AttemptIdentity
  readonly attemptState: string
  readonly expectedAttemptState: string
  readonly ownerToken: string
  readonly expectedVersion: number
  readonly baseline?: {
    readonly baselineHash?: string
    readonly sourceSnapshotRef?: string
    readonly state?: "present" | "corrupt" | "missing"
    readonly verified: boolean
  }
  readonly safeBoundary?: {
    readonly safeBoundaryRef?: string
    readonly safeBoundaryHash?: string
  }
  readonly historyVerified: boolean
  readonly providerLookupComplete: boolean
  readonly placementUnresolved: boolean
  readonly permissionIncomplete: boolean
  readonly workspaceConflict: boolean
  readonly resolution?: {
    readonly resolutionRef: string
    readonly bridgeRef: string
    readonly terminal: RecoveryCommandContract.RecoveryTerminal
  }
}

function casTokens(input: ClassifyInput): RecoveryCommandContract.RecoveryCasTokens {
  return {
    expectedState: input.expectedAttemptState,
    expectedVersion: input.expectedVersion,
    ownerToken: input.ownerToken,
  }
}

function provenanceOf(input: ClassifyInput): RecoveryCommandContract.RecoveryProvenance {
  const sourceRefs: string[] = [input.attempt.attemptId]
  if (input.attempt.protocol) sourceRefs.push(`protocol:${input.attempt.protocol}`)
  return { origin: "recorded", sourceRefs }
}

function baselineOf(input: ClassifyInput): RecoveryCommandContract.RecoveryBaselineRef {
  return {
    ...(input.baseline?.baselineHash ? { baselineHash: input.baseline.baselineHash } : {}),
    ...(input.baseline?.sourceSnapshotRef ? { sourceSnapshotRef: input.baseline.sourceSnapshotRef } : {}),
    verified: input.baseline?.verified ?? false,
  }
}

function bridgeOf(input: ClassifyInput): RecoveryCommandContract.RecoveryTerminalBridge {
  if (!input.resolution) return { bridgeId: "none", bridgeType: "none" }
  return {
    bridgeId: input.resolution.bridgeRef,
    bridgeType: "terminal_bridge",
    terminalRef: input.resolution.terminal,
  }
}

/**
 * Synthesize a `RecoveryDescriptor` for an attempt. Pure and deterministic; the same
 * snapshot always yields the same descriptor. The five classes map exactly onto the
 * frozen contract vocabulary.
 *
 * Mapping (design §9.1 → contract vocabulary):
 *   exact        → `resolvable_exact`
 *   repairable   → `repairable_exact`
 *   fork         → `fork_only`
 *   coordination → `coordination_required`
 *   resolved     → `resolved`
 */
export function classify(input: ClassifyInput): RecoveryCommandContract.RecoveryDescriptor {
  if (input.resolution) {
    return {
      schemaVersion: "recovery-descriptor.v1",
      requestHash: input.attempt.requestHash,
      provenance: provenanceOf(input),
      baseline: baselineOf(input),
      terminalBridge: bridgeOf(input),
      casTokens: casTokens(input),
      descriptorKind: "resolved",
      resolved: {
        resolutionRef: input.resolution.resolutionRef,
        bridgeRef: input.resolution.bridgeRef,
        terminal: input.resolution.terminal,
      },
    }
  }

  const baselineState = input.baseline?.state ?? "present"
  const verifiable =
    input.baseline?.verified === true &&
    Boolean(input.baseline.baselineHash) &&
    input.historyVerified &&
    input.providerLookupComplete &&
    !input.placementUnresolved &&
    !input.permissionIncomplete &&
    !input.workspaceConflict

  if (baselineState === "present" && verifiable) {
    return {
      schemaVersion: "recovery-descriptor.v1",
      requestHash: input.attempt.requestHash,
      provenance: provenanceOf(input),
      baseline: baselineOf(input),
      terminalBridge: bridgeOf(input),
      casTokens: casTokens(input),
      descriptorKind: "resolvable_exact",
      exact: {
        attemptHash: input.attempt.projectionHash,
        selectionHash: input.attempt.selectionId,
        historyHash: input.baseline?.baselineHash ?? input.attempt.requestHash,
        baselineHash: input.baseline?.baselineHash ?? input.attempt.requestHash,
        allVerified: true,
      },
    }
  }

  if ((baselineState === "missing" || baselineState === "corrupt") && input.baseline?.sourceSnapshotRef) {
    return {
      schemaVersion: "recovery-descriptor.v1",
      requestHash: input.attempt.requestHash,
      provenance: provenanceOf(input),
      baseline: baselineOf(input),
      terminalBridge: bridgeOf(input),
      casTokens: casTokens(input),
      descriptorKind: "repairable_exact",
      repairable: {
        baselineState,
        sourceSnapshotRef: input.baseline.sourceSnapshotRef,
        canReconstruct: true,
      },
    }
  }

  if (input.safeBoundary?.safeBoundaryRef) {
    return {
      schemaVersion: "recovery-descriptor.v1",
      requestHash: input.attempt.requestHash,
      provenance: provenanceOf(input),
      baseline: baselineOf(input),
      terminalBridge: bridgeOf(input),
      casTokens: casTokens(input),
      descriptorKind: "fork_only",
      fork: {
        safeBoundaryRef: input.safeBoundary.safeBoundaryRef,
        safeBoundaryHash: input.safeBoundary.safeBoundaryHash ?? "",
        reasonCode: "safe_boundary_none",
        originalSessionReadOnly: true,
      },
    }
  }

  return {
    schemaVersion: "recovery-descriptor.v1",
    requestHash: input.attempt.requestHash,
    provenance: provenanceOf(input),
    baseline: baselineOf(input),
    terminalBridge: bridgeOf(input),
    casTokens: casTokens(input),
    descriptorKind: "coordination_required",
    coordination: {
      reason: coordinateReason(input),
      requiredActor: "admin",
      ...(input.baseline?.sourceSnapshotRef ? { evidenceExportRef: input.baseline.sourceSnapshotRef } : {}),
    },
  }
}

/** Pick the most specific frozen reason code for a coordination descriptor. */
function coordinateReason(input: ClassifyInput): RecoveryCommandContract.RecoveryReasonCode {
  if (input.baseline === undefined || input.baseline.state === "missing")
    return "baseline_missing" as RecoveryCommandContract.RecoveryReasonCode
  if (input.baseline.state === "corrupt") return "baseline_corrupt" as RecoveryCommandContract.RecoveryReasonCode
  if (!input.baseline.verified) return "history_unverified" as RecoveryCommandContract.RecoveryReasonCode
  if (!input.providerLookupComplete) return "provider_lookup_incomplete" as RecoveryCommandContract.RecoveryReasonCode
  if (input.placementUnresolved) return "placement_unresolved" as RecoveryCommandContract.RecoveryReasonCode
  if (input.permissionIncomplete) return "permission_incomplete" as RecoveryCommandContract.RecoveryReasonCode
  if (input.workspaceConflict) return "workspace_conflict" as RecoveryCommandContract.RecoveryReasonCode
  if (!input.safeBoundary) return "safe_boundary_none" as RecoveryCommandContract.RecoveryReasonCode
  return "unsupported_state" as RecoveryCommandContract.RecoveryReasonCode
}

// ---------------------------------------------------------------------------
// Permission guard
// ---------------------------------------------------------------------------

/** Typed permission refusal: the actor lacks the permission for the exit; no mutation. */
export function assertPermission(
  actor: { readonly type: "user" | "administrator" | "system" },
  required: DescriptorPermission,
): Effect.Effect<void, PermissionDeniedError> {
  const granted = actor.type === "administrator" ? "administrator" : actor.type === "user" ? "user" : "system"
  if (actor.type === "system") return Effect.fail(new PermissionDeniedError({ required, granted }))
  if (required === "administrator" && actor.type !== "administrator")
    return Effect.fail(new PermissionDeniedError({ required, granted }))
  return Effect.void
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type ResolveInput = {
  readonly sessionId: string
  readonly attemptId: string
  readonly actor: { readonly type: "user" | "administrator" | "system"; readonly id: string }
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly expectedAttemptState: string
  readonly ownerToken: string
  readonly expectedVersion: number
  readonly baseline?: ClassifyInput["baseline"]
  readonly safeBoundary?: ClassifyInput["safeBoundary"]
  readonly historyVerified?: boolean
  readonly providerLookupComplete?: boolean
  readonly placementUnresolved?: boolean
  readonly permissionIncomplete?: boolean
  readonly workspaceConflict?: boolean
}

export type ResolveOutcome = {
  readonly descriptor: RecoveryCommandContract.RecoveryDescriptor
  readonly commandId: string
  readonly author: { readonly actorType: "user" | "administrator" | "system"; readonly actorId: string }
}

/** C1B-04 input: abandon a classified `exact` attempt. */
export type AbandonExactInput = {
  readonly actor: { readonly type: "user" | "administrator" | "system"; readonly id: string }
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly reasonCode: RecoveryCommandContract.RecoveryReasonCode
  /** Test seam: inject a crash at a commit boundary to prove same-tx or nothing. */
  readonly fault?: { readonly at: "after_command_stage" }
}

/** C1B-06 input: repair the baseline rows AND abandon the attempt atomically. */
export type RepairBaselineAndAbandonInput = {
  readonly actor: { readonly type: "user" | "administrator" | "system"; readonly id: string }
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly baselineRef: string
  readonly evidence: BaselineEvidence
  readonly fragments: readonly BaselineFragment[]
  readonly reasonCode: RecoveryCommandContract.RecoveryReasonCode
  /** Test seam: inject a crash between the repair and abandon stages. */
  readonly fault?: { readonly at: "after_repair_stage" }
}

/** C1B-07 input: fork a new session from a proven safe boundary. */
export type ForkFromSafeBoundaryInput = {
  readonly actor: { readonly type: "user" | "administrator" | "system"; readonly id: string }
  readonly sourceSessionId: string
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly history: readonly SessionRecoverySafeBoundary.SafeBoundaryMessage[]
  /** Optional cross-check: if provided and not the found safe boundary, a typed refusal. */
  readonly boundaryMessageId?: string
  /** Caller-supplied fork session id (converges an exact retry on the SAME fork). */
  readonly forkSessionId?: string
  readonly now?: number
  /** Test seam: inject a crash between the fork-manifest build and the fork+fence commit. */
  readonly fault?: { readonly at: "after_fork_stage" }
}

/** C1B-07 outcome: forked, existing (exact retry, no second fork), or a typed conflict. */
export type ForkFromSafeBoundaryOutcome =
  | { readonly status: "forked"; readonly forkRef: string; readonly manifest: ForkManifest; readonly forkSessionId: string; readonly commandId: string }
  | { readonly status: "existing"; readonly forkRef: string; readonly manifest: ForkManifest; readonly forkSessionId: string }
  | { readonly status: "conflict"; readonly reason: "already_forked" | "fork_mismatch" | "boundary_mismatch" }

/** C1B-08 input: confirm an attempt settled with external provider evidence. */
export type ConfirmSettledInput = {
  readonly actor: { readonly type: "user" | "administrator" | "system"; readonly id: string }
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  /** Decoded as a frozen `RecoveryEvidence`; free text is refused (typed). */
  readonly evidence: unknown
  readonly now?: number
  /** Test seam: inject a crash between the settled-verdict CAS and the evidence commit. */
  readonly fault?: { readonly at: "after_evidence_stage" }
}

/** C1B-08 outcome: settled, existing (idempotent verdict), or a typed conflict. */
export type ConfirmSettledOutcome =
  | { readonly status: "settled"; readonly evidenceRef: string }
  | { readonly status: "existing"; readonly evidenceRef: string }
  | { readonly status: "conflict"; readonly evidenceRef: string; readonly reason: "evidence_request_hash_mismatch" | "evidence_payload_mismatch" }

/** C1B-09 input: export the recovery evidence set as an encrypted artifact + manifest. */
export type ExportRecoveryEvidenceInput = {
  readonly actor: { readonly type: "user" | "administrator" | "system"; readonly id: string }
  readonly sessionId: string
  readonly attemptIdentity: AttemptIdentity
  readonly requestHash: string
  readonly classifyInput: ClassifyInput
  /** AES-256-GCM key (32 bytes) and its keyId (the production caller owns the key material). */
  readonly encryptionKey: Uint8Array
  readonly keyId: string
  readonly exportId?: string
  readonly now?: number
  readonly ttlMs?: number
}

/** C1B-09 outcome: the export manifest + artifact reference. */
export type ExportRecoveryEvidenceOutcome = {
  readonly exportId: string
  readonly artifactRef: string
  readonly contentHash: string
  readonly manifest: EvidenceExportManifest
}

/** C1B-09 input: unlock a previously-exported evidence artifact. */
export type UnlockRecoveryEvidenceInput = {
  readonly actor: { readonly type: "user" | "administrator" | "system"; readonly id: string }
  /** The requesting session — must be the SAME session that owns the export. */
  readonly sessionId: string
  readonly exportId: string
  readonly encryptionKey: Uint8Array
  readonly now?: number
}

/** C1B-09 outcome: unlocked payload (evidence set), or a typed redaction/expiry/tamper. */
export type UnlockRecoveryEvidenceOutcome = {
  readonly exportId: string
  readonly contentHash: string
  readonly payload: string
  readonly manifest: EvidenceExportManifest
}

export interface Interface {
  /** Classify a single attempt into the five-class frozen descriptor (pure). */
  readonly classify: (input: ClassifyInput) => RecoveryCommandContract.RecoveryDescriptor
  /**
   * Single production resolve entry. Serialized per (session, attempt) so two concurrent
   * resolves return the SAME typed result with one classify and one command write. Never
   * replays a provider request (design §2.2).
   */
  readonly resolve: (input: ResolveInput) => Effect.Effect<ResolveOutcome, Error>
  /** Record a recovery command; concurrent same-attempt writes serialize & CAS. */
  readonly recordCommand: (input: {
    readonly requestHash: string
    readonly attemptIdentity: AttemptIdentity
    /** Test seam: inject a crash between the command CAS and the command commit. */
    readonly fault?: { readonly at: "after_command_stage" }
  }) => Effect.Effect<CommandWriteOutcome, Error>
  /** Read a command record by content address. */
  readonly getCommand: (commandId: string) => Effect.Effect<CommandRecord | undefined>
  /**
   * Query a prior command / evidence by exact request hash + attempt identity
   * WITHOUT creating a new command (design §9.2 query_command). The network
   * unknown flow's FIRST step: if a settled/terminal evidence exists for the
   * request, abandon is refused (see `abandonExact`).
   */
  readonly queryCommand: (input: {
    readonly requestHash: string
    readonly attemptIdentity: AttemptIdentity
  }) => Effect.Effect<{ readonly command?: CommandRecord; readonly evidence: readonly EvidenceRecord[] }>
  /** Read the abandon record for an attempt (typed absent/undefined if never abandoned). */
  readonly queryAbandon: (attemptIdentity: AttemptIdentity) => Effect.Effect<AbandonRecord | undefined>
  /**
   * C1B-04: abandon a classified `exact` attempt, recording the abandon decision,
   * the terminal receipt and the command — ALL in one transaction with the
   * store's CAS semantics (one command wins; CAS-lost -> typed existing/conflict).
   * Same-transaction or nothing: a crash mid-abandon commits no half-state. An
   * already-abandoned attempt with the same request hash -> typed `existing`
   * (exact retry never duplicates / no double effect). The network-unknown path
   * is refused when a settled/terminal evidence already exists.
   */
  readonly abandonExact: (input: AbandonExactInput) => Effect.Effect<AbandonTransactionOutcome, Error>
  /**
   * C1B-05: verify a reconstructed baseline. Pure and deterministic; only an
   * exact match against a committed hash with unbroken provenance is accepted.
   * A missing hash/provenance, a hash mismatch or a broken parent chain is a
   * typed refusal — history is never fabricated from current state.
   */
  readonly verifyBaselineReconstruction: (input: {
    readonly reconstruction: BaselineReconstruction
    readonly evidence?: BaselineEvidence
  }) => BaselineVerificationOutcome
  /** Read a repaired baseline record by its ref. */
  readonly queryBaseline: (baselineRef: string) => Effect.Effect<BaselineRecord | undefined>
  /**
   * C1B-06: repair the baseline rows AND abandon the attempt in ONE atomic
   * transaction. C1B-05 verification MUST pass first (else no repair and no
   * abandon); the repair write is hash-committed; a CAS-lost baseline with
   * legally-different data is never clobbered; a crash between the repair and
   * abandon stages rolls back both.
   */
  readonly repairBaselineAndAbandon: (input: RepairBaselineAndAbandonInput) => Effect.Effect<RepairAndAbandonOutcome, Error>
  /** Evidence store: typed statuses (pending / external / settled); body is C1B-08. */
  readonly evidence: {
    readonly recordStatus: (input: {
      readonly evidenceRef: string
      readonly status: EvidenceStatus
      readonly providerId?: string
      readonly requestHash?: string
      readonly payloadHash?: string
    }) => Effect.Effect<void, Error>
    readonly getStatus: (evidenceRef: string) => Effect.Effect<EvidenceRecord | undefined>
  }
  /**
   * C1B-07: find the safe boundary in a session history. Pure and deterministic;
   * an unknown-result assistant/tool turn is never a boundary and the boundary is
   * always BEFORE the first indeterminate turn.
   */
  readonly findSafeBoundary: (history: readonly SessionRecoverySafeBoundary.SafeBoundaryMessage[]) => SessionRecoverySafeBoundary.SafeBoundary
  /**
   * C1B-07: fork a new session from a proven safe boundary. The new session's
   * history is the messages THROUGH the boundary ONLY (never copies an
   * unknown-result assistant/tool turn); the original session is fenced READ-ONLY
   * (write/tool/providing ops are refused through `assertSessionWritable`); the
   * fork manifest is complete and deterministic. An exact retry for the same
   * boundary -> typed `existing`, no second fork.
   */
  readonly forkFromSafeBoundary: (input: ForkFromSafeBoundaryInput) => Effect.Effect<ForkFromSafeBoundaryOutcome, Error>
  /** Read a fork record by its source session (the read-only fence evidence). */
  readonly queryFork: (sourceSessionId: string) => Effect.Effect<ForkRecord | undefined>
  /** Whether a session is fenced read-only after a fork. */
  readonly isSessionReadOnly: (sessionId: string) => Effect.Effect<boolean>
  /**
   * C1B-07 guard: refuse a write/tool/providing op on a forked (read-only) session.
   * After a fork the original session may be read but not written. No mutation on refusal.
   */
  readonly assertSessionWritable: (sessionId: string) => Effect.Effect<void, Error>
  /**
   * C1B-08: confirm an attempt settled with EXTERNAL provider evidence. The verdict
   * is valid only when the authoritative request hash, idempotency key and terminal
   * payload hash all match the attempt binding AND a provider provenance pointer is
   * present; free text is refused (typed). The verdict persists in the evidence
   * store with a typed status transition via the store's CAS (CAS-lost -> existing).
   */
  readonly confirmSettled: (input: ConfirmSettledInput) => Effect.Effect<ConfirmSettledOutcome, Error>
  /**
   * C1B-09: export the recovery evidence set as an ENCRYPTED artifact (AES-256-GCM,
   * fresh random IV per export) + a DEFAULT-REDACTED export manifest (hash/size/
   * type/reason only; the body is behind a permission gate: same-session actor,
   * bounded default 7-day expiry). Hash/refs are auditable — see `unlockRecoveryEvidence`.
   */
  readonly exportRecoveryEvidence: (input: ExportRecoveryEvidenceInput) => Effect.Effect<ExportRecoveryEvidenceOutcome, Error>
  /** Read an export manifest by export id (redacted; the body stays behind the gate). */
  readonly queryExport: (exportId: string) => Effect.Effect<EvidenceExportManifest | undefined>
  /**
   * C1B-09: unlock a previously-exported evidence artifact. Decrypt + recompute +
   * compare for auditability; a cross-session unlock, an expired export or a
   * tampered manifest/artifact is a typed refusal.
   */
  readonly unlockRecoveryEvidence: (input: UnlockRecoveryEvidenceInput) => Effect.Effect<UnlockRecoveryEvidenceOutcome, Error>
  /** Legacy adapter: read-only historical reader, never a successor-epoch writer. */
  readonly adapter: {
    readonly classifyLegacy: (input: { readonly receiptId: string }) => {
      readonly descriptor: RecoveryCommandContract.RecoveryDescriptor
      readonly outOfAuthority: true
    }
  }
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SessionProviderRecovery") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Single-writer CAS authority over the composite recovery store. One permit
    // serializes every command write, resolve and recovery transaction (design §2.1 —
    // no distributed owner before clustering). All domains a transaction mutates
    // (commands, evidence, abandons) live in one state so a crash commits all-or-nothing.
    const store = yield* Ref.make(emptyRecoveryStoreState())
    const lock = yield* Semaphore.make(1)
    const resolveCache = yield* Ref.make(new Map<string, ResolveOutcome>())

    const resolve = Effect.fn("SessionProviderRecovery.resolve")(function* (input: ResolveInput) {
      const key = `${input.sessionId}:${input.attemptId}`
      return yield* Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          const cached = yield* Ref.get(resolveCache)
          if (cached.has(key)) return cached.get(key)!
          const outcome = yield* resolveOnce(input)
          yield* Ref.update(resolveCache, (map) => new Map(map).set(key, outcome))
          return outcome
        }),
      )
    })

    // Immutable-command write helper. All mutation of the composite store is
    // serialized by `lock`, and a transaction commits by swapping a fully-built
    // next state (see abandonExact) so a crash can never leave a torn half-application.
    const setCommand = (state: RecoveryStoreState, commandId: string, record: CommandRecord): Effect.Effect<void> =>
      Ref.set(store, { ...state, commands: new Map(state.commands).set(commandId, record) })

    const resolveOnce = (input: ResolveInput): Effect.Effect<ResolveOutcome, Error> =>
      Effect.gen(function* () {
        const descriptor = classify({
          attempt: input.attemptIdentity,
          attemptState: "indeterminate_after_crash",
          expectedAttemptState: input.expectedAttemptState,
          ownerToken: input.ownerToken,
          expectedVersion: input.expectedVersion,
          ...(input.baseline ? { baseline: input.baseline } : {}),
          ...(input.safeBoundary ? { safeBoundary: input.safeBoundary } : {}),
          historyVerified: input.historyVerified ?? true,
          providerLookupComplete: input.providerLookupComplete ?? true,
          placementUnresolved: input.placementUnresolved ?? false,
          permissionIncomplete: input.permissionIncomplete ?? false,
          workspaceConflict: input.workspaceConflict ?? false,
        })
        const state = yield* Ref.get(store)
        const write = commandCas(commandsOf(state), {
          requestHash: input.requestHash,
          attemptIdentity: input.attemptIdentity,
        })
        if (write.status === "recorded") yield* setCommand(state, write.commandId, write.record)
        return {
          descriptor,
          commandId: write.commandId,
          author: { actorType: input.actor.type, actorId: input.actor.id },
        }
      })

    const recordCommand = Effect.fn("SessionProviderRecovery.recordCommand")(function* (input: {
      readonly requestHash: string
      readonly attemptIdentity: AttemptIdentity
      readonly fault?: { readonly at: "after_command_stage" }
    }) {
      return yield* Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          const state = yield* Ref.get(store)
          const write = commandCas(commandsOf(state), input)
          // C1B-12 crash seam: a crash injected when the command WOULD be newly recorded aborts the
          // commit (nothing is written); an idempotent existing/mismatch write changes no state so
          // it needs no crash seam.
          if (input.fault?.at === "after_command_stage" && write.status === "recorded") {
            return yield* Effect.fail(new RecoveryTransactionAbortedError({ operation: "record_command" }))
          }
          if (write.status === "recorded") yield* setCommand(state, write.commandId, write.record)
          return write
        }),
      )
    })

    const getCommand = Effect.fn("SessionProviderRecovery.getCommand")(function* (commandId: string) {
      const state = yield* Ref.get(store)
      return commandsOf(state).get(commandId)
    })

    const evidence = {
      recordStatus: Effect.fn("SessionProviderRecovery.evidence.recordStatus")(function* (input: {
        readonly evidenceRef: string
        readonly status: EvidenceStatus
        readonly providerId?: string
        readonly requestHash?: string
        readonly payloadHash?: string
      }) {
        const record: EvidenceRecord = {
          evidenceRef: input.evidenceRef,
          status: input.status,
          ...(input.providerId ? { providerId: input.providerId } : {}),
          ...(input.requestHash ? { requestHash: input.requestHash } : {}),
          ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
          recordedAt: Date.now(),
        }
        const state = yield* Ref.get(store)
        // C1B-11: a status write to an existing slot is an EXACT idempotent no-op when every
        // identity field matches; any divergence is a typed conflict (never a silent overwrite
        // of recorded evidence / never a raw defect).
        const prior = state.evidence.get(input.evidenceRef)
        if (prior) {
          const same =
            prior.status === record.status &&
            prior.providerId === record.providerId &&
            prior.requestHash === record.requestHash &&
            prior.payloadHash === record.payloadHash
          if (same) return undefined
          return yield* Effect.fail(new MismatchError({ reason: "evidence_status_divergence" }))
        }
        yield* Ref.set(store, { ...state, evidence: new Map(state.evidence).set(input.evidenceRef, record) })
      }),
      getStatus: (evidenceRef: string) => Effect.map(Ref.get(store), (state) => evidenceOf(state).get(evidenceRef)),
    }

    const adapter: { readonly classifyLegacy: (input: { readonly receiptId: string }) => {
      readonly descriptor: RecoveryCommandContract.RecoveryDescriptor
      readonly outOfAuthority: true
    } } = {
      classifyLegacy: (input: { readonly receiptId: string }) => {
        // Legacy receipts are read-only historical evidence. The adapter is out of
        // authority: it only classifies (always to `coordination` — legacy provenance can
        // never be proven locally) and never writes a successor epoch.
        return {
          descriptor: classify({
            attempt: {
              sessionId: "",
              attemptId: input.receiptId,
              activityId: "",
              providerTurnSeq: 0,
              selectionId: "",
              projectionHash: "",
              requestHash: "",
              providerId: "",
            },
            attemptState: "indeterminate_after_crash",
            expectedAttemptState: "indeterminate_after_crash",
            ownerToken: "",
            expectedVersion: 0,
            historyVerified: false,
            providerLookupComplete: false,
            placementUnresolved: false,
            permissionIncomplete: false,
            workspaceConflict: false,
          }),
          outOfAuthority: true,
        }
      },
    }

    const queryCommand = Effect.fn("SessionProviderRecovery.queryCommand")(function* (input: {
      readonly requestHash: string
      readonly attemptIdentity: AttemptIdentity
    }) {
      const state = yield* Ref.get(store)
      const address = recoveryCommandContentAddress({
        requestHash: input.requestHash,
        attemptIdentity: input.attemptIdentity,
      })
      return {
        command: commandsOf(state).get(address),
        // Evidence is matched by exact request hash (query-by-hash). A settled/terminal
        // evidence is the "may have dispatched" signal that blocks abandon (design §9.1).
        evidence: [...evidenceOf(state).values()].filter((e) => e.requestHash === input.requestHash),
      }
    })

    const queryAbandon = Effect.fn("SessionProviderRecovery.queryAbandon")(function* (attemptIdentity: AttemptIdentity) {
      const state = yield* Ref.get(store)
      return state.abandons.get(abandonAttemptKey(attemptIdentity))
    })

    const abandonExact = Effect.fn("SessionProviderRecovery.abandonExact")(function* (input: AbandonExactInput) {
      return yield* Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          // Least-privilege exit: abandon of a verifiable attempt is user-grade.
          yield* assertPermission(input.actor, requiredPermissionFor("resolvable_exact"))
          const state = yield* Ref.get(store)
          // Network-unknown-after-dispatch: the FIRST step is query-command. If a
          // settled/terminal provider evidence exists the attempt may have dispatched and
          // produced a result, so the user is NOT offered abandon (design §11.3 / §9.2).
          // A duplicate terminal (two settled rows for one attempt) is a typed conflict
          // naming the canonical row — never a raw defect (C1B-11).
          const scan = scanTerminalEvidence(evidenceOf(state), input.requestHash)
          if (scan.status === "duplicate") {
            return yield* Effect.fail(
              new DuplicateTerminalConflictError({
                evidenceRef: scan.canonical.evidenceRef,
                requestHash: input.requestHash,
                duplicateRef: scan.duplicate.evidenceRef,
              }),
            )
          }
          if (scan.status === "single") {
            return yield* Effect.fail(
              new RefuseAbandonWithTerminalEvidenceError({
                evidenceRef: scan.canonical.evidenceRef,
                requestHash: input.requestHash,
              }),
            )
          }
          const tx = abandonTransaction(
            state,
            {
              requestHash: input.requestHash,
              attemptIdentity: input.attemptIdentity,
              actorType: input.actor.type,
              actorId: input.actor.id,
              reasonCode: input.reasonCode,
            },
            input.fault,
          )
          if (tx.status === "aborted") {
            return yield* Effect.fail(new RecoveryTransactionAbortedError({ operation: "abandon_exact" }))
          }
          // Same-transaction or nothing: only a committed transaction swaps the store.
          yield* Ref.set(store, tx.state)
          return tx.outcome
        }),
      )
    })

    const queryBaseline = Effect.fn("SessionProviderRecovery.queryBaseline")(function* (baselineRef: string) {
      const state = yield* Ref.get(store)
      return baselinesOf(state).get(baselineRef)
    })

    const repairBaselineAndAbandon = Effect.fn("SessionProviderRecovery.repairBaselineAndAbandon")(function* (
      input: RepairBaselineAndAbandonInput,
    ) {
      return yield* Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          // Repair writes a reconstructed baseline — administrator-grade exit.
          yield* assertPermission(input.actor, requiredPermissionFor("repairable_exact"))
          // C1B-05 MUST pass first: never repair without a committed hash/provenance.
          const verified = verifyBaselineReconstruction({
            reconstruction: { fragments: input.fragments },
            evidence: input.evidence,
          })
          if (verified.status !== "verified") {
            return yield* Effect.fail(new BaselineVerifyRefusedError({ reason: verified.reason }))
          }
          const state = yield* Ref.get(store)
          const tx = repairAndAbandonTransaction(
            state,
            {
              requestHash: input.requestHash,
              attemptIdentity: input.attemptIdentity,
              baselineRef: input.baselineRef,
              evidence: input.evidence,
              fragments: input.fragments,
              actorType: input.actor.type,
              actorId: input.actor.id,
              reasonCode: input.reasonCode,
            },
            input.fault,
          )
          if (tx.status === "aborted") {
            return yield* Effect.fail(new RecoveryTransactionAbortedError({ operation: "repair_baseline_and_abandon" }))
          }
          // Repair + abandon + command are committed together (no torn third state).
          yield* Ref.set(store, tx.state)
          return tx.outcome
        }),
      )
    })

    // C1B-07: safe-boundary finder (pure) + fork.
    const findSafeBoundary = (history: readonly SessionRecoverySafeBoundary.SafeBoundaryMessage[]) =>
      SessionRecoverySafeBoundary.findSafeBoundary(history)

    const forkFromSafeBoundary = Effect.fn("SessionProviderRecovery.forkFromSafeBoundary")(function* (
      input: ForkFromSafeBoundaryInput,
    ) {
      return yield* Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          // Least-privilege: fork creates a NEW session (no source side effect) and fences the
          // source read-only — user-grade exit (design §9.3 "安全新会话").
          yield* assertPermission(input.actor, requiredPermissionFor("fork_only"))
          const safe = SessionRecoverySafeBoundary.findSafeBoundary(input.history)
          if (safe.status === "none") {
            return yield* Effect.fail(new SafeBoundaryNoneError({ reason: "safe_boundary_none" }))
          }
          if (input.boundaryMessageId !== undefined && input.boundaryMessageId !== safe.boundaryMessageId) {
            return yield* Effect.fail(new MismatchError({ reason: "boundary_mismatch" }))
          }
          const boundary = safe.confirmedThrough
          const boundaryHash = contentDigest({ id: boundary.id, seq: boundary.seq, kind: boundary.kind })
          const forkSessionId = input.forkSessionId ?? `fork_${randomUUID()}`
          const state = yield* Ref.get(store)
          const tx = forkTransaction(state, {
            sourceSessionId: input.sourceSessionId,
            requestHash: input.requestHash,
            attemptIdentity: input.attemptIdentity,
            boundaryMessageId: safe.boundaryMessageId,
            boundaryIndex: safe.boundaryIndex,
            boundaryHash,
            copiedMessageIds: safe.copiedMessages.map((message) => message.id),
            excludedIndeterminateTurns: safe.excludedTurns,
            copiedWindowHash: safe.hashedWindow,
            actorType: input.actor.type,
            actorId: input.actor.id,
            permission: requiredPermissionFor("fork_only"),
            forkSessionId,
            now: input.now,
          }, input.fault)
          if (tx.status === "aborted") {
            return yield* Effect.fail(new RecoveryTransactionAbortedError({ operation: "fork_from_safe_boundary" }))
          }
          // Fork + read-only fence + command are committed together (no torn half-state).
          yield* Ref.set(store, tx.state)
          if (tx.outcome.status === "conflict") return tx.outcome
          const commandId = recoveryCommandContentAddress({
            requestHash: input.requestHash,
            attemptIdentity: input.attemptIdentity,
          })
          if (tx.outcome.status === "existing") {
            const existing: ForkFromSafeBoundaryOutcome = {
              status: "existing",
              forkRef: tx.outcome.forkRef,
              manifest: tx.outcome.manifest,
              forkSessionId: tx.outcome.manifest.forkSessionId,
            }
            return existing
          }
          const forked: ForkFromSafeBoundaryOutcome = {
            status: "forked",
            forkRef: tx.outcome.forkRef,
            manifest: tx.outcome.manifest,
            forkSessionId: tx.outcome.manifest.forkSessionId,
            commandId,
          }
          return forked
        }),
      )
    })

    const queryFork = Effect.fn("SessionProviderRecovery.queryFork")(function* (sourceSessionId: string) {
      const state = yield* Ref.get(store)
      const fence = readOnlySessionsOf(state).get(sourceSessionId)
      if (!fence) return undefined
      return forksOf(state).get(fence.forkRef)
    })

    const isSessionReadOnly = Effect.fn("SessionProviderRecovery.isSessionReadOnly")(function* (sessionId: string) {
      const state = yield* Ref.get(store)
      return readOnlySessionsOf(state).has(sessionId)
    })

    const assertSessionWritable = Effect.fn("SessionProviderRecovery.assertSessionWritable")(function* (sessionId: string) {
      const state = yield* Ref.get(store)
      if (readOnlySessionsOf(state).has(sessionId)) {
        return yield* Effect.fail(new SessionReadOnlyError({ sessionId, reason: "fork_fence" }))
      }
      return undefined
    })

    // C1B-08: confirm settled with external provider evidence.
    const confirmSettled = Effect.fn("SessionProviderRecovery.confirmSettled")(function* (input: ConfirmSettledInput) {
      return yield* Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          // Confirm-settled is the other resolvable_exact exit (with provider evidence), so it is
          // user-grade like abandon (design §9.1, §9.3).
          yield* assertPermission(input.actor, requiredPermissionFor("resolvable_exact"))
          // Free text is never evidence (design §9.2): decode the typed RecoveryEvidence (rejects
          // excess free-text keys) and assert the typed-fields-only rule. Either failure is refused.
          let evidence: RecoveryCommandContract.RecoveryEvidence
          try {
            evidence = RecoveryCommandContract.decodeRecoveryEvidence(input.evidence)
          } catch {
            return yield* Effect.fail(new TextIsNotEvidenceError({ reason: "text_is_not_evidence" }))
          }
          try {
            RecoveryCommandContract.assertEvidenceTyped(evidence)
          } catch {
            return yield* Effect.fail(new TextIsNotEvidenceError({ reason: "text_is_not_evidence" }))
          }
          const state = yield* Ref.get(store)
          // The terminal payload hash must be verifiable against the recorded terminal receipt.
          // A duplicate terminal is surfaced as a typed conflict with the canonical row (C1B-11);
          // the settle CAS never silently re-chooses a canonical row.
          const scan = scanTerminalEvidence(evidenceOf(state), input.requestHash)
          if (scan.status === "duplicate") {
            return yield* Effect.fail(
              new DuplicateTerminalConflictError({
                evidenceRef: scan.canonical.evidenceRef,
                requestHash: input.requestHash,
                duplicateRef: scan.duplicate.evidenceRef,
              }),
            )
          }
          const terminalPayloadHash = scan.status === "single" ? scan.canonical.payloadHash : undefined
          if (terminalPayloadHash === undefined) {
            return yield* Effect.fail(new MissingTerminalEvidenceError({ requestHash: input.requestHash }))
          }
          const verification = validateConfirmSettledEvidence(evidence, {
            requestHash: input.requestHash,
            providerId: input.attemptIdentity.providerId,
            idempotencyKey: input.attemptIdentity.idempotencyKey,
            terminalPayloadHash,
          })
          if (!verification.ok) {
            return yield* Effect.fail(new EvidenceBindingError({ reason: verification.reason }))
          }
          const evidenceRef = confirmSettledEvidenceRef({
            requestHash: input.requestHash,
            attempt: input.attemptIdentity,
            evidence,
          })
          const cas = evidenceSettleCas(evidenceOf(state), {
            evidenceRef,
            requestHash: input.requestHash,
            payloadHash: evidence.payloadHash,
            providerId: evidence.providerId,
          })
          if (cas.status === "conflict") return yield* Effect.fail(new MismatchError({ reason: cas.reason }))
          if (cas.status === "existing") {
            const existing: ConfirmSettledOutcome = { status: "existing", evidenceRef: cas.evidenceRef }
            return existing
          }
          // C1B-12 crash seam: a crash injected after the settled-verdict CAS but before the
          // evidence commit returns `aborted` and commits nothing (same-transaction or nothing).
          if (input.fault?.at === "after_evidence_stage") {
            return yield* Effect.fail(new RecoveryTransactionAbortedError({ operation: "confirm_settled" }))
          }
          const record: EvidenceRecord = {
            evidenceRef,
            status: "settled",
            providerId: evidence.providerId,
            requestHash: input.requestHash,
            payloadHash: evidence.payloadHash,
            recordedAt: input.now ?? Date.now(),
          }
          yield* Ref.set(store, { ...state, evidence: new Map(state.evidence).set(evidenceRef, record) })
          const settled: ConfirmSettledOutcome = { status: "settled", evidenceRef: cas.evidenceRef }
          return settled
        }),
      )
    })

    // C1B-09: encrypted evidence export + unlock.
    const exportRecoveryEvidence = Effect.fn("SessionProviderRecovery.exportRecoveryEvidence")(function* (
      input: ExportRecoveryEvidenceInput,
    ) {
      return yield* Semaphore.withPermits(lock, 1)(
        Effect.gen(function* () {
          // Export creates a read-only, evidence-preserving artifact for the session owner
          // (design §9.3 "导出事故上下文") — user-grade. Cross-session unlock is refused on read.
          yield* assertPermission(input.actor, "user")
          if (input.encryptionKey.byteLength !== 32) {
            return yield* Effect.fail(new MismatchError({ reason: "invalid_export_key" }))
          }
          const descriptor = classify(input.classifyInput)
          const state = yield* Ref.get(store)
          const commands = [...commandsOf(state).values()].filter(
            (command) =>
              command.requestHash === input.requestHash &&
              command.attemptIdentity.attemptId === input.attemptIdentity.attemptId,
          )
          const evidenceRecords = [...evidenceOf(state).values()].filter(
            (record) => record.requestHash === input.requestHash,
          )
          const payload = canonicalEvidenceExportPayload({
            requestHash: input.requestHash,
            attempt: input.attemptIdentity,
            descriptor,
            commands,
            evidence: evidenceRecords,
          })
          const contentHash = Hash.sha256(Buffer.from(payload))
          const exportId = input.exportId ?? `exp_${randomUUID()}`
          const now = input.now ?? Date.now()
          const ttlMs = input.ttlMs ?? DefaultEvidenceExportTtlMs
          const artifactRef = `artifact_${contentDigest({ exportId, sessionId: input.sessionId, contentHash })}`
          const summary = redactedSummary({
            requestHash: input.requestHash,
            commands,
            evidence: evidenceRecords,
            descriptor,
          })
          const manifest = buildExportManifest({
            exportId,
            sessionId: input.sessionId,
            attemptIds: [input.attemptIdentity.attemptId],
            artifactRef,
            contentHash,
            actorType: input.actor.type,
            actorId: input.actor.id,
            summary,
            now,
            ttlMs,
          })
          const sealed = encryptEvidenceArtifact({
            key: input.encryptionKey,
            plaintext: Buffer.from(payload),
            aad: evidenceArtifactAAD({ exportId, sessionId: input.sessionId, artifactRef, contentHash }),
          })
          const artifact: EncryptedEvidenceArtifact = {
            artifactRef,
            exportId,
            contentHash,
            keyId: input.keyId,
            iv: sealed.iv,
            ciphertext: sealed.ciphertext,
            authTag: sealed.authTag,
            expiresAt: now + ttlMs,
          }
          yield* Ref.set(store, {
            ...state,
            exports: new Map(state.exports).set(exportId, manifest),
            evidenceArtifacts: new Map(state.evidenceArtifacts).set(artifactRef, artifact),
          })
          return { exportId, artifactRef, contentHash, manifest }
        }),
      )
    })

    const queryExport = Effect.fn("SessionProviderRecovery.queryExport")(function* (exportId: string) {
      const state = yield* Ref.get(store)
      return exportsOf(state).get(exportId)
    })

    const unlockRecoveryEvidence = Effect.fn("SessionProviderRecovery.unlockRecoveryEvidence")(function* (
      input: UnlockRecoveryEvidenceInput,
    ) {
      const state = yield* Ref.get(store)
      const manifest = exportsOf(state).get(input.exportId)
      if (!manifest) return yield* Effect.fail(new ExportNotFoundError({ exportId: input.exportId }))
      // Permission gate: the body is readable ONLY by the same session actor.
      if (
        input.sessionId !== manifest.permission.unlockSessionId ||
        input.actor.type !== manifest.permission.unlockActorType ||
        input.actor.id !== manifest.permission.unlockActorId
      ) {
        return yield* Effect.fail(
          new ExportCrossSessionDeniedError({
            exportId: input.exportId,
            requestedSessionId: input.sessionId,
            ownerSessionId: manifest.target.sessionId,
          }),
        )
      }
      const artifact = evidenceArtifactsOf(state).get(manifest.artifactRef)
      if (!artifact) return yield* Effect.fail(new ExportNotFoundError({ exportId: input.exportId }))
      const now = input.now ?? Date.now()
      if (now > manifest.expiresAt || now > artifact.expiresAt) {
        return yield* Effect.fail(
          new ExportExpiredError({
            exportId: input.exportId,
            expiredAt: Math.min(manifest.expiresAt, artifact.expiresAt),
          }),
        )
      }
      // Auditability: decrypt + recompute + compare; a tampered manifest/artifact is a mismatch.
      const verification = verifyExportedArtifact({ manifest, artifact, key: input.encryptionKey, now })
      if (!verification.ok) {
        return yield* Effect.fail(new ExportTamperError({ exportId: input.exportId, reason: verification.reason }))
      }
      const plaintext = decryptEvidenceArtifact({
        key: input.encryptionKey,
        iv: artifact.iv,
        ciphertext: artifact.ciphertext,
        authTag: artifact.authTag,
        aad: evidenceArtifactAAD({
          exportId: manifest.exportId,
          sessionId: manifest.target.sessionId,
          artifactRef: manifest.artifactRef,
          contentHash: manifest.contentHash,
        }),
      })
      return { exportId: input.exportId, contentHash: manifest.contentHash, payload: plaintext, manifest }
    })

    return Service.of({
      classify,
      resolve,
      recordCommand,
      getCommand,
      queryCommand,
      queryAbandon,
      abandonExact,
      verifyBaselineReconstruction,
      queryBaseline,
      repairBaselineAndAbandon,
      evidence,
      findSafeBoundary,
      forkFromSafeBoundary,
      queryFork,
      isSessionReadOnly,
      assertSessionWritable,
      confirmSettled,
      exportRecoveryEvidence,
      queryExport,
      unlockRecoveryEvidence,
      adapter,
    })
  }),
)
