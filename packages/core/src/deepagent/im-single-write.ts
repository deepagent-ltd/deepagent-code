export * as ImSingleWrite from "./im-single-write"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { EventWorkEnvelope } from "../contract/event-envelope"
import { EventAdmission, type SessionWorkAdapter } from "./event-admission"
import { ImSingleWriteTable, type ImSingleWriteStatus } from "./im-single-write-sql"

// C5-09 — IM SINGLE-WRITE. Design authority: docs/core-v2.0-beta/design.md §B1 (the IM double-write:
// a persisted user message ALSO publishes `im.message.created` and feeds the legacy synchronous
// @mention path — the event path and the legacy path can BOTH become the authority for the same IM
// input, which the contract encodes as `im_double_write_attempted`).
//
// AUTHORITATIVE PRODUCTION PATH (AUTH-P2-1 close): the live IM single-write regime is wired at the
// httpapi `im.ts` handler boundary — the `DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE` flag gate
// `shouldExecuteLegacyAgentMentions` skips the legacy synchronous @mention path, while the durable
// V2 admission + execution happens through `EventV2Bridge` (event-v2-bridge.ts) on `im.message.created`
// events (/v4EventDrivenIm). THIS module's `admit`/`forImMessage` surface predates that wiring and has
// NO production caller anymore; it is kept as the frozen §B1 contract surface (unit-tested) and is
// DEPRECATED — do not wire new paths through it.
//
// This module is the single-write consolidation boundary. When the module-local switch is ON, an IM
// input produces exactly ONE durable IM input receipt and binds it to ONE execution owner through the
// E4a admission bridge (`EventAdmission.admit`): the model-facing work is the bounded IM work
// envelope, and the legacy input channel is never ALSO written. When the switch is OFF, the module
// returns `im_single_write_unavailable` for opt-in callers and the legacy behavior stays authoritative
// (unchanged).
//
// Ownership fencing: an IM message has ONE execution owner. Re-claiming the same IM input with a
// DIFFERENT owner is a typed refusal (`already_owned`) — never a silent second execution.
//
// LAYERING: `core`. The only session dependency is the caller-injected `sessionAdapter`
// (SessionV2.prompt in production wiring) handed to the E4a admission bridge. No legacy session import.

type DatabaseClient = Database.Interface["db"]

/** The typed feature switch for the IM single-write path. C7-05 ships it ON via the PRODUCTION
 * runtime entrypoints (packages/deepagent-code/src/index.ts sets the env); the predicate stays
 * explicit-env. `=false`/`=0` restores the legacy double-write path as the authority. */
export const IM_SINGLE_WRITE_ENV = "DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE"
export const isEventV2ImSingleWriteEnabled = (): boolean => {
  const value = process.env[IM_SINGLE_WRITE_ENV]?.toLowerCase()
  return value === "true" || value === "1"
}

/** Why an IM single-write was refused. Fail-closed; each reason is a typed refusal. */
export type ImSingleWriteErrorReason =
  | "im_single_write_unavailable"
  | "already_owned"
  | "invalid_envelope"
  | "admission_disabled"
  | "admission_refused"

/** Typed refusal thrown through the Effect failure channel (never a buried throw). */
export class ImSingleWriteError extends Error {
  readonly _tag = "ImSingleWrite.ImSingleWriteError"
  readonly reason: ImSingleWriteErrorReason
  readonly imMessageId: string
  constructor(reason: ImSingleWriteErrorReason, imMessageId: string, message: string) {
    super(message)
    this.name = "ImSingleWriteError"
    this.reason = reason
    this.imMessageId = imMessageId
  }
}

const fail = (reason: ImSingleWriteErrorReason, imMessageId: string, message: string) =>
  Effect.fail(new ImSingleWriteError(reason, imMessageId, message))

/** The durable single-write receipt row (as read from the ledger). */
export type ImSingleWriteRow = {
  readonly imMessageId: string
  readonly eventRef: string
  readonly ownerId: string
  readonly generation: number
  readonly receiptRef: string
  readonly status: ImSingleWriteStatus
  readonly createdAt: number
  readonly updatedAt: number
}

const decodeRow = (row: typeof ImSingleWriteTable.$inferSelect): ImSingleWriteRow => ({
  imMessageId: row.im_message_id,
  eventRef: row.event_ref,
  ownerId: row.owner_id,
  generation: row.generation,
  receiptRef: row.receipt_ref,
  status: row.status as ImSingleWriteStatus,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/** The durable single-write receipt read for an IM message. */
export function forImMessage(db: DatabaseClient, imMessageId: string): Effect.Effect<ImSingleWriteRow | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(ImSingleWriteTable)
      .where(eq(ImSingleWriteTable.im_message_id, imMessageId))
      .get()
      .pipe(Effect.orDie)
    return row ? decodeRow(row) : undefined
  })
}

export interface ImSingleWriteAdmitInput {
  readonly imMessageId: string
  /** The bounded IM work envelope — the model-facing work, never the raw IM payload. */
  readonly envelope: EventWorkEnvelope
  /** The session the IM work is admitted to (the caller's SessionV2.ID, stored opaquely in core). */
  readonly sessionID: string
  /** The single execution owner claiming this IM input (process/SessionExecution owner token). */
  readonly ownerID: string
  /** The SessionV2 adapter handed to the E4a admission bridge. */
  readonly sessionAdapter: SessionWorkAdapter
  readonly resume?: boolean
  readonly now: number
}

export type ImSingleWriteResult =
  | { readonly kind: "single_written"; readonly row: ImSingleWriteRow }
  | { readonly kind: "existing_owner"; readonly row: ImSingleWriteRow }

/**
 * C5-09 — admit an IM input as ONE durable write. When the switch is ON:
 *   - a NEW IM input records one durable receipt + one execution owner; the SessionV2 adapter is called
 *     ONCE (through the E4a admission bridge, which binds the bounded envelope's digest).
 *   - a REDELIVERED IM input (same message + same owner) returns `existing_owner` WITHOUT re-calling the
 *     SessionV2 adapter — one execution, never a second.
 *   - a DIFFERENT owner reclaiming the same IM input is refused (`already_owned`) — ownership fencing.
 * When the switch is OFF the module is `im_single_write_unavailable` for opt-in callers and the legacy
 * behavior stays authoritative.
 */
/** @deprecated No production caller (see module header): live single-write = im.ts flag gate +
 * EventV2Bridge. Kept as the frozen §B1 contract surface. */
export function admit(db: DatabaseClient, input: ImSingleWriteAdmitInput): Effect.Effect<ImSingleWriteResult, ImSingleWriteError> {
  return Effect.gen(function* () {
    if (!isEventV2ImSingleWriteEnabled()) {
      return yield* fail("im_single_write_unavailable", input.imMessageId, "IM single-write is OFF; the legacy double-write path stays authoritative")
    }
    if (!input.envelope || typeof input.envelope.eventRef !== "string" || input.envelope.eventRef.length === 0) {
      return yield* fail("invalid_envelope", input.imMessageId, "the IM envelope is missing its event identity")
    }

    // Ownership fencing: an existing receipt either confirms the SAME owner (exact retry → one
    // execution) or refuses a competing owner (never a silent second authority).
    const existing = yield* forImMessage(db, input.imMessageId)
    if (existing) {
      if (existing.ownerId === input.ownerID) {
        return { kind: "existing_owner", row: existing }
      }
      return yield* fail("already_owned", input.imMessageId, `IM message ${input.imMessageId} is already owned by "${existing.ownerId}"`)
    }

    // First write: admit through the E4a admission bridge (bounded envelope, one durable session input).
    // A refused admission (invalid envelope, noise, digest mismatch, bridge OFF) surfaces as a single
    // typed `admission_refused` — never a silent second authority.
    const admitted = yield* EventAdmission.admit(db, {
      envelope: input.envelope,
      sessionID: input.sessionID,
      adapter: input.sessionAdapter,
      resume: input.resume ?? true,
      now: input.now,
    }).pipe(
      Effect.mapError(
        (error) =>
          new ImSingleWriteError(
            error.reason === "admission_disabled" ? "admission_disabled" : "admission_refused",
            input.imMessageId,
            error.message,
          ),
      ),
    )
    if (admitted.kind === "disabled") {
      return yield* fail("admission_disabled", input.imMessageId, "the E4a V2 admission bridge is OFF; no durable IM input was admitted")
    }
    const receiptRef = admitted.row.envelopeDigest

    // Record the single-write receipt + owner (idempotent — a crash after admission re-records the
    // same row). The receipt is the durable proof of the one write.
    yield* db
      .insert(ImSingleWriteTable)
      .values([
        {
          im_message_id: input.imMessageId,
          event_ref: input.envelope.eventRef,
          owner_id: input.ownerID,
          generation: 1,
          receipt_ref: receiptRef,
          status: "single_written",
          created_at: input.now,
          updated_at: input.now,
        },
      ])
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const row = yield* forImMessage(db, input.imMessageId)
    return { kind: "single_written", row: row! }
  })
}
