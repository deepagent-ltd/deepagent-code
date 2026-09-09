export * as EventAdmission from "./event-admission"

import { eq, sql } from "drizzle-orm"
import { Cause, Effect } from "effect"
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
import { RuntimeFeatures, type RuntimeFeatureRegistry } from "../flag/runtime-features"

export type { RuntimeFeatureRegistry } from "../flag/runtime-features"

// C5-04 — V2 ADMISSION BRIDGE (default ON). Design authority: docs/core-v2.0-beta/design.md
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
// DEFAULT ON: the manifest-derived RuntimeFeatures registry and every production composition share
// this same default. An explicit `false`/`0` remains the fail-visible operational kill switch; behavior
// must not depend on whether a caller happened to import the CLI/desktop entrypoint first.
//
// LAYERING: `core`. The envelope is the only model-facing input; the only session dependency is the
// caller-injected `adapter` (SessionV2.prompt in production wiring). No legacy session import.

type DatabaseClient = Database.Interface["db"]

/** The typed feature switch for the V2 admission path. Unset is ON in every composition;
 * `=false`/`=0` is the explicit operational kill switch. */
export const EVENT_V2_ADMISSION_ENV = "DEEPAGENT_CODE_EVENT_V2_ADMISSION"
export const isEventV2AdmissionEnabled = (features: RuntimeFeatureRegistry = RuntimeFeatures): boolean =>
  features.enabled("event.v2.admission")

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
  /** WHY the last attempt was `refused` (strategic reason or the adapter's refusal); absent otherwise. */
  readonly reason?: string
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
  ...(row.reason != null ? { reason: row.reason } : {}),
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
  /** Startup-scoped feature snapshot; production uses the canonical process-start snapshot. */
  readonly runtimeFeatures?: RuntimeFeatureRegistry
}

export type AdmitResult =
  | { readonly kind: "admitted"; readonly row: AdmissionRow }
  | { readonly kind: "exact_retry"; readonly row: AdmissionRow }
  | { readonly kind: "disabled" }

/**
 * W5 receipts honesty — write the receipt row from the EFFECT outcome (design §8.3: "at-least-once
 * delivery 不等于重复执行副作用"; audit A4-§2.4: receipt-before-effect). `status` on the row is the
 * honest state of the durable V2 effect:
 *   - `resolved` — the SessionV2 admission effect COMPLETED (the row is written after the adapter
 *     returns; it is appended, not pre-claimed).
 *   - `refused`  — the LAST attempt was refused, whether strategically (pre-adapter: disabled / digest
 *     mismatch / invalid envelope / noise — W5 F3) or by the adapter. A refused row is RE-DRIVABLE: a
 *     later exact retry of the same identity re-runs the adapter under the SAME anchor and flips the row
 *     to `resolved` (the refusal is honest history of the last attempt, never a permanent tombstone).
 *     The `reason` column records WHY the last attempt was refused.
 *   - `admitted` — legacy pre-W5 rows / the historical "claimed, effect unknown" marker; treated as a
 *     crash window and re-driven below.
 *
 * No row is ever written BEFORE the effect (receipt-before-effect is gone). The idempotency gate for
 * duplicates is the deterministic message id (SessionV2 dedupes) plus the UNIQUE `event_ref` receipt —
 * the same envelope re-driven with the same anchor cannot produce a second durable session_input.
 */
const rowFor = (row: AdmissionRow): AdmitResult | undefined => {
  // digest was checked by the caller; resolved is the ONLY exact-retry state (idempotency key fully
  // matches: same identity + same digest + effect completed).
  if (row.status === "resolved") return { kind: "exact_retry", row }
  return undefined
}

/**
 * Write the terminal receipt row. The insert is an UPSERT-keyed append on `event_ref`: a fresh admit
 * inserts `status`; a re-drive of the same identity refreshes a legacy `admitted`/`refused` row to the
 * new outcome. The upsert is CAS-fenced (W5 F6): the update clause carries `WHERE status != 'resolved'`,
 * so a concurrent loser (or a late refused write racing a resolved one) can NEVER overwrite a terminal
 * `resolved` receipt — the honest effect-completed record wins. The winner row is returned either way
 * (the caller keeps its own typed failure/success). `admitted_at` stays the FIRST admission time
 * (identity history, not attempt time).
 */
const writeReceipt = (
  db: DatabaseClient,
  input: {
    readonly envelope: EventWorkEnvelope
    readonly sessionID: string
    readonly digest: string
    readonly status: EventAdmissionStatus
    readonly messageID?: string
    readonly reason?: string
    readonly now: number
  },
): Effect.Effect<AdmissionRow> =>
  Effect.gen(function* () {
    const row = yield* db
      .insert(DeepAgentEventAdmissionTable)
      .values({
        event_ref: input.envelope.eventRef,
        session_id: input.sessionID,
        envelope_digest: input.digest,
        status: input.status,
        message_id: input.messageID ?? null,
        reason: input.reason ?? null,
        envelope_json: JSON.stringify(encodeEventWorkEnvelope(input.envelope)),
        admitted_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoUpdate({
        target: DeepAgentEventAdmissionTable.event_ref,
        set: {
          status: input.status,
          message_id: input.messageID ?? null,
          reason: input.reason ?? null,
          updated_at: input.now,
        },
        where: sql`${DeepAgentEventAdmissionTable.status} != 'resolved'`,
      })
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (row) return decodeRow(row)
    // CAS lost — the competing writer holds `resolved`; hand back the winner (never overwritten).
    const winner = yield* admissionFor(db, input.envelope.eventRef)
    if (!winner) throw new Error("admission receipt CAS lost with no surviving row")
    return winner
  })

/**
 * Best-effort durable record of a strategic (pre-adapter) refusal (W5 F3): the row carries
 * `status: 'refused'` + the refusal `reason`, so the ledger shows WHY the last attempt was refused even
 * when the adapter never ran. The envelope must round-trip the frozen DECODE (encodeSync is stricter on
 * non-instance shapes, so the decode round-trip is the honest recordability boundary): an
 * unrepresentable envelope (e.g. an excess-property "invalid_envelope") is still refused typed, just
 * without a row — a non-round-trippable `envelope_json` would poison every later read of the receipt
 * identity. Any row write failure is swallowed: the refusal itself is the authority, the record is
 * best-effort diagnostics.
 */
const recordStrategicRefusal = (
  db: DatabaseClient,
  input: {
    readonly envelope: EventWorkEnvelope
    readonly sessionID: string
    readonly reason: AdmissionErrorReason
    readonly messageID?: string
    readonly now: number
  },
): Effect.Effect<void> =>
  Effect.try({
    try: () => {
      const canonical = decodeEventWorkEnvelope(JSON.parse(JSON.stringify(input.envelope)) as unknown)
      return { envelope: canonical, digest: eventWorkEnvelopeDigest(canonical) }
    },
    catch: (error) => error,
  }).pipe(
    Effect.flatMap(({ envelope, digest }) =>
      writeReceipt(db, {
        envelope,
        sessionID: input.sessionID,
        digest,
        status: "refused",
        reason: input.reason,
        ...(input.messageID != null ? { messageID: input.messageID } : {}),
        now: input.now,
      }),
    ),
    Effect.asVoid,
    Effect.catchCause(() => Effect.void),
  )

/**
 * C5-04 — admit a bounded work envelope as durable V2 session work.
 *
 * FAIL-CLOSED (typed refusal):
 *   - `admission_disabled`       the V2 admission switch is OFF (the migration is behind the flag).
 *   - `invalid_envelope`         the envelope does not round-trip the frozen contract.
 *   - `envelope_noise`           coordination/operational noise (never admitted, §8.8).
 *   - `envelope_digest_mismatch` re-admitting the SAME identity with a DIFFERENT digest.
 *
 * EXACT RETRY (design §2.3): re-admitting the SAME envelope identity with the SAME digest whose EFFECT
 * already completed (`resolved`) returns the existing receipt (`exact_retry`) WITHOUT re-calling the
 * session adapter — the durable SessionV2 row (idempotent by message id) is unchanged. Any receipt that
 * is NOT resolved (legacy `admitted` crash window, or a `refused` last attempt) is re-driven: the
 * adapter is called again with the SAME message id and SessionV2 dedupes, so the effect never runs twice.
 *
 * RECEIPT HONESTY (W5): the receipt row is written AFTER the effect completes (design §8.3 /
 * audit A4-§2.4 — receipt-before-effect could permanently drop work when the adapter failed). On adapter
 * success the row is `resolved`; on adapter refusal the row is `refused` and the admission fails typed —
 * the caller nacks; the retry pump re-drives and the same message id dedupes at SessionV2.
 *
 * The model-facing work is the BOUNDED envelope: `envelopePromptText` serializes the envelope (never the
 * raw payload). The actual SessionV2.prompt call is the injected `adapter`; this module never touches
 * legacy `SessionPrompt`.
 */
export function admit(db: DatabaseClient, input: AdmitInput): Effect.Effect<AdmitResult, EventAdmissionError> {
  return Effect.gen(function* () {
    if (!isEventV2AdmissionEnabled(input.runtimeFeatures)) {
      // W5 F3 — a strategic refusal is ALSO a refused receipt (the last attempt was refused: disabled).
      yield* recordStrategicRefusal(db, {
        envelope: input.envelope,
        sessionID: input.sessionID,
        reason: "admission_disabled",
        ...(input.messageID != null ? { messageID: input.messageID } : {}),
        now: input.now,
      })
      return yield* refuse(
        "admission_disabled",
        input.envelope.eventRef,
        `event V2 admission is disabled (${EVENT_V2_ADMISSION_ENV} is not "true"); the legacy event turn path serves (design §8.7 default-off discipline)`,
      )
    }

    // W5 F3 — an envelope that does not round-trip the frozen contract (or is §8.8 noise) is a strategic
    // refusal: the refusal is recorded as a `refused` receipt (best-effort) BEFORE the adapter is ever
    // consulted, then fails typed.
    const envelope = yield* validateEnvelope(input.envelope).pipe(
      Effect.catch((error) =>
        recordStrategicRefusal(db, {
          envelope: input.envelope,
          sessionID: input.sessionID,
          reason: error.reason,
          ...(input.messageID != null ? { messageID: input.messageID } : {}),
          now: input.now,
        }).pipe(Effect.andThen(Effect.fail(error))),
      ),
    )

    // BIND the admission to the envelope hash (design §8.4). The digest is byte-stable over the
    // bounded envelope; it never sees the raw payload.
    const digest = eventWorkEnvelopeDigest(envelope)

    const existing = yield* admissionFor(db, envelope.eventRef)
    if (existing) {
      if (existing.envelopeDigest !== digest) {
        // W5 F3 — the refusal is recorded (the row keeps the ORIGINAL identity digest: a retry must
        // present the original work to be re-admitted; changed work under the same identity is never
        // silently re-admitted) and the admission fails typed.
        yield* recordStrategicRefusal(db, {
          envelope,
          sessionID: input.sessionID,
          reason: "envelope_digest_mismatch",
          ...(existing.messageID != null ? { messageID: existing.messageID } : {}),
          now: input.now,
        })
        return yield* refuse(
          "envelope_digest_mismatch",
          envelope.eventRef,
          `admission for "${envelope.eventRef}" carries envelope digest "${existing.envelopeDigest}" but this admission presents "${digest}"; refusing to bind changed work to the same identity`,
        )
      }
      const retry = rowFor(existing)
      if (retry) return retry
      // `admitted` (legacy crash window) / `refused` (last attempt was refused): re-drive below with the
      // SAME message id — the durable effect is idempotent at SessionV2, never duplicated.
    }

    // W5 F2 — the exact-retry anchor is the row's STORED message id when one exists (the first attempt's
    // SessionV2 anchor), so a re-drive from ANY lane (spool, dispatcher, etc.) re-anchors the SAME
    // SessionV2 input and reconcile-dedupes there — never a second session_input. The caller-supplied
    // anchor is only the fallback for a first attempt.
    const messageID = existing?.messageID ?? input.messageID
    const delivery = input.delivery ?? "steer"
    const resume = input.resume ?? true

    // EFFECT FIRST (design §8.3 receipt honesty): the SessionV2 admission is the effect; the receipt row
    // is written from its outcome — never before it. The deterministic message id makes a re-drive a
    // SessionV2 dedupe (no second session_input), and the UNIQUE event_ref receipt gates duplicates.
    const outcome = yield* input.adapter
      .admit({
        envelope,
        sessionID: input.sessionID,
        ...(messageID != null ? { messageID } : {}),
        delivery,
        resume,
        promptText: envelopePromptText(envelope),
      })
      .pipe(Effect.exit)

    if (outcome._tag === "Failure") {
      const message = (Cause.squash(outcome.cause) as { readonly message?: string } | undefined)?.message ??
        "session V2 admission refused"
      // Honest terminal record: the effect never completed → `refused` (never `resolved`); the reason
      // records it as an ADAPTER refusal (distinct from the strategic pre-adapter refusals).
      yield* writeReceipt(db, {
        envelope,
        sessionID: input.sessionID,
        digest,
        status: "refused",
        reason: "admit_refused",
        ...(messageID != null ? { messageID } : {}),
        now: input.now,
      })
      return yield* Effect.fail(new EventAdmissionError("admit_refused", envelope.eventRef, message))
    }

    // RECEIPT AFTER EFFECT: the durable V2 admission completed → `resolved` (terminal).
    const resolvedMessageID = outcome.value.messageID ?? messageID
    const row = yield* writeReceipt(db, {
      envelope,
      sessionID: input.sessionID,
      digest,
      status: "resolved",
      ...(resolvedMessageID != null ? { messageID: resolvedMessageID } : {}),
      now: input.now,
    })
    return { kind: "admitted", row }
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
