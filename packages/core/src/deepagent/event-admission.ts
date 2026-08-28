export * as EventAdmission from "./event-admission"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import {
  decodeEventWorkEnvelope,
  encodeEventWorkEnvelope,
  eventWorkEnvelopeDigest,
  validateEventWorkEnvelope,
  type EventWorkEnvelope,
} from "../contract/event-envelope"
import { EventWorkEnvelope as EnvelopePolicy } from "./event-work-envelope"
import { DeepAgentEventAdmissionTable, type EventAdmissionStatus } from "./event-admission-sql"

// C5-04 — V2 ADMISSION BRIDGE (default OFF). Design authority: docs/core-v2.0-beta/design.md
// §8.4 ("V2 admission receipt 绑定 envelope hash" — the admission receipt binds the bounded work
// envelope hash) + §8.5 (event -> durable V2 work; each node is a durable SessionV2 admission) +
// §8.7 (event turn runner must call SessionV2/SessionExecution, never legacy SessionPrompt.prompt).
//
// THIS MODULE IS THE BOUNDARY THE C5 EVENT SYSTEM USES TO ADMIT EVENT WORK AS DURABLE V2 SESSION
// WORK. A bounded `EventWorkEnvelope` (C5-03) is handed here; the module:
//   (a) BINDS the admission to the envelope hash: the durable receipt row carries the byte-stable
//       `envelope_digest`. Re-admitting the SAME envelope identity with the SAME digest is an
//       EXACT-RETRY no-op; the SAME identity with a DIFFERENT digest is a typed refusal
//       (`envelope_digest_mismatch`) — never a silent re-admission of changed work.
//   (b) ADMITS via SessionV2.prompt semantics: the model-facing work is the BOUNDED envelope, never
//       the raw external payload. The module serializes the bounded envelope into the prompt text; the
//       raw payload lives only by reference (contentType/ref/hash) and never reaches the module.
//   (c) NEVER bridges through legacy `SessionPrompt.prompt` and never delegates orchestration to an
//       in-memory tool loop (AGENTS.md "V2 Session Core"). The actual SessionV2.prompt call is the
//       caller-supplied `adapter`, so this module has no legacy-session dependency at all.
//
// DEFAULT OFF: the admission path is gated by a module-local typed switch (`isEventV2AdmissionEnabled`,
// default OFF). The frozen capability catalog has no event-v2-admission runtime feature (C4 frozen — see
// `RuntimeFeatures`/`DeepAgentCodeToolInventory.runtimeFeatures`), so per the wave manifest §2 this lane
// uses the F3 shadow pattern: a module-local switch default OFF + a catalog-promotion item. Until the
// feature is promoted + toggled ON, the legacy event turn path remains authoritative and unchanged.
//
// LAYERING: `core`. The envelope is the only model-facing input; the only session dependency is the
// caller-injected `adapter` (SessionV2.prompt in production wiring). No legacy session import.

type DatabaseClient = Database.Interface["db"]

/** The typed feature switch for the V2 admission path. Default OFF (never a hardcoded ON). */
export const EVENT_V2_ADMISSION_ENV = "DEEPAGENT_CODE_EVENT_V2_ADMISSION"
export const isEventV2AdmissionEnabled = (): boolean => {
  const value = process.env[EVENT_V2_ADMISSION_ENV]?.toLowerCase()
  return value === "true" || value === "1"
}

/** Why an admission was refused. Fail-closed; each reason is a typed refusal. */
export type AdmissionErrorReason =
  | "admission_disabled"
  | "envelope_digest_mismatch"
  | "invalid_envelope"
  | "envelope_noise"
  | "admit_refused"

/** Typed refusal thrown through the Effect failure channel (never a buried throw). */
export class EventAdmissionError extends Error {
  readonly _tag = "EventAdmission.EventAdmissionError"
  readonly reason: AdmissionErrorReason
  readonly eventRef: string
  constructor(reason: AdmissionErrorReason, eventRef: string, message: string) {
    super(message)
    this.name = "EventAdmissionError"
    this.reason = reason
    this.eventRef = eventRef
  }
}

/** Durable admission receipt row (as read from the ledger). */
export type AdmissionRow = {
  readonly eventRef: string
  readonly sessionID: string
  readonly envelopeDigest: string
  readonly status: EventAdmissionStatus
  readonly messageID?: string
  readonly envelope: EventWorkEnvelope
  readonly admittedAt: number
  readonly updatedAt: number
}

const decodeRow = (row: typeof DeepAgentEventAdmissionTable.$inferSelect): AdmissionRow => ({
  eventRef: row.event_ref,
  sessionID: row.session_id,
  envelopeDigest: row.envelope_digest,
  status: row.status as EventAdmissionStatus,
  ...(row.message_id != null ? { messageID: row.message_id } : {}),
  envelope: decodeEventWorkEnvelope(JSON.parse(row.envelope_json) as unknown),
  admittedAt: row.admitted_at,
  updatedAt: row.updated_at,
})

const refuse = <E>(reason: AdmissionErrorReason, eventRef: string, message: string) =>
  Effect.fail(new EventAdmissionError(reason, eventRef, message))

/** `SessionV2.prompt`'s delivery dimension (from `SessionInput.Delivery` — steers by default). */
export type AdmissionDelivery = "steer" | "queue" | "goal_steer"

/**
 * The caller-supplied session adapter that performs the ACTUAL durable SessionV2 admission. In
 * production wiring this is `(yield* SessionV2.Service).prompt(...)` — it admits one durable
 * `session_input` row and then schedules the advisory `SessionExecution.wake`. The module passes it
 * the BOUNDED envelope (never the raw payload); the adapter builds the bounded `Prompt` from it.
 */
export interface SessionWorkAdapter {
  readonly admit: (input: {
    readonly envelope: EventWorkEnvelope
    readonly sessionID: string
    readonly messageID?: string
    readonly delivery: AdmissionDelivery
    readonly resume: boolean
    readonly promptText: string
  }) => Effect.Effect<{ readonly messageID?: string }, unknown>
}

/**
 * The bounded prompt text the model receives for a work envelope. This is the frozen-bounded envelope
 * itself, NOT the raw external payload — the envelope carries the payload only by reference
 * (`contentType`/`ref`/`payloadHash`), so re-serializing it can never leak raw bytes, credentials, or
 * an unbounded history into the prompt (design §8.4 / §8.8). The runner assembles model input from
 * the envelope + System Context + four-graph selection, never from raw event data.
 */
export const envelopePromptText = (envelope: EventWorkEnvelope): string =>
  JSON.stringify(encodeEventWorkEnvelope(envelope))

/** Validate that `envelope` is a well-formed bounded work envelope (and not model noise). */
const validateEnvelope = (envelope: EventWorkEnvelope): Effect.Effect<EventWorkEnvelope, EventAdmissionError> =>
  Effect.gen(function* () {
    if (EnvelopePolicy.isNoiseEvent(envelope.eventType)) {
      return yield* refuse(
        "envelope_noise",
        envelope.eventRef,
        `envelope type "${envelope.eventType}" is coordination/operational noise and must never be admitted (design §8.8)`,
      )
    }
    // Re-validate through the frozen contract (non-throwing): an envelope that does not round-trip is
    // a typed refusal, never a buried defect.
    const validation = validateEventWorkEnvelope(envelope)
    if (!validation.ok) {
      return yield* refuse(
        "invalid_envelope",
        envelope.eventRef,
        `envelope "${envelope.eventRef}" failed the frozen contract validation: ${validation.error.message}`,
      )
    }
    return validation.value
  })

/** The durable admission ledger read — is there a receipt for this envelope identity? */
export function admissionFor(db: DatabaseClient, eventRef: string): Effect.Effect<AdmissionRow | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(DeepAgentEventAdmissionTable)
      .where(eq(DeepAgentEventAdmissionTable.event_ref, eventRef))
      .get()
      .pipe(Effect.orDie)
    return row ? decodeRow(row) : undefined
  })
}

export interface AdmitInput {
  readonly envelope: EventWorkEnvelope
  /** The session the work is admitted to (the caller's SessionV2.ID, stored opaquely in core). */
  readonly sessionID: string
  /** Exact-retry anchor (SessionV2 prompt message id). Omit for a fresh admission. */
  readonly messageID?: string
  readonly delivery?: AdmissionDelivery
  /** Default true: schedule the advisory SessionExecution.wake after the durable row. */
  readonly resume?: boolean
  /** The session adapter to perform the durable SessionV2 admission. */
  readonly adapter: SessionWorkAdapter
  readonly now: number
}

export type AdmitResult =
  | { readonly kind: "admitted"; readonly row: AdmissionRow }
  | { readonly kind: "exact_retry"; readonly row: AdmissionRow }
  | { readonly kind: "disabled" }

/**
 * C5-04 — admit a bounded work envelope as durable V2 session work.
 *
 * FAIL-CLOSED (typed refusal):
 *   - `admission_disabled`       the V2 admission switch is OFF (the migration is behind the flag).
 *   - `invalid_envelope`         the envelope does not round-trip the frozen contract.
 *   - `envelope_noise`           coordination/operational noise (never admitted, §8.8).
 *   - `envelope_digest_mismatch` re-admitting the SAME identity with a DIFFERENT digest.
 *
 * EXACT RETRY (design §2.3): re-admitting the SAME envelope identity with the SAME digest returns the
 * existing receipt (`exact_retry`) WITHOUT re-calling the session adapter — the durable SessionV2 row
 * (idempotent by message id) is unchanged. A crash after the durable receipt but before the session
 * adapter commits is recovered by re-driving the admission with the SAME message id; SessionV2 dedupes.
 *
 * The model-facing work is the BOUNDED envelope: `envelopePromptText` serializes the envelope (never the
 * raw payload). The actual SessionV2.prompt call is the injected `adapter`; this module never touches
 * legacy `SessionPrompt`.
 */
export function admit(db: DatabaseClient, input: AdmitInput): Effect.Effect<AdmitResult, EventAdmissionError> {
  return Effect.gen(function* () {
    if (!isEventV2AdmissionEnabled()) {
      return yield* refuse(
        "admission_disabled",
        input.envelope.eventRef,
        `event V2 admission is disabled (${EVENT_V2_ADMISSION_ENV} is not "true"); the legacy event turn path serves (design §8.7 default-off discipline)`,
      )
    }

    const envelope = yield* validateEnvelope(input.envelope)

    // BIND the admission to the envelope hash (design §8.4). The digest is byte-stable over the
    // bounded envelope; it never sees the raw payload.
    const digest = eventWorkEnvelopeDigest(envelope)

    const existing = yield* admissionFor(db, envelope.eventRef)
    if (existing) {
      if (existing.envelopeDigest !== digest) {
        return yield* refuse(
          "envelope_digest_mismatch",
          envelope.eventRef,
          `admission for "${envelope.eventRef}" carries envelope digest "${existing.envelopeDigest}" but this admission presents "${digest}"; refusing to bind changed work to the same identity`,
        )
      }
      // Exact retry: the same envelope was already admitted — no-op, never a second session_input.
      return { kind: "exact_retry", row: existing }
    }

    const messageID = input.messageID
    const delivery = input.delivery ?? "steer"
    const resume = input.resume ?? true
    const envelopeJson = JSON.stringify(encodeEventWorkEnvelope(envelope))

    const inserted = yield* db
      .insert(DeepAgentEventAdmissionTable)
      .values({
        event_ref: envelope.eventRef,
        session_id: input.sessionID,
        envelope_digest: digest,
        status: "admitted" as const,
        message_id: messageID ?? null,
        envelope_json: envelopeJson,
        admitted_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoNothing({ target: DeepAgentEventAdmissionTable.event_ref })
      .returning()
      .get()
      .pipe(Effect.orDie)

    if (!inserted) {
      // A racing duplicate landed between the read-check and the insert; return the winner.
      const winner = yield* admissionFor(db, envelope.eventRef)
      if (!winner) throw new Error("event admission lost the idempotency race with no surviving row")
      if (winner.envelopeDigest !== digest) {
        return yield* refuse(
          "envelope_digest_mismatch",
          envelope.eventRef,
          `admission for "${envelope.eventRef}" was concurrently bound to digest "${winner.envelopeDigest}" but this admission presents "${digest}"`,
        )
      }
      return { kind: "exact_retry", row: winner }
    }

    const row = decodeRow(inserted)

    // ADMIT as durable V2 work: the model-facing work is the bounded envelope (never the raw payload).
    // The adapter performs SessionV2.prompt semantics (durable session_input row, then advisory wake).
    const admitted = yield* input.adapter.admit({
      envelope,
      sessionID: input.sessionID,
      ...(messageID != null ? { messageID } : {}),
      delivery,
      resume,
      promptText: envelopePromptText(envelope),
    }).pipe(
      Effect.mapError((cause) => new EventAdmissionError("admit_refused", envelope.eventRef, String(cause))),
    )

    if (admitted.messageID != null && messageID == null) {
      yield* db
        .update(DeepAgentEventAdmissionTable)
        .set({ message_id: admitted.messageID, updated_at: input.now })
        .where(eq(DeepAgentEventAdmissionTable.event_ref, envelope.eventRef))
        .run()
        .pipe(Effect.orDie)
    }

    const finalRow = yield* admissionFor(db, envelope.eventRef)
    return { kind: "admitted", row: finalRow ?? row }
  })
}

/** View: all admission receipts for a session (backlog/metrics). */
export function forSession(db: DatabaseClient, sessionID: string): Effect.Effect<ReadonlyArray<AdmissionRow>> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(DeepAgentEventAdmissionTable)
      .where(eq(DeepAgentEventAdmissionTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    return rows.map(decodeRow)
  })
}
