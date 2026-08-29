export * as SessionProviderAttempt from "./provider-attempt"

import { randomBytes } from "node:crypto"
import { and, desc, eq, exists, gt, inArray, isNull, max, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { SessionSchema } from "../session/schema"
import {
  SessionContextSelectionTable,
  SessionContextValidationTable,
  SessionActivityTable,
  SessionProviderAttemptResolutionTable,
  SessionProviderAttemptTable,
  SessionProviderOwnerLeaseTable,
} from "./session-sql"
import { V2ProviderRecoveryBridgeTable, V2ProviderTurnReceiptTable } from "../session/runner/v2-provider-turn.sql"

export type State = typeof SessionProviderAttemptTable.$inferSelect.state
export type Attempt = {
  readonly attemptId: string
  readonly sessionId: SessionSchema.ID
  readonly activityId: string
  readonly providerTurnSeq: number
  readonly selectionId: string
  readonly projectionHash: string
  readonly requestHash: string
  readonly preparedTurnHash?: string
  readonly wireRequestHash?: string
  readonly providerId: string
  readonly ownerToken?: string
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
export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionProviderAttempt.ConflictError", {
  reason: Schema.String.pipe(Schema.optional),
}) {}
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
  readonly ownerToken: string
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
  readonly recoveryOwnerToken: string
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
    "activityId" | "selectionId" | "projectionHash" | "requestHash" | "providerId" | "ownerToken" | "parentAttemptId"
  >
  readonly now?: number
}

export type ExactRecoveryInput = {
  readonly sessionId: SessionSchema.ID
  readonly staleOwnerToken: string | null
  readonly recoveryOwnerToken: string
  readonly undispatchedAttemptIds: readonly string[]
  readonly startedAttemptIds: readonly string[]
  readonly now?: number
}

export interface Interface {
  readonly prepare: (input: PrepareInput) => Effect.Effect<Attempt, Error>
  readonly sealPrepared: (input: {
    readonly attemptId: string
    readonly expectedOwnerToken: string
    readonly preparedTurnHash: string
    readonly wireRequestHash: string
    readonly now?: number
  }) => Effect.Effect<Attempt, Error>
  readonly abandonPrepared: (input: {
    readonly attemptId: string
    readonly expectedOwnerToken: string
    readonly errorCode: string
    readonly now?: number
  }) => Effect.Effect<Attempt, Error>
  readonly markDispatching: (input: {
    readonly attemptId: string
    readonly expectedOwnerToken: string
    readonly now?: number
  }) => Effect.Effect<Attempt, Error>
  readonly markStreaming: (input: {
    readonly attemptId: string
    readonly expectedOwnerToken: string
    readonly now?: number
  }) => Effect.Effect<Attempt, Error>
  readonly settle: (input: {
    readonly attemptId: string
    readonly expectedOwnerToken: string
    readonly outcome: "settled" | "failed"
    readonly errorCode?: string
    readonly now?: number
  }) => Effect.Effect<Attempt, Error>
  readonly recoverIndeterminate: (input: {
    readonly sessionId: SessionSchema.ID
    readonly staleOwnerToken: string | null
    readonly recoveryOwnerToken: string
    readonly now?: number
  }) => Effect.Effect<number, Error>
  readonly resolve: (
    input: ResolutionInput,
  ) => Effect.Effect<
    { readonly resolutionId: string; readonly attempt: Attempt; readonly replay?: Attempt },
    Error
  >
  readonly bridgeResolution: (input: {
    readonly resolutionId: string
    readonly receiptId: string
    readonly commandId: string
    readonly now?: number
  }) => Effect.Effect<void, Error>
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
      return yield* db
        .transaction((tx) => prepareInTransaction(tx, input), { behavior: "immediate" })
        .pipe(preserveErrors)
    })

    const transition = Effect.fn("SessionProviderAttempt.transition")(function* (input: TransitionInput) {
      return yield* db
        .transaction((tx) => transitionInTransaction(tx, input), { behavior: "immediate" })
        .pipe(preserveErrors)
    })

    const sealPrepared = (input: {
      readonly attemptId: string
      readonly expectedOwnerToken: string
      readonly preparedTurnHash: string
      readonly wireRequestHash: string
      readonly now?: number
    }) =>
      transition({
        ...input,
        from: ["prepared"],
        to: "prepared",
        now: input.now ?? Date.now(),
      })

    const markDispatching = (input: {
      readonly attemptId: string
      readonly expectedOwnerToken: string
      readonly now?: number
    }) => transition({ ...input, from: ["prepared"], to: "dispatching", now: input.now ?? Date.now() })
    const abandonPrepared = (input: {
      readonly attemptId: string
      readonly expectedOwnerToken: string
      readonly errorCode: string
      readonly now?: number
    }) => {
      if (!input.errorCode.trim()) return Effect.fail(new ConflictError({ reason: "error_code_required" }))
      return transition({
        attemptId: input.attemptId,
        expectedOwnerToken: input.expectedOwnerToken,
        from: ["prepared"],
        to: "failed",
        now: input.now ?? Date.now(),
        errorCode: input.errorCode,
      })
    }
    const markStreaming = (input: {
      readonly attemptId: string
      readonly expectedOwnerToken: string
      readonly now?: number
    }) =>
      transition({
        ...input,
        from: ["dispatching"],
        to: "streaming",
        now: input.now ?? Date.now(),
        firstEvent: true,
      })
    const settle = (input: {
      readonly attemptId: string
      readonly expectedOwnerToken: string
      readonly outcome: "settled" | "failed"
      readonly errorCode?: string
      readonly now?: number
    }) => {
      if (input.outcome === "settled" && input.errorCode) return Effect.fail(new ConflictError())
      return transition({
        attemptId: input.attemptId,
        expectedOwnerToken: input.expectedOwnerToken,
        from: ["dispatching", "streaming"],
        to: input.outcome,
        now: input.now ?? Date.now(),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      })
    }

    const recoverIndeterminate = Effect.fn("SessionProviderAttempt.recoverIndeterminate")(function* (input: {
      readonly sessionId: SessionSchema.ID
      readonly staleOwnerToken: string | null
      readonly recoveryOwnerToken: string
      readonly now?: number
    }) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* requireLiveOwner(tx, input.recoveryOwnerToken)
            yield* requireStaleOwner(tx, input.staleOwnerToken)
            const prepared = yield* tx
              .update(SessionProviderAttemptTable)
              .set({
                state: "failed",
                settled_at: input.now ?? Date.now(),
                error_code: "owner_lease_lost_before_dispatch",
              })
              .where(
                and(
                  eq(SessionProviderAttemptTable.session_id, input.sessionId),
                  input.staleOwnerToken === null
                    ? isNull(SessionProviderAttemptTable.owner_token)
                    : eq(SessionProviderAttemptTable.owner_token, input.staleOwnerToken),
                  eq(SessionProviderAttemptTable.state, "prepared"),
                  liveOwnerExists(tx, input.recoveryOwnerToken),
                ),
              )
              .returning({ attempt_id: SessionProviderAttemptTable.attempt_id })
              .all()
            const started = yield* tx
              .update(SessionProviderAttemptTable)
              .set({ state: "indeterminate_after_crash", error_code: "process_recovery" })
              .where(
                and(
                  eq(SessionProviderAttemptTable.session_id, input.sessionId),
                  input.staleOwnerToken === null
                    ? isNull(SessionProviderAttemptTable.owner_token)
                    : eq(SessionProviderAttemptTable.owner_token, input.staleOwnerToken),
                  inArray(SessionProviderAttemptTable.state, ["dispatching", "streaming"]),
                  liveOwnerExists(tx, input.recoveryOwnerToken),
                ),
              )
              .returning({ attempt_id: SessionProviderAttemptTable.attempt_id })
              .all()
            return prepared.length + started.length
          }),
        )
        .pipe(preserveErrors)
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
            yield* requireLiveOwner(tx, input.recoveryOwnerToken)
            yield* requireStaleOwner(tx, row.owner_token)
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
            const resolved = yield* tx
              .update(SessionProviderAttemptTable)
              .set({ state: nextState, settled_at: settledAt })
              .where(
                and(
                  eq(SessionProviderAttemptTable.attempt_id, row.attempt_id),
                  eq(SessionProviderAttemptTable.state, "indeterminate_after_crash"),
                  liveOwnerExists(tx, input.recoveryOwnerToken),
                ),
              )
              .returning({ attemptId: SessionProviderAttemptTable.attempt_id })
              .get()
            if (!resolved) return yield* new ConflictError({ reason: "provider_resolution_fence_lost" })
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
                  ownerToken: input.recoveryOwnerToken,
                  parentAttemptId: row.attempt_id,
                  idempotencyKey: row.idempotency_key ?? undefined,
                  now: input.now,
                })
              : undefined
            return {
              resolutionId,
              attempt: attempt({ ...row, state: nextState, settled_at: settledAt }),
              ...(replay ? { replay } : {}),
            }
          }),
        )
        .pipe(preserveErrors)
    })

    const bridgeResolution = Effect.fn("SessionProviderAttempt.bridgeResolution")(function* (input: {
      readonly resolutionId: string
      readonly receiptId: string
      readonly commandId: string
      readonly now?: number
    }) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const resolution = yield* tx
                .select()
                .from(SessionProviderAttemptResolutionTable)
                .where(eq(SessionProviderAttemptResolutionTable.resolution_id, input.resolutionId))
                .get()
              if (!resolution) return yield* new NotFoundError()
              const attempt = yield* tx
                .select()
                .from(SessionProviderAttemptTable)
                .where(eq(SessionProviderAttemptTable.attempt_id, resolution.attempt_id))
                .get()
              // The bridge is created after resolve() records the decision: the attempt state
              // must already record that exact decision, otherwise the resolution never happened.
              if (!attempt || attempt.state !== `resolved_${resolution.decision}`)
                return yield* new ConflictError({ reason: "provider_resolution_state_mismatch" })
              const receipt = yield* tx
                .select()
                .from(V2ProviderTurnReceiptTable)
                .where(eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptId))
                .get()
              if (
                !receipt ||
                receipt.session_id !== attempt.session_id ||
                receipt.provider_attempt_id !== attempt.attempt_id ||
                receipt.state !== "indeterminate_after_crash"
              )
                return yield* new ConflictError({ reason: "provider_resolution_receipt_mismatch" })
              yield* tx
                .insert(V2ProviderRecoveryBridgeTable)
                .values({
                  resolution_id: input.resolutionId,
                  attempt_id: attempt.attempt_id,
                  receipt_id: input.receiptId,
                  command_id: input.commandId,
                  created_at: input.now ?? Date.now(),
                })
                .onConflictDoNothing()
                .run()
              const existing = yield* tx
                .select()
                .from(V2ProviderRecoveryBridgeTable)
                .where(eq(V2ProviderRecoveryBridgeTable.resolution_id, input.resolutionId))
                .get()
              if (
                !existing ||
                existing.attempt_id !== attempt.attempt_id ||
                existing.receipt_id !== input.receiptId ||
                existing.command_id !== input.commandId
              )
                return yield* new ConflictError({ reason: "provider_resolution_bridge_conflict" })
            }),
          { behavior: "immediate" },
        )
        .pipe(preserveErrors)
    })

    return Service.of({
      prepare,
      sealPrepared,
      abandonPrepared,
      markDispatching,
      markStreaming,
      settle,
      recoverIndeterminate,
      resolve,
      bridgeResolution,
      get,
    })
  }),
)

export function prepareInTransaction(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  input: PrepareInput,
): Effect.Effect<Attempt, Error> {
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
    yield* requireLiveOwner(tx, input.ownerToken)
    if (
      !validation ||
      validation.outcome !== "valid" ||
      validation.authorization_epoch !== input.authorizationEpoch ||
      validation.egress_epoch !== input.egressEpoch ||
      validation.observed_location_mutation_epoch !== input.observedLocationMutationEpoch ||
      validation.selected_source_fingerprint !== input.selectedSourceFingerprint ||
      validation.valid_until <= (input.now ?? Date.now())
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
        existing.owner_token !== input.ownerToken ||
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
      owner_token: input.ownerToken,
      parent_attempt_id: input.parentAttemptId,
      idempotency_key: input.idempotencyKey,
      state: "prepared",
      created_at: input.now ?? Date.now(),
    }
    yield* tx.insert(SessionProviderAttemptTable).values(row).run()
    return attempt({
      ...row,
      parent_attempt_id: row.parent_attempt_id ?? null,
      idempotency_key: row.idempotency_key ?? null,
      owner_token: row.owner_token ?? null,
      prepared_turn_hash: null,
      wire_request_hash: null,
      first_event_at: null,
      settled_at: null,
      error_code: null,
    })
  }).pipe(preserveErrors)
}

export type TransitionInput = {
  readonly attemptId: string
  readonly expectedOwnerToken: string
  readonly from: readonly State[]
  readonly to: State
  readonly now: number
  readonly firstEvent?: boolean
  readonly errorCode?: string
  readonly preparedTurnHash?: string
  readonly wireRequestHash?: string
}

export function transitionInTransaction(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  input: TransitionInput,
): Effect.Effect<Attempt, Error> {
  return Effect.gen(function* () {
    const row = yield* tx
      .select()
      .from(SessionProviderAttemptTable)
      .where(eq(SessionProviderAttemptTable.attempt_id, input.attemptId))
      .get()
    if (!row) return yield* new NotFoundError()
    if (row.owner_token !== input.expectedOwnerToken)
      return yield* new ConflictError({ reason: "provider_attempt_owner_mismatch" })
    yield* requireLiveOwner(tx, input.expectedOwnerToken)
    if (!input.from.includes(row.state)) return yield* new InvalidStateError({ state: row.state })
    if (input.to === "dispatching" && (!row.prepared_turn_hash || !row.wire_request_hash))
      return yield* new ConflictError({ reason: "provider_attempt_wire_identity_not_sealed" })
    const terminal = isTerminal(input.to)
    if ((input.preparedTurnHash === undefined) !== (input.wireRequestHash === undefined))
      return yield* new ConflictError({ reason: "provider_attempt_wire_identity_incomplete" })
    if (
      input.preparedTurnHash !== undefined &&
      (!HashPattern.test(input.preparedTurnHash) || !HashPattern.test(input.wireRequestHash!))
    )
      return yield* new ConflictError({ reason: "provider_attempt_wire_identity_invalid" })
    if (
      input.preparedTurnHash !== undefined &&
      ((row.prepared_turn_hash !== null && row.prepared_turn_hash !== input.preparedTurnHash) ||
        (row.wire_request_hash !== null && row.wire_request_hash !== input.wireRequestHash))
    )
      return yield* new ConflictError({ reason: "provider_attempt_wire_identity_mismatch" })
    const updated = yield* tx
      .update(SessionProviderAttemptTable)
      .set({
        state: input.to,
        ...(input.firstEvent && row.first_event_at === null ? { first_event_at: input.now } : {}),
        ...(terminal ? { settled_at: input.now } : {}),
        ...(input.errorCode ? { error_code: input.errorCode } : {}),
        ...(input.preparedTurnHash !== undefined
          ? { prepared_turn_hash: input.preparedTurnHash, wire_request_hash: input.wireRequestHash }
          : {}),
      })
      .where(
        and(
          eq(SessionProviderAttemptTable.attempt_id, input.attemptId),
          eq(SessionProviderAttemptTable.owner_token, input.expectedOwnerToken),
          eq(SessionProviderAttemptTable.state, row.state),
          liveOwnerExists(tx, input.expectedOwnerToken),
        ),
      )
      .returning({ attemptId: SessionProviderAttemptTable.attempt_id })
      .get()
    if (!updated) return yield* new ConflictError({ reason: "attempt_transition_cas_lost" })
    return attempt({
      ...row,
      state: input.to,
      ...(input.firstEvent && row.first_event_at === null ? { first_event_at: input.now } : {}),
      ...(terminal ? { settled_at: input.now } : {}),
      ...(input.errorCode ? { error_code: input.errorCode } : {}),
      ...(input.preparedTurnHash !== undefined
        ? { prepared_turn_hash: input.preparedTurnHash, wire_request_hash: input.wireRequestHash }
        : {}),
    })
  }).pipe(preserveErrors)
}

export function recoverExactInTransaction(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  input: ExactRecoveryInput,
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const attemptIds = [...input.undispatchedAttemptIds, ...input.startedAttemptIds]
    if (new Set(attemptIds).size !== attemptIds.length || attemptIds.some((attemptId) => !attemptId.trim())) {
      return yield* new ConflictError({ reason: "provider_recovery_attempt_ids_invalid" })
    }
    yield* requireLiveOwner(tx, input.recoveryOwnerToken)
    yield* requireStaleOwner(tx, input.staleOwnerToken)
    const owner = input.staleOwnerToken === null
      ? isNull(SessionProviderAttemptTable.owner_token)
      : eq(SessionProviderAttemptTable.owner_token, input.staleOwnerToken)
    const undispatched = input.undispatchedAttemptIds.length
      ? yield* tx
          .update(SessionProviderAttemptTable)
          .set({
            state: "failed",
            settled_at: input.now ?? Date.now(),
            error_code: "owner_lease_lost_before_dispatch",
          })
          .where(
            and(
              eq(SessionProviderAttemptTable.session_id, input.sessionId),
              owner,
              eq(SessionProviderAttemptTable.state, "prepared"),
              inArray(SessionProviderAttemptTable.attempt_id, input.undispatchedAttemptIds),
              liveOwnerExists(tx, input.recoveryOwnerToken),
            ),
          )
          .returning({ attemptId: SessionProviderAttemptTable.attempt_id })
          .all()
      : []
    const started = input.startedAttemptIds.length
      ? yield* tx
          .update(SessionProviderAttemptTable)
          .set({ state: "indeterminate_after_crash", error_code: "process_recovery" })
          .where(
            and(
              eq(SessionProviderAttemptTable.session_id, input.sessionId),
              owner,
              inArray(SessionProviderAttemptTable.state, ["prepared", "dispatching", "streaming"]),
              inArray(SessionProviderAttemptTable.attempt_id, input.startedAttemptIds),
              liveOwnerExists(tx, input.recoveryOwnerToken),
            ),
          )
          .returning({ attemptId: SessionProviderAttemptTable.attempt_id })
          .all()
      : []
    if (undispatched.length + started.length !== attemptIds.length) {
      return yield* new ConflictError({ reason: "provider_recovery_exact_attempt_mismatch" })
    }
    return attemptIds.length
  }).pipe(preserveErrors)
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
    ...(row.prepared_turn_hash ? { preparedTurnHash: row.prepared_turn_hash } : {}),
    ...(row.wire_request_hash ? { wireRequestHash: row.wire_request_hash } : {}),
    providerId: row.provider_id,
    ...(row.owner_token ? { ownerToken: row.owner_token } : {}),
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

const HashPattern = /^[0-9a-f]{64}$/

function validProviderEvidence(
  evidence: ResolutionInput["providerEvidence"],
  attempt: typeof SessionProviderAttemptTable.$inferSelect,
) {
  if (
    !evidence ||
    evidence.requestHash !== (attempt.wire_request_hash ?? attempt.request_hash) ||
    !Number.isSafeInteger(evidence.observedAt) ||
    evidence.observedAt < 0
  ) {
    return false
  }
  if (evidence.kind === "persisted_terminal_event") return Boolean(evidence.eventId.trim())
  return evidence.providerId === attempt.provider_id && Boolean(evidence.reference.trim())
}

function liveOwnerExists(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  ownerToken: string,
) {
  return exists(
    tx
      .select({ ownerToken: SessionProviderOwnerLeaseTable.owner_token })
      .from(SessionProviderOwnerLeaseTable)
      .where(
        and(
          eq(SessionProviderOwnerLeaseTable.owner_token, ownerToken),
          isNull(SessionProviderOwnerLeaseTable.released_at),
          gt(SessionProviderOwnerLeaseTable.lease_expires_at, databaseNow),
        ),
      ),
  )
}

function requireLiveOwner(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  ownerToken: string,
) {
  return Effect.gen(function* () {
    if (!ownerToken.trim()) return yield* new ConflictError({ reason: "owner_token_required" })
    const owner = yield* tx
      .select({ ownerToken: SessionProviderOwnerLeaseTable.owner_token })
      .from(SessionProviderOwnerLeaseTable)
      .where(
        and(
          eq(SessionProviderOwnerLeaseTable.owner_token, ownerToken),
          isNull(SessionProviderOwnerLeaseTable.released_at),
          gt(SessionProviderOwnerLeaseTable.lease_expires_at, databaseNow),
        ),
      )
      .get()
    if (!owner) return yield* new ConflictError({ reason: "provider_owner_lease_not_live" })
  })
}

function requireStaleOwner(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  ownerToken: string | null,
) {
  if (ownerToken === null) return Effect.void
  return Effect.gen(function* () {
    const live = yield* tx
      .select({ ownerToken: SessionProviderOwnerLeaseTable.owner_token })
      .from(SessionProviderOwnerLeaseTable)
      .where(
        and(
          eq(SessionProviderOwnerLeaseTable.owner_token, ownerToken),
          isNull(SessionProviderOwnerLeaseTable.released_at),
          gt(SessionProviderOwnerLeaseTable.lease_expires_at, databaseNow),
        ),
      )
      .get()
    if (!live) return
    return yield* new ConflictError({ reason: "provider_attempt_owner_still_live" })
  })
}

const databaseNow = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`

function validIdempotencyProof(
  proof: ResolutionInput["idempotencyProof"],
  attempt: typeof SessionProviderAttemptTable.$inferSelect,
) {
  return Boolean(
    proof &&
      attempt.idempotency_key &&
      proof.providerId === attempt.provider_id &&
      proof.requestHash === (attempt.wire_request_hash ?? attempt.request_hash) &&
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
