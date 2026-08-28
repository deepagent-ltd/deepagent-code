export * as SessionProviderRecoveryStore from "./recovery-store"

// C1B-03 — recovery command & evidence store (content-address, exact-request-hash,
// CAS, typed evidence statuses).
//
// The recovered command / evidence semantics are DETERMINISTIC and pure: the command id
// is content-addressed from the exact request hash + attempt identity, a replay of a
// different payload is a typed mismatch, and two commands resolving the same attempt
// serialize (the calling service holds the permit). The FULL immutable command payload
// and the external-evidence sink require a dedicated table that does not exist in the
// 20260812 / 13 / 23 migrations (reported to the main agent) — this module owns the store
// semantics so that a durable sink can be wired behind the same contract.

import { contentDigest } from "../../contract/digest"
import { RecoveryCommandContract } from "../../contract/recovery-command"

// ---------------------------------------------------------------------------
// Attempt identity (C2-04 protocol identity where present)
// ---------------------------------------------------------------------------

/**
 * The identity tuple a recovery descriptor / command binds to. This is the smallest
 * set of fields that must agree for an exact retry to be the SAME attempt — a mismatch
 * in any of these is a typed conflict, never a silent reuse (design §2.3).
 */
export type AttemptIdentity = {
  readonly sessionId: string
  readonly activityId: string
  readonly attemptId: string
  readonly providerTurnSeq: number
  readonly selectionId: string
  readonly projectionHash: string
  readonly requestHash: string
  readonly providerId: string
  readonly protocol?: string
  readonly idempotencyKey?: string
}

// ---------------------------------------------------------------------------
// Command record
// ---------------------------------------------------------------------------

/** A recorded command in the single-writer command slot. */
export type CommandRecord = {
  readonly commandId: string
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly recordedAt: number
}

/**
 * Content-addressed command id: a canonical digest over the EXACT request hash plus the
 * attempt identity. A replay of a different payload (different request hash or identity)
 * does not collide with the original command (design §2.3 / contract command semantics).
 */
export function recoveryCommandContentAddress(input: {
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
}): string {
  return `cmd_${contentDigest({ requestHash: input.requestHash, attempt: input.attemptIdentity })}`
}

/** Outcome of a command CAS write — the loser never kills the DB layer. */
export type CommandWriteOutcome =
  | { readonly status: "recorded"; readonly commandId: string; readonly record: CommandRecord }
  | { readonly status: "existing"; readonly commandId: string; readonly record: CommandRecord }
  | { readonly status: "mismatch"; readonly commandId: string; readonly reason: "request_hash_mismatch" }

/**
 * Command CAS: two commands resolving the same attempt serialize (the caller holds the
 * permit). Same content address (same request hash + identity) → `existing` (idempotent);
 * same attempt but a different request hash → typed `mismatch`; the first write to the
 * attempt slot wins. Deterministic, pure, and never a defect that kills the DB layer.
 */
export function commandCas(
  existing: ReadonlyMap<string, CommandRecord>,
  input: { readonly requestHash: string; readonly attemptIdentity: AttemptIdentity },
): CommandWriteOutcome {
  const address = recoveryCommandContentAddress(input)
  const prior = [...existing.values()].find(
    (record) => record.attemptIdentity.attemptId === input.attemptIdentity.attemptId,
  )
  const record: CommandRecord = {
    commandId: address,
    requestHash: input.requestHash,
    attemptIdentity: input.attemptIdentity,
    recordedAt: Date.now(),
  }
  if (prior) {
    if (prior.requestHash !== input.requestHash)
      return { status: "mismatch", commandId: address, reason: "request_hash_mismatch" }
    return { status: "existing", commandId: prior.commandId, record: prior }
  }
  return { status: "recorded", commandId: address, record }
}

// ---------------------------------------------------------------------------
// Evidence store — typed statuses (C1B-08 fills the external/settled content)
// ---------------------------------------------------------------------------

export const EvidenceStatus = ["pending", "external", "settled"] as const
export type EvidenceStatus = (typeof EvidenceStatus)[number]

/** Evidence record with a typed status; the content-addressable body is C1B-08's job. */
export type EvidenceRecord = {
  readonly evidenceRef: string
  readonly status: EvidenceStatus
  readonly providerId?: string
  readonly requestHash?: string
  readonly payloadHash?: string
  readonly recordedAt: number
}

// ---------------------------------------------------------------------------
// Abandon transaction store (C1B-04)
// ---------------------------------------------------------------------------

/**
 * The durable terminal receipt of an abandoned attempt. Records the abandon
 * decision, the terminal outcome (`abandoned`), the actor, the reason code and
 * the attempt identity — written atomically with the command that authorized it
 * (design §9.2: one local transaction). As with the command slot (C1B-03) there is
 * no dedicated V2 table in the 20260812/13/23 migrations, so it lives in-memory
 * behind the same contract (reported to the main agent).
 */
export type AbandonRecord = {
  readonly commandId: string
  readonly requestHash: string
  readonly attempt: AttemptIdentity
  readonly decision: "abandoned"
  readonly terminal: RecoveryCommandContract.RecoveryTerminal
  readonly reasonCode: RecoveryCommandContract.RecoveryReasonCode
  readonly actorType: "user" | "administrator" | "system"
  readonly actorId: string
  readonly abandonedAt: number
}

/**
 * The composite single-writer store state. All domains that a recovery transaction
 * mutates live together so a crash mid-transaction cannot leave a torn half-application
 * across them (design §9.2).
 */
export type RecoveryStoreState = {
  readonly commands: ReadonlyMap<string, CommandRecord>
  readonly evidence: ReadonlyMap<string, EvidenceRecord>
  readonly abandons: ReadonlyMap<string, AbandonRecord>
  readonly baselines: ReadonlyMap<string, BaselineRecord>
  // C1B-07: fork records + the read-only fence that a completed fork imposes on its source session.
  readonly forks: ReadonlyMap<string, ForkRecord>
  readonly readOnlySessions: ReadonlyMap<string, ReadOnlyFence>
  // C1B-09: encrypting export manifests (redacted) + the encrypted evidence artifacts they reference.
  readonly exports: ReadonlyMap<string, EvidenceExportManifest>
  readonly evidenceArtifacts: ReadonlyMap<string, EncryptedEvidenceArtifact>
}

export function emptyRecoveryStoreState(): RecoveryStoreState {
  return {
    commands: new Map<string, CommandRecord>(),
    evidence: new Map<string, EvidenceRecord>(),
    abandons: new Map<string, AbandonRecord>(),
    baselines: new Map<string, BaselineRecord>(),
    forks: new Map<string, ForkRecord>(),
    readOnlySessions: new Map<string, ReadOnlyFence>(),
    exports: new Map<string, EvidenceExportManifest>(),
    evidenceArtifacts: new Map<string, EncryptedEvidenceArtifact>(),
  }
}

export const commandsOf = (state: RecoveryStoreState): ReadonlyMap<string, CommandRecord> => state.commands
export const evidenceOf = (state: RecoveryStoreState): ReadonlyMap<string, EvidenceRecord> => state.evidence
export const abandonsOf = (state: RecoveryStoreState): ReadonlyMap<string, AbandonRecord> => state.abandons
export const baselinesOf = (state: RecoveryStoreState): ReadonlyMap<string, BaselineRecord> => state.baselines
export const forksOf = (state: RecoveryStoreState): ReadonlyMap<string, ForkRecord> => state.forks
export const readOnlySessionsOf = (state: RecoveryStoreState): ReadonlyMap<string, ReadOnlyFence> => state.readOnlySessions
export const exportsOf = (state: RecoveryStoreState): ReadonlyMap<string, EvidenceExportManifest> => state.exports
export const evidenceArtifactsOf = (state: RecoveryStoreState): ReadonlyMap<string, EncryptedEvidenceArtifact> =>
  state.evidenceArtifacts

/** The attempt slot key for a recovery transaction (same attempt -> same slot). */
export const abandonAttemptKey = (attempt: AttemptIdentity): string => `${attempt.sessionId}:${attempt.attemptId}`

function set<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  return new Map(map).set(key, value)
}

export type AbandonTransactionInput = {
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly actorType: "user" | "administrator" | "system"
  readonly actorId: string
  readonly reasonCode: RecoveryCommandContract.RecoveryReasonCode
}

export type AbandonTransactionOutcome =
  | { readonly status: "abandoned"; readonly commandId: string; readonly abandon: AbandonRecord }
  | { readonly status: "existing"; readonly commandId: string; readonly abandon: AbandonRecord }
  | { readonly status: "conflict"; readonly commandId: string; readonly reason: "abandon_mismatch" | "request_hash_mismatch" }

/** A transaction result: a NEW state to commit, or `aborted` (commit nothing). */
export type CommitResult<S, O> =
  | { readonly status: "committed"; readonly state: S; readonly outcome: O }
  | { readonly status: "aborted" }

/** Stage the abandon decision for an attempt (pure; committed atomically by the caller). */
function stageAbandon(
  state: RecoveryStoreState,
  input: AbandonTransactionInput,
): { readonly outcome: AbandonTransactionOutcome; readonly key: string; readonly command?: CommandRecord } {
  const address = recoveryCommandContentAddress({
    requestHash: input.requestHash,
    attemptIdentity: input.attemptIdentity,
  })
  const key = abandonAttemptKey(input.attemptIdentity)
  const existing = state.abandons.get(key)
  if (existing) {
    if (existing.requestHash === input.requestHash) {
      return { outcome: { status: "existing", commandId: existing.commandId, abandon: existing }, key }
    }
    return {
      outcome: { status: "conflict", commandId: address, reason: "abandon_mismatch" },
      key,
    }
  }
  const cas = commandCas(state.commands, { requestHash: input.requestHash, attemptIdentity: input.attemptIdentity })
  if (cas.status === "mismatch") {
    return { outcome: { status: "conflict", commandId: address, reason: "request_hash_mismatch" }, key }
  }
  const abandon: AbandonRecord = {
    commandId: cas.commandId,
    requestHash: input.requestHash,
    attempt: input.attemptIdentity,
    decision: "abandoned",
    terminal: "abandoned",
    reasonCode: input.reasonCode,
    actorType: input.actorType,
    actorId: input.actorId,
    abandonedAt: Date.now(),
  }
  return {
    outcome: { status: "abandoned", commandId: cas.commandId, abandon },
    key,
    command: cas.status === "recorded" ? cas.record : undefined,
  }
}

/**
 * Abandon an attempt in ONE transaction with the store's CAS semantics (C1B-04):
 *   - the abandon decision + terminal receipt + command are written together;
 *   - one command wins (CAS-lost -> typed existing/conflict, never a defect);
 *   - an already-abandoned attempt with the same request hash -> `existing`
 *     (idempotent; no second terminal row, no double effect);
 *   - an injected fault (`fault.at`) models a crash mid-transaction and returns
 *     `aborted` so NOTHING is committed (same-transaction or nothing).
 */
export function abandonTransaction(
  state: RecoveryStoreState,
  input: AbandonTransactionInput,
  fault?: { readonly at: "after_command_stage" },
): CommitResult<RecoveryStoreState, AbandonTransactionOutcome> {
  const stage = stageAbandon(state, input)
  if (stage.outcome.status === "conflict" || stage.outcome.status === "existing") {
    return { status: "committed", state, outcome: stage.outcome }
  }
  if (fault?.at === "after_command_stage") return { status: "aborted" }
  const next: RecoveryStoreState = {
    commands: stage.command ? set(state.commands, stage.command.commandId, stage.command) : state.commands,
    evidence: state.evidence,
    abandons: set(state.abandons, stage.key, stage.outcome.abandon),
    baselines: state.baselines,
    forks: state.forks,
    readOnlySessions: state.readOnlySessions,
    exports: state.exports,
    evidenceArtifacts: state.evidenceArtifacts,
  }
  return { status: "committed", state: next, outcome: stage.outcome }
}

// ---------------------------------------------------------------------------
// Baseline reconstruction evidence + verifier (C1B-05, design §9.1)
// ---------------------------------------------------------------------------

/** Provenance of a committed baseline: source, committed-at, parent-hash root. */
export type BaselineProvenance = {
  readonly source: string
  readonly committedAt: number
  readonly parentHash: string
}

/** One reconstructed baseline row/fragment with its provenance-chain hash. */
export type BaselineFragment = {
  readonly ref: string
  readonly content: string
  readonly hash: string
  readonly parentHash?: string
}

/** Committed baseline evidence a reconstruction must match. */
export type BaselineEvidence = {
  readonly baselineHash: string
  readonly provenance: BaselineProvenance
}

/**
 * A reconstructed baseline: the ordered set of fragments rebuilt from a trusted
 * source snapshot. The verifier accepts it ONLY when its recomputed content hash
 * exactly matches the committed hash AND its parent-hash chain is unbroken. There
 * is deliberately no "current world state" here — a reconstruction that lacks a
 * committed hash/provenance is always refused, so history is never fabricated from
 * current rows.
 */
export type BaselineReconstruction = {
  readonly fragments: readonly BaselineFragment[]
}

/**
 * A committed baseline row that was repaired (C1B-06). It is hash-committed: both
 * the committed evidence AND the reconstructed fragments are retained so re-verify
 * and CAS comparison are deterministic.
 */
export type BaselineRecord = {
  readonly baselineRef: string
  readonly evidence: BaselineEvidence
  readonly fragments: readonly BaselineFragment[]
  readonly repairedAt: number
}

/** Result of verifying a reconstructed baseline (C1B-05). */
export type BaselineVerificationOutcome =
  | { readonly status: "verified"; readonly hash: string }
  | {
      readonly status: "refused"
      readonly reason: "baseline_missing_hash_provenance" | "hash_mismatch" | "provenance_chain_broken"
    }

/**
 * Verify a reconstructed baseline against committed evidence. This is the single
 * gate a repair may pass (C1B-06 step 1) and it accepts a reconstruction ONLY when:
 *   1. a committed content hash AND provenance (source / committed-at / parent
 *      chain root) are present — otherwise `baseline_missing_hash_provenance`
 *      (history is never fabricated from current rows);
 *   2. the recomputed hash over the reconstructed content exactly matches the
 *      committed hash — otherwise `hash_mismatch`;
 *   3. the provenance parent-hash chain is unbroken (each fragment's parentHash
 *      links to the prior fragment, rooted at the committed parent) — otherwise
 *      `provenance_chain_broken` (a baseline is never partially rebuilt).
 * Pure and deterministic: the same reconstruction + evidence always yields the
 * same verdict.
 */
export function verifyBaselineReconstruction(input: {
  readonly reconstruction: BaselineReconstruction
  readonly evidence?: BaselineEvidence
}): BaselineVerificationOutcome {
  const { fragments } = input.reconstruction
  const evidence = input.evidence
  if (!evidence) return { status: "refused", reason: "baseline_missing_hash_provenance" }
  const { baselineHash, provenance } = evidence
  const hasProvenance =
    provenance != null &&
    provenance.source.length > 0 &&
    provenance.committedAt > 0 &&
    provenance.parentHash.length > 0
  if (baselineHash.length === 0 || !hasProvenance) {
    return { status: "refused", reason: "baseline_missing_hash_provenance" }
  }
  const reconstructedHash = contentDigest({ fragments: fragments.map((f) => ({ ref: f.ref, content: f.content })) })
  if (reconstructedHash !== baselineHash) return { status: "refused", reason: "hash_mismatch" }
  let previousHash: string = provenance.parentHash
  for (const fragment of fragments) {
    if (fragment.parentHash === undefined || fragment.parentHash !== previousHash) {
      return { status: "refused", reason: "provenance_chain_broken" }
    }
    previousHash = fragment.hash
  }
  return { status: "verified", hash: reconstructedHash }
}

// ---------------------------------------------------------------------------
// Baseline repair + abandon atomic transaction (C1B-06, design §9.2)
// ---------------------------------------------------------------------------

export type RepairBaselineInput = {
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly baselineRef: string
  readonly evidence: BaselineEvidence
  readonly fragments: readonly BaselineFragment[]
}

export type RepairBaselineOutcome =
  | { readonly status: "repaired"; readonly record: BaselineRecord }
  | { readonly status: "existing"; readonly record: BaselineRecord }
  | { readonly status: "conflict"; readonly reason: "legally_different_data" }

/**
 * Baseline repair CAS. One baseline slot wins the write (design §2.1). A slot
 * that already holds the SAME committed hash + provenance is `existing`
 * (idempotent); a slot that holds legally-different data from a different
 * provenance is `conflict` and is never clobbered (C1B-06: never overwrite
 * legally-different data). Deterministic and pure.
 */
export function repairBaselineCas(
  existing: ReadonlyMap<string, BaselineRecord>,
  input: RepairBaselineInput,
): RepairBaselineOutcome {
  const prior = existing.get(input.baselineRef)
  if (!prior) {
    return {
      status: "repaired",
      record: {
        baselineRef: input.baselineRef,
        evidence: input.evidence,
        fragments: input.fragments,
        repairedAt: Date.now(),
      },
    }
  }
  const same =
    prior.evidence.baselineHash === input.evidence.baselineHash &&
    prior.evidence.provenance.source === input.evidence.provenance.source &&
    prior.evidence.provenance.committedAt === input.evidence.provenance.committedAt &&
    prior.evidence.provenance.parentHash === input.evidence.provenance.parentHash
  if (same) return { status: "existing", record: prior }
  return { status: "conflict", reason: "legally_different_data" }
}

export type RepairAndAbandonInput = {
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly baselineRef: string
  readonly evidence: BaselineEvidence
  readonly fragments: readonly BaselineFragment[]
  readonly actorType: "user" | "administrator" | "system"
  readonly actorId: string
  readonly reasonCode: RecoveryCommandContract.RecoveryReasonCode
}

export type RepairAndAbandonOutcome =
  | { readonly status: "complete"; readonly repair: BaselineRecord; readonly abandon: AbandonRecord }
  | { readonly status: "existing"; readonly repair: BaselineRecord; readonly abandon: AbandonRecord }
  | { readonly status: "conflict"; readonly reason: "repair_conflict" | "abandon_conflict" }

/**
 * Verify-then-repair-then-abandon as ONE atomic transaction (C1B-06). The
 * repair CAS runs first (never clobber legally-different data), then the
 * abandon CAS, and both writes are committed together — a crash injected
 * between the repair stage and the abandon stage (`fault.at`) returns `aborted`
 * and commits neither, so a torn "repaired without abandon" or "abandoned
 * without repair" state is impossible (crash-consistency converges to the
 * original state, or both).
 *
 * NOTE: C1B-05 verification is the CALLER's gate and runs before this
 * transaction; this function only guards the write CAS.
 */
export function repairAndAbandonTransaction(
  state: RecoveryStoreState,
  input: RepairAndAbandonInput,
  fault?: { readonly at: "after_repair_stage" },
): CommitResult<RecoveryStoreState, RepairAndAbandonOutcome> {
  const repair = repairBaselineCas(state.baselines, {
    requestHash: input.requestHash,
    attemptIdentity: input.attemptIdentity,
    baselineRef: input.baselineRef,
    evidence: input.evidence,
    fragments: input.fragments,
  })
  if (repair.status === "conflict") {
    return { status: "committed", state, outcome: { status: "conflict", reason: "repair_conflict" } }
  }
  if (fault?.at === "after_repair_stage") return { status: "aborted" }
  const stage = stageAbandon(state, {
    requestHash: input.requestHash,
    attemptIdentity: input.attemptIdentity,
    actorType: input.actorType,
    actorId: input.actorId,
    reasonCode: input.reasonCode,
  })
  if (stage.outcome.status === "conflict") {
    return { status: "committed", state, outcome: { status: "conflict", reason: "abandon_conflict" } }
  }
  if (repair.status === "existing" && stage.outcome.status === "existing") {
    return {
      status: "committed",
      state,
      outcome: { status: "existing", repair: repair.record, abandon: stage.outcome.abandon },
    }
  }
  let next: RecoveryStoreState = state
  if (repair.status === "repaired") next = { ...next, baselines: set(next.baselines, input.baselineRef, repair.record) }
  if (stage.outcome.status === "abandoned") {
    next = {
      ...next,
      commands: stage.command ? set(next.commands, stage.command.commandId, stage.command) : next.commands,
      abandons: set(next.abandons, stage.key, stage.outcome.abandon),
    }
  }
  return {
    status: "committed",
    state: next,
    outcome: { status: "complete", repair: repair.record, abandon: stage.outcome.abandon },
  }
}

// ---------------------------------------------------------------------------
// Fork from a safe boundary (C1B-07, design §9.1 `fork_only`)
// ---------------------------------------------------------------------------

/** A fork manifest: the complete, auditable record of a `fork_from_safe_boundary`. */
export type ForkManifest = {
  readonly schemaVersion: "recovery-fork-manifest.v1"
  readonly forkSessionId: string
  readonly sourceSessionId: string
  readonly boundaryMessageId: string
  readonly boundaryIndex: number
  readonly boundaryHash: string
  readonly copiedMessageIds: readonly string[]
  readonly excludedIndeterminateTurns: readonly { readonly id: string; readonly kind: string; readonly reason: string }[]
  readonly copiedWindowHash: string
  readonly createdBy: { readonly actorType: "user" | "administrator" | "system"; readonly actorId: string }
  readonly permission: "user" | "administrator"
  readonly forkedAt: number
}

/** A recorded fork, keyed by its deterministic manifest ref. */
export type ForkRecord = {
  readonly forkRef: string
  readonly manifest: ForkManifest
}

/** The one-way read-only fence a completed fork imposes on its source session. */
export type ReadOnlyFence = {
  readonly sessionId: string
  readonly forkRef: string
  readonly forkedAt: number
  readonly reason: "fork"
}

/**
 * Deterministic fork ref: a content digest over the (source session, boundary)
 * identity only. The same source + boundary always maps to the same ref, so an
 * exact retry of the fork command converges on the SAME fork (no second fork)
 * instead of creating a duplicate (design §2.3).
 */
export function forkManifestRef(input: {
  readonly sourceSessionId: string
  readonly boundaryMessageId: string
  readonly boundaryHash: string
}): string {
  return `fork_${contentDigest({
    sourceSessionId: input.sourceSessionId,
    boundaryMessageId: input.boundaryMessageId,
    boundaryHash: input.boundaryHash,
  })}`
}

export type ForkTransactionInput = {
  readonly sourceSessionId: string
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly boundaryMessageId: string
  readonly boundaryIndex: number
  readonly boundaryHash: string
  readonly copiedMessageIds: readonly string[]
  readonly excludedIndeterminateTurns: readonly { readonly id: string; readonly kind: string; readonly reason: string }[]
  readonly copiedWindowHash: string
  readonly actorType: "user" | "administrator" | "system"
  readonly actorId: string
  readonly permission: "user" | "administrator"
  readonly forkSessionId: string
  readonly now?: number
}

export type ForkTransactionOutcome =
  | { readonly status: "forked"; readonly forkRef: string; readonly manifest: ForkManifest }
  | { readonly status: "existing"; readonly forkRef: string; readonly manifest: ForkManifest }
  | { readonly status: "conflict"; readonly reason: "fork_mismatch" | "already_forked" }

/**
 * Fork from a safe boundary in ONE transaction (C1B-07):
 *   - records the fork manifest (content-addressed by source + boundary) AND
 *     fences the source session read-only together (a crash commits neither);
 *   - an exact retry for the SAME boundary -> typed `existing` (no second fork);
 *   - a different boundary / a different request-hash against an already-forked
 *     source -> typed `conflict` (never clobber a prior fork);
 *   - the fork command (bound to request hash + attempt identity) is recorded
 *     with the same CAS semantics as the other recovery commands.
 * Pure and deterministic. The caller commits the returned state atomically.
 */
export function forkTransaction(
  state: RecoveryStoreState,
  input: ForkTransactionInput,
): CommitResult<RecoveryStoreState, ForkTransactionOutcome> {
  const forkRef = forkManifestRef({
    sourceSessionId: input.sourceSessionId,
    boundaryMessageId: input.boundaryMessageId,
    boundaryHash: input.boundaryHash,
  })
  const prior = state.forks.get(forkRef)
  if (prior) return { status: "committed", state, outcome: { status: "existing", forkRef, manifest: prior.manifest } }
  const sourceFence = state.readOnlySessions.get(input.sourceSessionId)
  if (sourceFence) return { status: "committed", state, outcome: { status: "conflict", reason: "already_forked" } }
  const cas = commandCas(state.commands, { requestHash: input.requestHash, attemptIdentity: input.attemptIdentity })
  if (cas.status === "mismatch") {
    return { status: "committed", state, outcome: { status: "conflict", reason: "fork_mismatch" } }
  }
  const now = input.now ?? Date.now()
  const manifest: ForkManifest = {
    schemaVersion: "recovery-fork-manifest.v1",
    forkSessionId: input.forkSessionId,
    sourceSessionId: input.sourceSessionId,
    boundaryMessageId: input.boundaryMessageId,
    boundaryIndex: input.boundaryIndex,
    boundaryHash: input.boundaryHash,
    copiedMessageIds: input.copiedMessageIds,
    excludedIndeterminateTurns: input.excludedIndeterminateTurns,
    copiedWindowHash: input.copiedWindowHash,
    createdBy: { actorType: input.actorType, actorId: input.actorId },
    permission: input.permission,
    forkedAt: now,
  }
  const next: RecoveryStoreState = {
    commands: cas.status === "recorded" ? set(state.commands, cas.commandId, cas.record) : state.commands,
    evidence: state.evidence,
    abandons: state.abandons,
    baselines: state.baselines,
    forks: set(state.forks, forkRef, { forkRef, manifest }),
    readOnlySessions: set(state.readOnlySessions, input.sourceSessionId, {
      sessionId: input.sourceSessionId,
      forkRef,
      forkedAt: now,
      reason: "fork",
    }),
    exports: state.exports,
    evidenceArtifacts: state.evidenceArtifacts,
  }
  return { status: "committed", state: next, outcome: { status: "forked", forkRef, manifest } }
}

// ---------------------------------------------------------------------------
// Confirm settled (C1B-08, design §9.1 resolvable_exact confirm with external evidence)
// ---------------------------------------------------------------------------

/** Outcome of the evidence-settle CAS. */
export type EvidenceSettleOutcome =
  | { readonly status: "settled"; readonly evidenceRef: string }
  | { readonly status: "existing"; readonly evidenceRef: string }
  | { readonly status: "conflict"; readonly reason: "evidence_request_hash_mismatch" | "evidence_payload_mismatch" }

/**
 * CAS for the external-provider settled verdict (C1B-08). The evidence slot is
 * keyed by the content-addressed `evidenceRef`; the winner wins, and:
 *   - an empty slot -> `settled` (caller inserts the settled record);
 *   - a slot already settled with the SAME request hash + payload hash -> `existing`
 *     (exact retry is idempotent, no second terminal row);
 *   - a slot holding a DIFFERENT request hash or payload -> typed `conflict`
 *     (never clobber a different verdict).
 * Pure and deterministic.
 */
export function evidenceSettleCas(
  existing: ReadonlyMap<string, EvidenceRecord>,
  input: { readonly evidenceRef: string; readonly requestHash: string; readonly payloadHash: string; readonly providerId: string },
): EvidenceSettleOutcome {
  const prior = existing.get(input.evidenceRef)
  if (!prior) return { status: "settled", evidenceRef: input.evidenceRef }
  const sameIdentity = prior.requestHash === input.requestHash && prior.payloadHash === input.payloadHash
  if (prior.status === "settled") {
    return sameIdentity
      ? { status: "existing", evidenceRef: input.evidenceRef }
      : { status: "conflict", reason: "evidence_payload_mismatch" }
  }
  if (!sameIdentity) return { status: "conflict", reason: "evidence_request_hash_mismatch" }
  return { status: "settled", evidenceRef: input.evidenceRef }
}

/**
 * C1B-11 — duplicate-terminal scan (design §10.7 "CAS lost 重读 canonical state 并返回
 * conflict/existing，不能用 defect 让 Database layer 整体 die").
 *
 * Scans the settled evidence rows for ONE request/attempt and reports whether there is:
 *   - no terminal            → `none`            (nothing to canonize);
 *   - exactly one terminal   → `single`          (the canonical record, unchanged);
 *   - MORE than one terminal → `duplicate`       (a duplicate terminal row for one attempt; the
 *                                                 caller must return a TYPED conflict naming the
 *                                                 canonical row — never a raw defect).
 *
 * Pure and deterministic. This is the read-side guard a recovery command consults INSTEAD of an
 * arbitrary `.find()` over settled rows, so a surprise duplicate never silently re-chooses a
 * canonical row or kills the startup.
 */
export type TerminalEvidenceScan =
  | { readonly status: "none" }
  | { readonly status: "single"; readonly canonical: EvidenceRecord }
  | { readonly status: "duplicate"; readonly canonical: EvidenceRecord; readonly duplicate: EvidenceRecord }

export function scanTerminalEvidence(
  existing: ReadonlyMap<string, EvidenceRecord>,
  requestHash: string,
): TerminalEvidenceScan {
  const terminals = [...existing.values()].filter(
    (e) => e.requestHash === requestHash && e.status === "settled",
  )
  if (terminals.length === 0) return { status: "none" }
  const canonical = terminals[0]!
  // Distinct terminal payload identities. Confirm-settled legitimately records a NEW settled row
  // whose payload hash ALWAYS equals the recorded terminal (the binding check enforces it), so two
  // settled rows with the SAME payload key are an idempotent convergence → `single`. Only TWO
  // DIFFERENT terminal payloads (a genuinely conflicting duplicate terminal) are a `duplicate` →
  // typed conflict naming the canonical row. Never a raw defect.
  const payloadIds = new Set(terminals.map((e) => e.payloadHash ?? e.evidenceRef))
  if (payloadIds.size === 1)
    return { status: "single", canonical }
  const duplicate = terminals.find((e) => (e.payloadHash ?? e.evidenceRef) !== (canonical.payloadHash ?? canonical.evidenceRef))!
  return { status: "duplicate", canonical, duplicate }
}

// ---------------------------------------------------------------------------
// Encrypted evidence export (C1B-09, design §9.2 / §12 sensitive body)
// ---------------------------------------------------------------------------

/** One redacted summary item in an export manifest (never the payload body). */
export type EvidenceExportSummaryItem = {
  readonly kind: "command" | "evidence" | "descriptor" | "manifest"
  readonly ref: string
  readonly size: number
  readonly sha256: string
  readonly reason: string
}

/**
 * The export manifest. DEFAULT-REDACTED: it carries only hash/size/type/reason
 * per item — never a prompt, tool payload or credential — and the body is only
 * reachable through the decrypt-and-verify permission gate.
 */
export type EvidenceExportManifest = {
  readonly schemaVersion: "recovery-export-manifest.v1"
  readonly exportId: string
  readonly target: { readonly sessionId: string; readonly attemptIds: readonly string[] }
  readonly artifactRef: string
  readonly contentHash: string
  readonly permission: {
    readonly unlockActorType: "user" | "administrator" | "system"
    readonly unlockActorId: string
    readonly unlockSessionId: string
    readonly crossSessionDenied: true
  }
  readonly redacted: true
  readonly summary: readonly EvidenceExportSummaryItem[]
  readonly issuedAt: number
  readonly expiresAt: number
}

/** The encrypted evidence artifact stored behind the export manifest. */
export type EncryptedEvidenceArtifact = {
  readonly artifactRef: string
  readonly exportId: string
  readonly contentHash: string
  readonly keyId: string
  readonly iv: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authTag: Uint8Array
  readonly expiresAt: number
}

export const DefaultEvidenceExportTtlMs = 7 * 24 * 60 * 60_000
