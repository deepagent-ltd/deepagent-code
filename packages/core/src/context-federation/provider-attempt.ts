export * as SessionProviderAttempt from "./provider-attempt"

import { randomBytes } from "node:crypto"
import { and, desc, eq, inArray, max } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { SessionSchema } from "../session/schema"
import {
  SessionContextSelectionTable,
  SessionContextValidationTable,
  SessionActivityTable,
  SessionProviderAttemptResolutionTable,
  SessionProviderAttemptTable,
} from "./session-sql"

export type State = typeof SessionProviderAttemptTable.$inferSelect.state
export type Attempt = {
  readonly attemptId: string
  readonly sessionId: SessionSchema.ID
  readonly activityId: string
  readonly providerTurnSeq: number
  readonly selectionId: string
  readonly projectionHash: string
  readonly requestHash: string
  readonly providerId: string
  readonly parentAttemptId?: string
  readonly idempotencyKey?: string
  readonly state: State
  readonly createdAt: number
  readonly firstEventAt?: number
  readonly settledAt?: number
  readonly errorCode?: string
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "SessionProviderAttempt.NotFoundError",
  {},
) {}
export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()(
  "SessionProviderAttempt.ConflictError",
  { reason: Schema.String.pipe(Schema.optional) },
) {}
export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()(
  "SessionProviderAttempt.InvalidStateError",
  { state: Schema.String },
) {}
export class ValidationRequiredError extends Schema.TaggedErrorClass<ValidationRequiredError>()(
  "SessionProviderAttempt.ValidationRequiredError",
  {},
) {}
export class UnsafeRetryError extends Schema.TaggedErrorClass<UnsafeRetryError>()(
  "SessionProviderAttempt.UnsafeRetryError",
  { state: Schema.String },
) {}
export class ResolutionDeniedError extends Schema.TaggedErrorClass<ResolutionDeniedError>()(
  "SessionProviderAttempt.ResolutionDeniedError",
  {},
) {}
export class ResolutionEvidenceError extends Schema.TaggedErrorClass<ResolutionEvidenceError>()(
  "SessionProviderAttempt.ResolutionEvidenceError",
  {},
) {}
export class ReplayRiskError extends Schema.TaggedErrorClass<ReplayRiskError>()(
  "SessionProviderAttempt.ReplayRiskError",
  {},
) {}

export type Error =
  | NotFoundError
  | ConflictError
  | InvalidStateError
  | ValidationRequiredError
  | UnsafeRetryError
  | ResolutionDeniedError
  | ResolutionEvidenceError
  | ReplayRiskError

export type PrepareInput = {
  readonly attemptId?: string
  readonly sessionId: SessionSchema.ID
  readonly activityId: string
  readonly providerTurnSeq: number
  readonly selectionId: string
  readonly projectionHash: string
  readonly requestHash: string
  readonly providerId: string
  readonly parentAttemptId?: string
  readonly idempotencyKey?: string
  readonly authorizationEpoch: number
  readonly egressEpoch: number
  readonly selectedSourceFingerprint: string
  readonly observedLocationMutationEpoch: number
  readonly now?: number
}

export type ResolutionInput = {
  readonly attemptId: string
  readonly actor: {
    readonly type: "user" | "administrator" | "system"
    readonly id: string
    readonly canResolve: boolean
    readonly canAcknowledgeReplayRisk: boolean
  }
  readonly decision: "abandoned" | "settled" | "replayed"
  readonly providerEvidence?:
    | {
        readonly kind: "provider_status_lookup"
        readonly providerId: string
        readonly requestHash: string
        readonly reference: string
        readonly observedAt: number
      }
    | {
        readonly kind: "persisted_terminal_event"
        readonly requestHash: string
        readonly eventId: string
        readonly observedAt: number
      }
  readonly riskAcknowledged: boolean
  readonly reason: string
  readonly idempotencyProof?: {
    readonly providerId: string
    readonly requestHash: string
    readonly idempotencyKey: string
    readonly contractVersion: string
  }
  readonly replay?: Omit<
    PrepareInput,
    "activityId" | "selectionId" | "projectionHash" | "requestHash" | "providerId" | "parentAttemptId"
  >
  readonly now?: number
}

export interface Interface {
  readonly prepare: (input: PrepareInput) => Effect.Effect<Attempt, Error>
  readonly markDispatching: (attemptId: string, now?: number) => Effect.Effect<Attempt, Error>
  readonly markStreaming: (attemptId: string, now?: number) => Effect.Effect<Attempt, Error>
  readonly settle: (input: {
    readonly attemptId: string
    readonly outcome: "settled" | "failed"
    readonly errorCode?: string
    readonly now?: number
  }) => Effect.Effect<Attempt, Error>
  readonly recoverIndeterminate: (sessionId: SessionSchema.ID, now?: number) => Effect.Effect<number>
  readonly resolve: (
    input: ResolutionInput,
  ) => Effect.Effect<{ readonly attempt: Attempt; readonly replay?: Attempt }, Error>
  readonly get: (attemptId: string) => Effect.Effect<Attempt | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionProviderAttempt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const get = Effect.fn("SessionProviderAttempt.get")(function* (attemptId: string) {
      const row = yield* db
        .select()
        .from(SessionProviderAttemptTable)
        .where(eq(SessionProviderAttemptTable.attempt_id, attemptId))
        .get()
        .pipe(Effect.orDie)
      return row ? attempt(row) : undefined
    })

    const prepare = Effect.fn("SessionProviderAttempt.prepare")(function* (input: PrepareInput) {
      return yield* db.transaction((tx) => prepareInTransaction(tx, input)).pipe(preserveErrors)
    })

    const transition = Effect.fn("SessionProviderAttempt.transition")(function* (input: {
      readonly attemptId: string
      readonly from: readonly State[]
      readonly to: State
      readonly now: number
      readonly firstEvent?: boolean
      readonly errorCode?: string
    }) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select()
              .from(SessionProviderAttemptTable)
              .where(eq(SessionProviderAttemptTable.attempt_id, input.attemptId))
              .get()
            if (!row) return yield* new NotFoundError()
            if (!input.from.includes(row.state)) return yield* new InvalidStateError({ state: row.state })
            const terminal = isTerminal(input.to)
            yield* tx
              .update(SessionProviderAttemptTable)
              .set({
                state: input.to,
                ...(input.firstEvent && row.first_event_at === null ? { first_event_at: input.now } : {}),
                ...(terminal ? { settled_at: input.now } : {}),
                ...(input.errorCode ? { error_code: input.errorCode } : {}),
              })
              .where(
                and(
                  eq(SessionProviderAttemptTable.attempt_id, input.attemptId),
                  eq(SessionProviderAttemptTable.state, row.state),
                ),
              )
              .run()
            return attempt({
              ...row,
              state: input.to,
              ...(input.firstEvent && row.first_event_at === null ? { first_event_at: input.now } : {}),
              ...(terminal ? { settled_at: input.now } : {}),
              ...(input.errorCode ? { error_code: input.errorCode } : {}),
            })
          }),
        )
        .pipe(preserveErrors)
    })

    const markDispatching = (attemptId: string, now = Date.now()) =>
      transition({ attemptId, from: ["prepared"], to: "dispatching", now })
    const markStreaming = (attemptId: string, now = Date.now()) =>
      transition({ attemptId, from: ["dispatching"], to: "streaming", now, firstEvent: true })
    const settle = (input: {
      readonly attemptId: string
      readonly outcome: "settled" | "failed"
      readonly errorCode?: string
      readonly now?: number
    }) => {
      if (input.outcome === "settled" && input.errorCode) return Effect.fail(new ConflictError())
      return transition({
        attemptId: input.attemptId,
        from: ["dispatching", "streaming"],
        to: input.outcome,
        now: input.now ?? Date.now(),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      })
    }

    const recoverIndeterminate = Effect.fn("SessionProviderAttempt.recoverIndeterminate")(function* (
      sessionId: SessionSchema.ID,
      _now = Date.now(),
    ) {
      const rows = yield* db
        .update(SessionProviderAttemptTable)
        .set({ state: "indeterminate_after_crash", error_code: "process_recovery" })
        .where(
          and(
            eq(SessionProviderAttemptTable.session_id, sessionId),
            inArray(SessionProviderAttemptTable.state, ["dispatching", "streaming"]),
          ),
        )
        .returning({ attempt_id: SessionProviderAttemptTable.attempt_id })
        .all()
        .pipe(Effect.orDie)
      return rows.length
    })

    const resolve = Effect.fn("SessionProviderAttempt.resolve")(function* (input: ResolutionInput) {
      if (!input.actor.canResolve || input.actor.type === "system") return yield* new ResolutionDeniedError()
      if (!input.reason.trim()) return yield* new ResolutionEvidenceError()
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select()
              .from(SessionProviderAttemptTable)
              .where(eq(SessionProviderAttemptTable.attempt_id, input.attemptId))
              .get()
            if (!row) return yield* new NotFoundError()
            if (row.state !== "indeterminate_after_crash") return yield* new InvalidStateError({ state: row.state })
            if (input.decision === "settled" && !validProviderEvidence(input.providerEvidence, row)) {
              return yield* new ResolutionEvidenceError()
            }
            if (
              input.decision === "replayed" &&
              !validIdempotencyProof(input.idempotencyProof, row) &&
              !(input.riskAcknowledged && input.actor.canAcknowledgeReplayRisk)
            ) {
              return yield* new ReplayRiskError()
            }
            if (input.decision === "replayed" && !input.replay) {
              return yield* new ReplayRiskError()
            }
            if (
              input.decision === "replayed" &&
              input.idempotencyProof &&
              !validIdempotencyProof(input.idempotencyProof, row)
            ) {
              return yield* new ResolutionEvidenceError()
            }
            const resolutionId = opaque("resolution")
            yield* tx
              .insert(SessionProviderAttemptResolutionTable)
              .values({
                resolution_id: resolutionId,
                attempt_id: row.attempt_id,
                actor_type: input.actor.type,
                actor_id: input.actor.id,
                decision: input.decision,
                provider_evidence: input.providerEvidence
                  ? JSON.stringify(input.providerEvidence)
                  : input.idempotencyProof
                    ? JSON.stringify({ kind: "idempotency_contract", ...input.idempotencyProof })
                    : null,
                risk_acknowledged: input.riskAcknowledged,
                reason: input.reason,
                created_at: input.now ?? Date.now(),
              })
              .run()
            const nextState = `resolved_${input.decision}` as const
            const settledAt = input.now ?? Date.now()
            yield* tx
              .update(SessionProviderAttemptTable)
              .set({ state: nextState, settled_at: settledAt })
              .where(
                and(
                  eq(SessionProviderAttemptTable.attempt_id, row.attempt_id),
                  eq(SessionProviderAttemptTable.state, "indeterminate_after_crash"),
                ),
              )
              .run()
            if (input.decision !== "replayed") {
              const activityState = input.decision === "abandoned" ? "interrupted" : "settled"
              const activity = yield* tx
                .update(SessionActivityTable)
                .set({ state: activityState, settled_at: settledAt })
                .where(
                  and(eq(SessionActivityTable.activity_id, row.activity_id), eq(SessionActivityTable.state, "active")),
                )
                .returning({ activity_id: SessionActivityTable.activity_id })
                .get()
              if (!activity) return yield* new ConflictError({ reason: "activity_not_active" })
            }
            const replay = input.replay
              ? yield* prepareInTransaction(tx, {
                  ...input.replay,
                  activityId: row.activity_id,
                  selectionId: row.selection_id,
                  projectionHash: row.projection_hash,
                  requestHash: row.request_hash,
                  providerId: row.provider_id,
                  parentAttemptId: row.attempt_id,
                  idempotencyKey: row.idempotency_key ?? undefined,
                  now: input.now,
                })
              : undefined
            return {
              attempt: attempt({ ...row, state: nextState, settled_at: settledAt }),
              ...(replay ? { replay } : {}),
            }
          }),
        )
        .pipe(preserveErrors)
    })

    return Service.of({ prepare, markDispatching, markStreaming, settle, recoverIndeterminate, resolve, get })
  }),
)

function prepareInTransaction(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  input: PrepareInput,
) {
  return Effect.gen(function* () {
    const selection = yield* tx
      .select()
      .from(SessionContextSelectionTable)
      .where(eq(SessionContextSelectionTable.selection_id, input.selectionId))
      .get()
    if (!selection) return yield* new NotFoundError()
    if (
      selection.session_id !== input.sessionId ||
      selection.activity_id !== input.activityId ||
      selection.projection_hash !== input.projectionHash
    ) {
      return yield* new ConflictError({ reason: "selection_binding_mismatch" })
    }
    const validation = yield* tx
      .select()
      .from(SessionContextValidationTable)
      .where(
        and(
          eq(SessionContextValidationTable.selection_id, input.selectionId),
          eq(SessionContextValidationTable.provider_turn_seq, input.providerTurnSeq),
        ),
      )
      .orderBy(desc(SessionContextValidationTable.validated_at))
      .get()
    const now = input.now ?? Date.now()
    if (
      !validation ||
      validation.outcome !== "valid" ||
      validation.authorization_epoch !== input.authorizationEpoch ||
      validation.egress_epoch !== input.egressEpoch ||
      validation.observed_location_mutation_epoch !== input.observedLocationMutationEpoch ||
      validation.selected_source_fingerprint !== input.selectedSourceFingerprint ||
      validation.valid_until <= now
    ) {
      return yield* new ValidationRequiredError()
    }
    const existing = yield* tx
      .select()
      .from(SessionProviderAttemptTable)
      .where(
        and(
          eq(SessionProviderAttemptTable.session_id, input.sessionId),
          eq(SessionProviderAttemptTable.provider_turn_seq, input.providerTurnSeq),
        ),
      )
      .get()
    if (existing) {
      if (existing.state !== "prepared") return yield* new UnsafeRetryError({ state: existing.state })
      if (
        existing.activity_id !== input.activityId ||
        existing.selection_id !== input.selectionId ||
        existing.projection_hash !== input.projectionHash ||
        existing.request_hash !== input.requestHash ||
        existing.provider_id !== input.providerId ||
        (existing.parent_attempt_id ?? undefined) !== input.parentAttemptId ||
        (existing.idempotency_key ?? undefined) !== input.idempotencyKey
      ) {
        return yield* new ConflictError({ reason: "prepared_attempt_binding_mismatch" })
      }
      return attempt(existing)
    }
    const latest = yield* tx
      .select({ provider_turn_seq: max(SessionProviderAttemptTable.provider_turn_seq) })
      .from(SessionProviderAttemptTable)
      .where(eq(SessionProviderAttemptTable.session_id, input.sessionId))
      .get()
    if (latest?.provider_turn_seq !== null && latest?.provider_turn_seq !== undefined) {
      if (input.providerTurnSeq !== latest.provider_turn_seq + 1) {
        return yield* new ConflictError({ reason: "provider_turn_sequence" })
      }
    }
    if (input.parentAttemptId) {
      const parent = yield* tx
        .select()
        .from(SessionProviderAttemptTable)
        .where(eq(SessionProviderAttemptTable.attempt_id, input.parentAttemptId))
        .get()
      if (
        !parent ||
        parent.state !== "resolved_replayed" ||
        parent.session_id !== input.sessionId ||
        parent.activity_id !== input.activityId ||
        parent.selection_id !== input.selectionId ||
        parent.projection_hash !== input.projectionHash ||
        parent.request_hash !== input.requestHash ||
        parent.provider_id !== input.providerId ||
        (parent.idempotency_key ?? undefined) !== input.idempotencyKey
      ) {
        return yield* new ConflictError({ reason: "replay_parent_binding_mismatch" })
      }
    }
    const row: typeof SessionProviderAttemptTable.$inferInsert = {
      attempt_id: input.attemptId ?? opaque("attempt"),
      session_id: input.sessionId,
      activity_id: input.activityId,
      provider_turn_seq: input.providerTurnSeq,
      selection_id: input.selectionId,
      projection_hash: input.projectionHash,
      request_hash: input.requestHash,
      provider_id: input.providerId,
      parent_attempt_id: input.parentAttemptId,
      idempotency_key: input.idempotencyKey,
      state: "prepared",
      created_at: now,
    }
    yield* tx.insert(SessionProviderAttemptTable).values(row).run()
    return attempt({
      ...row,
      parent_attempt_id: row.parent_attempt_id ?? null,
      idempotency_key: row.idempotency_key ?? null,
      first_event_at: null,
      settled_at: null,
      error_code: null,
    })
  })
}

function attempt(row: typeof SessionProviderAttemptTable.$inferSelect): Attempt {
  return {
    attemptId: row.attempt_id,
    sessionId: SessionSchema.ID.make(row.session_id),
    activityId: row.activity_id,
    providerTurnSeq: row.provider_turn_seq,
    selectionId: row.selection_id,
    projectionHash: row.projection_hash,
    requestHash: row.request_hash,
    providerId: row.provider_id,
    ...(row.parent_attempt_id ? { parentAttemptId: row.parent_attempt_id } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    state: row.state,
    createdAt: row.created_at,
    ...(row.first_event_at !== null ? { firstEventAt: row.first_event_at } : {}),
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  }
}

function isTerminal(state: State) {
  return ["settled", "failed", "resolved_abandoned", "resolved_settled", "resolved_replayed"].includes(state)
}

function validProviderEvidence(
  evidence: ResolutionInput["providerEvidence"],
  attempt: typeof SessionProviderAttemptTable.$inferSelect,
) {
  if (
    !evidence ||
    evidence.requestHash !== attempt.request_hash ||
    !Number.isSafeInteger(evidence.observedAt) ||
    evidence.observedAt < 0
  ) {
    return false
  }
  if (evidence.kind === "persisted_terminal_event") return Boolean(evidence.eventId.trim())
  return evidence.providerId === attempt.provider_id && Boolean(evidence.reference.trim())
}

function validIdempotencyProof(
  proof: ResolutionInput["idempotencyProof"],
  attempt: typeof SessionProviderAttemptTable.$inferSelect,
) {
  return Boolean(
    proof &&
      attempt.idempotency_key &&
      proof.providerId === attempt.provider_id &&
      proof.requestHash === attempt.request_hash &&
      proof.idempotencyKey === attempt.idempotency_key &&
      proof.contractVersion.trim(),
  )
}

function opaque(prefix: string) {
  return `${prefix}_${randomBytes(18).toString("base64url")}`
}

function preserveErrors<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Error, R> {
  return effect.pipe(Effect.catch((error) => (isError(error) ? Effect.fail(error) : Effect.die(error))))
}

function isError(value: unknown): value is Error {
  if (!value || typeof value !== "object" || !("_tag" in value)) return false
  return [
    "SessionProviderAttempt.NotFoundError",
    "SessionProviderAttempt.ConflictError",
    "SessionProviderAttempt.InvalidStateError",
    "SessionProviderAttempt.ValidationRequiredError",
    "SessionProviderAttempt.UnsafeRetryError",
    "SessionProviderAttempt.ResolutionDeniedError",
    "SessionProviderAttempt.ResolutionEvidenceError",
    "SessionProviderAttempt.ReplayRiskError",
  ].includes(String(value._tag))
}
