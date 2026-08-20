export * as ContextReconciliation from "./reconciliation"

import { Effect } from "effect"
import { Database } from "../database/database"
import { Hash } from "../util/hash"
import type { GraphKind } from "./contract"
import { SessionContextReconciliationTable } from "./reconciliation-sql"

export type RefKeyParts = {
  readonly graph: GraphKind
  readonly entityId: string
  readonly revision: string
}

export type Outcome =
  | "legacy_unavailable_projection_consistent"
  | "legacy_unavailable_projection_duplicate_refs"
  | "legacy_match"
  | "legacy_mismatch"

export type DiffSummary = {
  readonly mode: "projection_internal" | "legacy_vs_projection"
  readonly refCount: number
  readonly duplicateCount: number
  readonly perGraph: Readonly<Record<string, number>>
  readonly legacy?: {
    readonly refCount: number
    readonly onlyInLegacy: readonly string[]
    readonly onlyInProjection: readonly string[]
    readonly sharedCount: number
  }
  readonly note?: string
}

export type RecordInput = {
  readonly sessionId: string
  readonly activityId: string
  readonly turnReceiptId: string
  readonly selectionId?: string
  readonly projectionRefs: readonly RefKeyParts[]
  readonly legacyRefs?: readonly RefKeyParts[]
  readonly now?: number
}

export function refKey(parts: RefKeyParts): string {
  return `${parts.graph}:${parts.entityId}:${parts.revision}`
}

/** Sorted, de-duplicated ref keys — the canonical set representation for fingerprinting/diffing. */
export function refKeys(refs: readonly RefKeyParts[]): readonly string[] {
  return [...new Set(refs.map(refKey))].sort()
}

export function duplicateCount(refs: readonly RefKeyParts[]): number {
  return refs.length - new Set(refs.map(refKey)).size
}

export function refsFingerprint(refs: readonly RefKeyParts[]): string {
  return Hash.sha256(JSON.stringify(refKeys(refs)))
}

export function diffRefKeys(a: readonly string[], b: readonly string[]) {
  const setA = new Set(a)
  const setB = new Set(b)
  return {
    onlyInA: a.filter((key) => !setB.has(key)),
    onlyInB: b.filter((key) => !setA.has(key)),
    sharedCount: a.filter((key) => setB.has(key)).length,
  }
}

function perGraph(refs: readonly RefKeyParts[]): Record<string, number> {
  return refs.reduce<Record<string, number>>(
    (counts, ref) => ({ ...counts, [ref.graph]: (counts[ref.graph] ?? 0) + 1 }),
    {},
  )
}

export function evaluate(input: {
  readonly projectionRefs: readonly RefKeyParts[]
  readonly legacyRefs?: readonly RefKeyParts[]
}): {
  readonly outcome: Outcome
  readonly projectionFingerprint: string
  readonly legacyFingerprint?: string
  readonly diffSummary: DiffSummary
} {
  const projectionFingerprint = refsFingerprint(input.projectionRefs)
  const duplicates = duplicateCount(input.projectionRefs)
  const base = {
    refCount: input.projectionRefs.length,
    duplicateCount: duplicates,
    perGraph: perGraph(input.projectionRefs),
  }
  if (!input.legacyRefs) {
    // Legacy selected refs are produced inside the provider prepare path only; the receipt
    // write site has the projection selection exclusively. Record projection-internal
    // consistency instead of a cross-path diff (FEAT-007 fallback).
    return {
      outcome: duplicates > 0 ? "legacy_unavailable_projection_duplicate_refs" : "legacy_unavailable_projection_consistent",
      projectionFingerprint,
      diffSummary: {
        ...base,
        mode: "projection_internal",
        note: "legacy selected refs unavailable at receipt write site; projection-internal consistency recorded",
      },
    }
  }
  const legacyKeys = refKeys(input.legacyRefs)
  const projectionKeys = refKeys(input.projectionRefs)
  const diff = diffRefKeys(legacyKeys, projectionKeys)
  return {
    outcome: diff.onlyInA.length === 0 && diff.onlyInB.length === 0 ? "legacy_match" : "legacy_mismatch",
    projectionFingerprint,
    legacyFingerprint: Hash.sha256(JSON.stringify(legacyKeys)),
    diffSummary: {
      ...base,
      mode: "legacy_vs_projection",
      legacy: {
        refCount: input.legacyRefs.length,
        onlyInLegacy: diff.onlyInA,
        onlyInProjection: diff.onlyInB,
        sharedCount: diff.sharedCount,
      },
    },
  }
}

/** Deterministic per-receipt identity; safe for idempotent retries. */
export function reconciliationId(turnReceiptId: string): string {
  return Hash.sha256(`session-context-reconciliation:${turnReceiptId}`)
}

/**
 * Durable per-turn reconciliation write. Idempotent on `turn_receipt_id`; callers are
 * expected to wrap this best-effort so a failure never blocks the turn.
 */
export function record(db: Database.Interface["db"], input: RecordInput) {
  return Effect.gen(function* () {
    const evaluated = evaluate(input)
    yield* db
      .insert(SessionContextReconciliationTable)
      .values({
        reconciliation_id: reconciliationId(input.turnReceiptId),
        session_id: input.sessionId,
        activity_id: input.activityId,
        turn_receipt_id: input.turnReceiptId,
        selection_id: input.selectionId ?? null,
        legacy_refs_fingerprint: evaluated.legacyFingerprint ?? null,
        projection_refs_fingerprint: evaluated.projectionFingerprint,
        outcome: evaluated.outcome,
        diff_summary: evaluated.diffSummary,
        created_at: input.now ?? Date.now(),
      })
      .onConflictDoNothing({ target: SessionContextReconciliationTable.turn_receipt_id })
    return evaluated
  })
}
