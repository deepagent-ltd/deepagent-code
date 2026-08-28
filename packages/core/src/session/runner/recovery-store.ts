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
}

export function emptyRecoveryStoreState(): RecoveryStoreState {
  return {
    commands: new Map<string, CommandRecord>(),
    evidence: new Map<string, EvidenceRecord>(),
    abandons: new Map<string, AbandonRecord>(),
  }
}

export const commandsOf = (state: RecoveryStoreState): ReadonlyMap<string, CommandRecord> => state.commands
export const evidenceOf = (state: RecoveryStoreState): ReadonlyMap<string, EvidenceRecord> => state.evidence
export const abandonsOf = (state: RecoveryStoreState): ReadonlyMap<string, AbandonRecord> => state.abandons

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
  }
  return { status: "committed", state: next, outcome: stage.outcome }
}
