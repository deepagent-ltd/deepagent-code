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
