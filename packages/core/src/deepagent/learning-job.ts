export * as DeepAgentLearningJob from "./learning-job"

import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { LearningAdmissionOutboxTable } from "./learning-admission-outbox.sql"
import { LearningGovernancePlanTable } from "./learning-governance.sql"
import { LearningJobTable } from "./learning-job.sql"

type DatabaseClient = Database.Interface["db"]
type Transaction = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer T) => unknown ? T : never
const ActiveStates = ["running", "reviewing", "governance"] as const
const TerminalStates = ["completed", "failed", "cancelled", "recovery_required"] as const

export type Trigger = "idle" | "pause" | "project_switch" | "session_finalization"
export type Policy = "auto_merge_safe_project" | "manual_review"
export type State =
  | "queued"
  | "running"
  | "reviewing"
  | "governance"
  | "completed"
  | "failed"
  | "cancelled"
  | "recovery_required"
export type ActiveState = (typeof ActiveStates)[number]
export type TerminalState = (typeof TerminalStates)[number]
export type SideEffectState = "not_started" | "started" | "settled" | "unknown"
export type SideEffectKind = "extraction" | "reviewer" | "governance"

export type Record = {
  readonly jobId: string
  readonly projectId: string
  readonly sessionId: string | null
  readonly runId: string | null
  readonly trigger: Trigger
  readonly dedupeKey: string
  readonly candidateInputRef: string
  readonly policy: Policy
  readonly maxAttempts: number
  readonly admissionFingerprint: string
  readonly state: State
  readonly attempts: number
  readonly owner: string | null
  readonly leaseExpiresAt: number | null
  readonly version: number
  readonly sideEffectState: SideEffectState
  readonly sideEffectKind: SideEffectKind | null
  readonly expectedResultRef: string | null
  readonly reviewJobId: string | null
  readonly resultRef: string | null
  readonly errorCode: string | null
  readonly errorDetail: string | null
  readonly settlementFingerprint: string | null
  readonly nextAttemptAt: number
  readonly createdAt: number
  readonly startedAt: number | null
  readonly settledAt: number | null
  readonly updatedAt: number
}

export type EnqueueInput = {
  readonly projectId: string
  readonly sessionId?: string | null
  readonly runId?: string | null
  readonly trigger: Trigger
  readonly dedupeKey: string
  readonly candidateInputRef: string
  readonly policy: Policy
  readonly maxAttempts?: number
  readonly now?: number
}

export type ClaimInput = {
  readonly owner: string
  readonly leaseMs: number
  readonly now?: number
}

export type AdmittedEnqueueInput = EnqueueInput & {
  readonly intentId: string
  readonly payloadFingerprint: string
}

type Fence = {
  readonly jobId: string
  readonly owner: string
  readonly expectedVersion: number
  readonly now?: number
}

export type BeginSideEffectInput = Fence &
  (
    | {
        readonly state: "running"
        readonly kind: "extraction"
        readonly expectedResultRef: string
        readonly leaseMs?: number
        readonly reviewJobId?: never
      }
    | {
        readonly state: "reviewing"
        readonly kind: "reviewer"
        readonly expectedResultRef: string
        readonly leaseMs?: number
        readonly reviewJobId?: string
      }
    | {
        readonly state: "governance"
        readonly kind: "governance"
        readonly expectedResultRef?: never
        readonly leaseMs?: number
        readonly reviewJobId?: never
      }
  )

type SettleInput = Fence &
  (
    | {
        readonly state: "completed"
        readonly resultRef: string
        readonly errorCode?: never
        readonly errorDetail?: never
      }
    | {
        readonly state: "failed"
        readonly resultRef?: string
        readonly errorCode: string
        readonly errorDetail?: string
      }
    | {
        readonly state: "cancelled"
        readonly resultRef?: string
        readonly errorCode?: string
        readonly errorDetail?: string
      }
  )

export type RecoveryResult = {
  readonly requeued: readonly Record[]
  readonly completed: readonly Record[]
  readonly recoveryRequired: readonly Record[]
  readonly failed: readonly Record[]
}

export class InputError extends Schema.TaggedErrorClass<InputError>()("DeepAgentLearningJob.InputError", {
  field: Schema.String,
  reason: Schema.String,
}) {}

export class IdentityConflictError extends Schema.TaggedErrorClass<IdentityConflictError>()(
  "DeepAgentLearningJob.IdentityConflictError",
  { dedupeKey: Schema.String },
) {}

export class FenceError extends Schema.TaggedErrorClass<FenceError>()("DeepAgentLearningJob.FenceError", {
  jobId: Schema.String,
  reason: Schema.String,
}) {}

export const enqueue = Effect.fn("DeepAgentLearningJob.enqueue")(function* (db: DatabaseClient, input: EnqueueInput) {
  yield* validateEnqueue(input)
  const now = input.now ?? Date.now()
  const admissionFingerprint = Hash.sha256(CanonicalJson.stringify(admissionIdentity(input)))
  const jobId = stableJobId(input.dedupeKey)

  return yield* db.transaction((tx) => insertInTransaction(tx, input, now, admissionFingerprint, jobId), {
    behavior: "immediate",
  })
})

// Production jobs are distinguished by their outbox relationship: enqueueAdmitted creates
// that relationship atomically, while historical/direct enqueue callers remain claimable.
export const enqueueAdmitted = Effect.fn("DeepAgentLearningJob.enqueueAdmitted")(function* (
  db: DatabaseClient,
  input: AdmittedEnqueueInput,
) {
  yield* validateEnqueue(input)
  if (input.sessionId === undefined || input.sessionId === null) {
    return yield* new InputError({ field: "sessionId", reason: "is required for production admission" })
  }
  if (input.runId === undefined || input.runId === null) {
    return yield* new InputError({ field: "runId", reason: "is required for production admission" })
  }
  yield* requireText("intentId", input.intentId)
  yield* requireText("payloadFingerprint", input.payloadFingerprint)
  const now = input.now ?? Date.now()
  const admissionFingerprint = Hash.sha256(CanonicalJson.stringify(admissionIdentity(input)))
  const jobId = stableJobId(input.dedupeKey)

  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const receipt = yield* tx
          .select()
          .from(LearningAdmissionOutboxTable)
          .where(eq(LearningAdmissionOutboxTable.intent_id, input.intentId))
          .get()
        if (!receipt || receipt.payload_fingerprint !== input.payloadFingerprint) {
          return yield* new FenceError({ jobId, reason: "production admission has no exact durable outbox intent" })
        }
        if (
          receipt.session_id !== input.sessionId ||
          receipt.run_id !== input.runId ||
          receipt.trigger !== input.trigger ||
          receipt.dedupe_key !== `${input.trigger}:${input.sessionId}:${input.runId}`
        ) {
          return yield* new FenceError({ jobId, reason: "outbox intent identity does not match the learning job" })
        }
        if (receipt.state === "rejected") {
          return yield* new FenceError({ jobId, reason: "outbox intent is durably rejected" })
        }

        const current = yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, jobId)).get()
        if (receipt.state === "admitted") {
          if (
            !current ||
            current.dedupe_key !== input.dedupeKey ||
            current.admission_fingerprint !== admissionFingerprint ||
            current.candidate_input_ref !== input.candidateInputRef ||
            receipt.job_id !== current.job_id ||
            receipt.candidate_input_ref !== input.candidateInputRef
          ) {
            return yield* new FenceError({ jobId, reason: "admitted outbox receipt does not bind the exact job" })
          }
          return { created: false, job: decode(current) } as const
        }

        const result = yield* insertInTransaction(tx, input, now, admissionFingerprint, jobId)
        const settled = yield* tx
          .update(LearningAdmissionOutboxTable)
          .set({
            state: "admitted",
            job_id: result.job.jobId,
            candidate_input_ref: input.candidateInputRef,
            settled_at: now,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningAdmissionOutboxTable.intent_id, input.intentId),
              eq(LearningAdmissionOutboxTable.payload_fingerprint, input.payloadFingerprint),
              eq(LearningAdmissionOutboxTable.state, "pending"),
            ),
          )
          .returning()
          .get()
        if (!settled) {
          return yield* new FenceError({ jobId, reason: "outbox admission lost its pending fence" })
        }
        return result
      }),
    { behavior: "immediate" },
  )
})

export const get = Effect.fn("DeepAgentLearningJob.get")(function* (db: DatabaseClient, jobId: string) {
  const row = yield* db.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, jobId)).get()
  return row ? decode(row) : undefined
})

export const claim = Effect.fn("DeepAgentLearningJob.claim")(function* (db: DatabaseClient, input: ClaimInput) {
  yield* requireText("owner", input.owner)
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    return yield* new InputError({ field: "leaseMs", reason: "must be a positive safe integer" })
  }
  const now = input.now ?? Date.now()

  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const next = yield* tx
          .select()
          .from(LearningJobTable)
          .where(
            or(
              and(
                eq(LearningJobTable.state, "queued"),
                lte(LearningJobTable.next_attempt_at, now),
                lt(LearningJobTable.attempts, LearningJobTable.max_attempts),
              ),
              and(
                inArray(LearningJobTable.state, ["reviewing", "governance"]),
                isNull(LearningJobTable.owner),
                isNull(LearningJobTable.lease_expires_at),
                eq(LearningJobTable.side_effect_state, "not_started"),
                lte(LearningJobTable.next_attempt_at, now),
              ),
            ),
          )
          .orderBy(
            asc(LearningJobTable.next_attempt_at),
            asc(LearningJobTable.created_at),
            asc(LearningJobTable.job_id),
          )
          .get()
        if (!next) return undefined
        const admissions = yield* tx
          .select({
            state: LearningAdmissionOutboxTable.state,
            jobId: LearningAdmissionOutboxTable.job_id,
            candidateInputRef: LearningAdmissionOutboxTable.candidate_input_ref,
          })
          .from(LearningAdmissionOutboxTable)
          .where(
            next.session_id && next.run_id
              ? or(
                  eq(LearningAdmissionOutboxTable.job_id, next.job_id),
                  and(
                    eq(LearningAdmissionOutboxTable.session_id, next.session_id),
                    eq(LearningAdmissionOutboxTable.run_id, next.run_id),
                    eq(LearningAdmissionOutboxTable.trigger, next.trigger),
                  ),
                )
              : eq(LearningAdmissionOutboxTable.job_id, next.job_id),
          )
          .all()
        if (
          admissions.length > 0 &&
          (admissions.length !== 1 ||
            admissions[0]!.state !== "admitted" ||
            admissions[0]!.jobId !== next.job_id ||
            admissions[0]!.candidateInputRef !== next.candidate_input_ref)
        ) {
          return yield* new FenceError({
            jobId: next.job_id,
            reason: "outbox-backed learning job lacks its exact admitted receipt",
          })
        }
        const updated = yield* tx
          .update(LearningJobTable)
          .set({
            state: next.state === "queued" ? "running" : next.state,
            attempts: next.state === "queued" ? next.attempts + 1 : next.attempts,
            owner: input.owner,
            lease_expires_at: now + input.leaseMs,
            version: next.version + 1,
            started_at: next.started_at ?? now,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningJobTable.job_id, next.job_id),
              eq(LearningJobTable.state, next.state),
              eq(LearningJobTable.version, next.version),
              isNull(LearningJobTable.owner),
              isNull(LearningJobTable.lease_expires_at),
              eq(LearningJobTable.side_effect_state, "not_started"),
              lte(LearningJobTable.next_attempt_at, now),
              next.state === "queued" ? lt(LearningJobTable.attempts, LearningJobTable.max_attempts) : undefined,
            ),
          )
          .returning()
          .get()
        return updated ? decode(updated) : undefined
      }),
    { behavior: "immediate" },
  )
})

export const renew = Effect.fn("DeepAgentLearningJob.renew")(function* (
  db: DatabaseClient,
  input: Fence & { readonly leaseMs: number },
) {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    return yield* new InputError({ field: "leaseMs", reason: "must be a positive safe integer" })
  }
  const now = input.now ?? Date.now()
  const updated = yield* db
    .update(LearningJobTable)
    .set({
      lease_expires_at: now + input.leaseMs,
      version: input.expectedVersion + 1,
      updated_at: now,
    })
    .where(activeFence(input, now))
    .returning()
    .get()
  if (!updated) return yield* fenceError(input.jobId)
  return decode(updated)
})

export const beginSideEffect = Effect.fn("DeepAgentLearningJob.beginSideEffect")(function* (
  db: DatabaseClient,
  input: BeginSideEffectInput,
) {
  if (input.leaseMs !== undefined && (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0)) {
    return yield* new InputError({ field: "leaseMs", reason: "must be a positive safe integer" })
  }
  if (input.kind !== sideEffectKind(input.state)) {
    return yield* new InputError({ field: "kind", reason: `${input.state} requires ${sideEffectKind(input.state)}` })
  }
  if (input.state !== "reviewing" && input.reviewJobId !== undefined) {
    return yield* new InputError({ field: "reviewJobId", reason: "is only valid for the reviewing phase" })
  }
  if (input.kind === "governance" && input.expectedResultRef !== undefined) {
    return yield* new InputError({ field: "expectedResultRef", reason: "is not valid for governance" })
  }
  if (input.kind !== "governance") yield* requireText("expectedResultRef", input.expectedResultRef)
  if (input.reviewJobId !== undefined) yield* requireText("reviewJobId", input.reviewJobId)
  const now = input.now ?? Date.now()
  const updated = yield* db
    .update(LearningJobTable)
    .set({
      state: input.state,
      side_effect_state: "started",
      side_effect_kind: input.kind,
      expected_result_ref: input.expectedResultRef ?? null,
      ...(input.reviewJobId === undefined ? {} : { review_job_id: input.reviewJobId }),
      ...(input.leaseMs === undefined ? {} : { lease_expires_at: now + input.leaseMs }),
      version: input.expectedVersion + 1,
      updated_at: now,
    })
    .where(
      and(
        activeFence(input, now),
        eq(LearningJobTable.state, input.state),
        eq(LearningJobTable.side_effect_state, "not_started"),
      ),
    )
    .returning()
    .get()
  if (!updated) return yield* fenceError(input.jobId)
  return decode(updated)
})

export const advance = Effect.fn("DeepAgentLearningJob.advance")(function* (
  db: DatabaseClient,
  input: Fence & { readonly state: "reviewing" | "governance"; readonly leaseMs?: number },
) {
  if (input.leaseMs !== undefined && (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0)) {
    return yield* new InputError({ field: "leaseMs", reason: "must be a positive safe integer" })
  }
  const now = input.now ?? Date.now()
  const priorState = input.state === "reviewing" ? "running" : "reviewing"
  const priorKind = input.state === "reviewing" ? "extraction" : "reviewer"
  const updated = yield* db
    .update(LearningJobTable)
    .set({
      state: input.state,
      side_effect_state: "not_started",
      side_effect_kind: null,
      expected_result_ref: null,
      ...(input.leaseMs === undefined ? {} : { lease_expires_at: now + input.leaseMs }),
      version: input.expectedVersion + 1,
      updated_at: now,
    })
    .where(
      and(
        activeFence(input, now),
        eq(LearningJobTable.state, priorState),
        eq(LearningJobTable.side_effect_state, "settled"),
        eq(LearningJobTable.side_effect_kind, priorKind),
      ),
    )
    .returning()
    .get()
  if (!updated) return yield* fenceError(input.jobId, "advance requires a settled prior stage and a live fence")
  return decode(updated)
})

export const settleSideEffect = Effect.fn("DeepAgentLearningJob.settleSideEffect")(function* (
  db: DatabaseClient,
  input: Fence & { readonly resultRef: string },
) {
  yield* requireText("resultRef", input.resultRef)
  const now = input.now ?? Date.now()
  const updated = yield* db
    .update(LearningJobTable)
    .set({
      side_effect_state: "settled",
      result_ref: input.resultRef,
      version: input.expectedVersion + 1,
      updated_at: now,
    })
    .where(
      and(
        activeFence(input, now),
        eq(LearningJobTable.side_effect_state, "started"),
        eq(LearningJobTable.expected_result_ref, input.resultRef),
      ),
    )
    .returning()
    .get()
  if (!updated) return yield* fenceError(input.jobId)
  return decode(updated)
})

export const retry = Effect.fn("DeepAgentLearningJob.retry")(function* (
  db: DatabaseClient,
  input: Fence & { readonly delayMs: number; readonly errorCode: string; readonly errorDetail?: string },
) {
  if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) {
    return yield* new InputError({ field: "delayMs", reason: "must be a non-negative safe integer" })
  }
  yield* requireText("errorCode", input.errorCode)
  const now = input.now ?? Date.now()
  const updated = yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const current = yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, input.jobId)).get()
        if (!current || !ActiveStates.includes(current.state as ActiveState)) return undefined
        if (current.state === "running" && current.attempts >= current.max_attempts) return undefined
        return yield* tx
          .update(LearningJobTable)
          .set({
            state: current.state === "running" ? "queued" : current.state,
            owner: null,
            lease_expires_at: null,
            version: input.expectedVersion + 1,
            error_code: input.errorCode,
            error_detail: input.errorDetail ?? null,
            next_attempt_at: now + input.delayMs,
            updated_at: now,
          })
          .where(
            and(
              activeFence(input, now),
              eq(LearningJobTable.state, current.state),
              eq(LearningJobTable.side_effect_state, "not_started"),
              isNull(LearningJobTable.side_effect_kind),
            ),
          )
          .returning()
          .get()
      }),
    { behavior: "immediate" },
  )
  if (!updated) {
    return yield* fenceError(
      input.jobId,
      "retry requires a live fence before any side effect and remaining attempt budget",
    )
  }
  return decode(updated)
})

export const settle = Effect.fn("DeepAgentLearningJob.settle")(function* (db: DatabaseClient, input: SettleInput) {
  if (input.state === "completed") yield* requireText("resultRef", input.resultRef)
  if (input.state !== "completed" && input.resultRef !== undefined) yield* requireText("resultRef", input.resultRef)
  if (input.state === "failed") yield* requireText("errorCode", input.errorCode)
  if (input.state === "cancelled" && input.errorCode !== undefined) yield* requireText("errorCode", input.errorCode)
  const now = input.now ?? Date.now()
  const settlementFingerprint = Hash.sha256(
    CanonicalJson.stringify({
      jobId: input.jobId,
      owner: input.owner,
      expectedVersion: input.expectedVersion,
      state: input.state,
      resultRef: input.resultRef ?? null,
      errorCode: input.errorCode ?? null,
      errorDetail: input.errorDetail ?? null,
    }),
  )

  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, input.jobId)).get()
        if (existing && TerminalStates.includes(existing.state as TerminalState)) {
          if (existing.settlement_fingerprint === settlementFingerprint) return decode(existing)
          return yield* fenceError(input.jobId, "terminal settlement differs from the durable receipt")
        }
        const updated = yield* tx
          .update(LearningJobTable)
          .set({
            state: input.state,
            owner: null,
            lease_expires_at: null,
            version: input.expectedVersion + 1,
            ...(input.state === "completed" ? {} : { result_ref: input.resultRef ?? null }),
            error_code: input.errorCode ?? null,
            error_detail: input.errorDetail ?? null,
            settlement_fingerprint: settlementFingerprint,
            settled_at: now,
            updated_at: now,
          })
          .where(
            and(
              activeFence(input, now),
              input.state === "completed"
                ? and(
                    eq(LearningJobTable.state, "governance"),
                    eq(LearningJobTable.side_effect_state, "settled"),
                    eq(LearningJobTable.result_ref, input.resultRef),
                  )
                : inArray(LearningJobTable.side_effect_state, ["not_started", "settled"]),
            ),
          )
          .returning()
          .get()
        if (!updated) return yield* fenceError(input.jobId)
        return decode(updated)
      }),
    { behavior: "immediate" },
  )
})

export const recoverStale = Effect.fn("DeepAgentLearningJob.recoverStale")(function* (
  db: DatabaseClient,
  input?: { readonly now?: number },
) {
  const now = input?.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const stale = yield* tx
          .select()
          .from(LearningJobTable)
          .leftJoin(LearningGovernancePlanTable, eq(LearningGovernancePlanTable.job_id, LearningJobTable.job_id))
          .where(
            and(
              inArray(LearningJobTable.state, ActiveStates),
              lte(LearningJobTable.lease_expires_at, now),
              or(
                ne(LearningJobTable.state, "governance"),
                ne(LearningJobTable.side_effect_state, "started"),
                ne(LearningJobTable.side_effect_kind, "governance"),
                isNull(LearningGovernancePlanTable.plan_id),
              ),
            ),
          )
          .orderBy(asc(LearningJobTable.lease_expires_at), asc(LearningJobTable.job_id))
          .all()
        const recovered = yield* Effect.forEach(stale, ({ learning_job: row }) => {
          const notStarted = row.side_effect_state === "not_started"
          const initialRetry = notStarted && row.state === "running" && row.attempts < row.max_attempts
          const initialFailed = notStarted && row.state === "running" && !initialRetry
          const phaseRetry = notStarted && row.state !== "running"
          const settled = row.side_effect_state === "settled"
          const completed = settled && row.state === "governance"
          const advancedState =
            settled && row.state === "running"
              ? ("reviewing" as const)
              : settled && row.state === "reviewing"
                ? ("governance" as const)
                : row.state
          const requeue = initialRetry || phaseRetry || (settled && !completed)
          const state = completed
            ? ("completed" as const)
            : initialRetry
              ? ("queued" as const)
              : initialFailed
                ? ("failed" as const)
                : requeue
                  ? advancedState
                  : ("recovery_required" as const)
          const settlementFingerprint = completed
            ? Hash.sha256(
                CanonicalJson.stringify({
                  jobId: row.job_id,
                  recoveryVersion: row.version,
                  state,
                  resultRef: row.result_ref,
                }),
              )
            : null
          return tx
            .update(LearningJobTable)
            .set({
              state,
              owner: null,
              lease_expires_at: null,
              version: row.version + 1,
              side_effect_state: settled && !completed ? "not_started" : row.side_effect_state,
              side_effect_kind: settled && !completed ? null : row.side_effect_kind,
              expected_result_ref: settled && !completed ? null : row.expected_result_ref,
              error_code: completed
                ? null
                : initialRetry
                  ? "lease_expired_before_side_effect"
                  : initialFailed
                    ? "attempt_limit_exhausted_after_lease_expiry"
                    : phaseRetry
                      ? "lease_expired_before_next_phase_side_effect"
                      : settled
                        ? "resumed_from_settled_side_effect_receipt"
                        : "ambiguous_side_effect_after_lease_expiry",
              error_detail: completed
                ? null
                : initialRetry
                  ? "The expired owner had no durable side-effect start receipt; the job may be claimed again."
                  : initialFailed
                    ? "The expired owner had no side-effect receipt, but the admitted attempt budget is exhausted."
                    : phaseRetry
                      ? `The expired owner had not started ${row.state}; another worker may claim the same phase.`
                      : settled
                        ? `The durable ${row.side_effect_kind} result ${row.result_ref} advances the job without replay.`
                        : `The expired owner recorded ${row.side_effect_kind ?? "unknown"}:${row.side_effect_state}; automatic replay is forbidden.`,
              next_attempt_at: requeue ? now : row.next_attempt_at,
              settlement_fingerprint: settlementFingerprint,
              settled_at: requeue ? null : now,
              updated_at: now,
            })
            .where(
              and(
                eq(LearningJobTable.job_id, row.job_id),
                eq(LearningJobTable.version, row.version),
                eq(LearningJobTable.state, row.state),
                lte(LearningJobTable.lease_expires_at, now),
              ),
            )
            .returning()
            .get()
        })
        const rows = recovered.filter((row): row is NonNullable<typeof row> => row !== undefined).map(decode)
        return {
          requeued: rows.filter(
            (row) => row.state === "queued" || (ActiveStates.includes(row.state as ActiveState) && row.owner === null),
          ),
          completed: rows.filter((row) => row.state === "completed"),
          recoveryRequired: rows.filter((row) => row.state === "recovery_required"),
          failed: rows.filter((row) => row.state === "failed"),
        } satisfies RecoveryResult
      }),
    { behavior: "immediate" },
  )
})

export const staleArtifactSideEffects = Effect.fn("DeepAgentLearningJob.staleArtifactSideEffects")(function* (
  db: DatabaseClient,
  input?: { readonly now?: number },
) {
  const now = input?.now ?? Date.now()
  return (
    yield* db
      .select()
      .from(LearningJobTable)
      .where(
        and(
          inArray(LearningJobTable.state, ["running", "reviewing"]),
          eq(LearningJobTable.side_effect_state, "started"),
          inArray(LearningJobTable.side_effect_kind, ["extraction", "reviewer"]),
          lte(LearningJobTable.lease_expires_at, now),
        ),
      )
      .orderBy(asc(LearningJobTable.lease_expires_at), asc(LearningJobTable.job_id))
      .all()
  ).map(decode)
})

export const reconcileArtifactSideEffect = Effect.fn("DeepAgentLearningJob.reconcileArtifactSideEffect")(function* (
  db: DatabaseClient,
  input: {
    readonly jobId: string
    readonly expectedVersion: number
    readonly state: "running" | "reviewing"
    readonly kind: "extraction" | "reviewer"
    readonly expectedResultRef: string
    readonly now?: number
  },
) {
  yield* requireText("expectedResultRef", input.expectedResultRef)
  if (input.kind !== sideEffectKind(input.state)) {
    return yield* new InputError({ field: "kind", reason: `${input.state} requires ${sideEffectKind(input.state)}` })
  }
  const now = input.now ?? Date.now()
  const nextState = input.state === "running" ? ("reviewing" as const) : ("governance" as const)
  const updated = yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const settled = yield* tx
          .update(LearningJobTable)
          .set({
            side_effect_state: "settled",
            result_ref: input.expectedResultRef,
            version: input.expectedVersion + 1,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningJobTable.job_id, input.jobId),
              eq(LearningJobTable.version, input.expectedVersion),
              eq(LearningJobTable.state, input.state),
              eq(LearningJobTable.side_effect_state, "started"),
              eq(LearningJobTable.side_effect_kind, input.kind),
              eq(LearningJobTable.expected_result_ref, input.expectedResultRef),
              lte(LearningJobTable.lease_expires_at, now),
            ),
          )
          .returning()
          .get()
        if (!settled) return undefined
        return yield* tx
          .update(LearningJobTable)
          .set({
            state: nextState,
            owner: null,
            lease_expires_at: null,
            version: input.expectedVersion + 2,
            side_effect_state: "not_started",
            side_effect_kind: null,
            expected_result_ref: null,
            error_code: "reconciled_exact_artifact_after_lease_expiry",
            error_detail: `The exact durable ${input.kind} artifact was verified and advanced without replaying provider work.`,
            next_attempt_at: now,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningJobTable.job_id, input.jobId),
              eq(LearningJobTable.version, input.expectedVersion + 1),
              eq(LearningJobTable.state, input.state),
              eq(LearningJobTable.side_effect_state, "settled"),
              eq(LearningJobTable.side_effect_kind, input.kind),
              eq(LearningJobTable.expected_result_ref, input.expectedResultRef),
              eq(LearningJobTable.result_ref, input.expectedResultRef),
            ),
          )
          .returning()
          .get()
      }),
    { behavior: "immediate" },
  )
  if (!updated) return yield* fenceError(input.jobId, "stale phase no longer matches its exact artifact plan")
  return decode(updated)
})

export const quarantineArtifactSideEffect = Effect.fn("DeepAgentLearningJob.quarantineArtifactSideEffect")(function* (
  db: DatabaseClient,
  input: {
    readonly jobId: string
    readonly expectedVersion: number
    readonly code: string
    readonly detail: string
    readonly now?: number
  },
) {
  yield* requireText("code", input.code)
  yield* requireText("detail", input.detail)
  const now = input.now ?? Date.now()
  const updated = yield* db
    .update(LearningJobTable)
    .set({
      state: "recovery_required",
      owner: null,
      lease_expires_at: null,
      version: input.expectedVersion + 1,
      error_code: input.code,
      error_detail: input.detail,
      settled_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(LearningJobTable.job_id, input.jobId),
        eq(LearningJobTable.version, input.expectedVersion),
        inArray(LearningJobTable.state, ["running", "reviewing"]),
        eq(LearningJobTable.side_effect_state, "started"),
        inArray(LearningJobTable.side_effect_kind, ["extraction", "reviewer"]),
        lte(LearningJobTable.lease_expires_at, now),
      ),
    )
    .returning()
    .get()
  if (!updated) return yield* fenceError(input.jobId, "stale artifact phase changed before quarantine")
  return decode(updated)
})

function stableJobId(dedupeKey: string) {
  return `learning_job:${Hash.sha256(dedupeKey)}`
}

function insertInTransaction(
  tx: Transaction,
  input: EnqueueInput,
  now: number,
  admissionFingerprint: string,
  jobId: string,
) {
  return Effect.gen(function* () {
    const existing = yield* tx
      .select()
      .from(LearningJobTable)
      .where(or(eq(LearningJobTable.job_id, jobId), eq(LearningJobTable.dedupe_key, input.dedupeKey)))
      .get()
    if (existing) {
      if (existing.dedupe_key !== input.dedupeKey || existing.admission_fingerprint !== admissionFingerprint) {
        return yield* new IdentityConflictError({ dedupeKey: input.dedupeKey })
      }
      return { created: false, job: decode(existing) } as const
    }

    const inserted = yield* tx
      .insert(LearningJobTable)
      .values({
        job_id: jobId,
        project_id: input.projectId,
        session_id: input.sessionId ?? null,
        run_id: input.runId ?? null,
        trigger: input.trigger,
        dedupe_key: input.dedupeKey,
        candidate_input_ref: input.candidateInputRef,
        policy: input.policy,
        max_attempts: input.maxAttempts ?? 3,
        admission_fingerprint: admissionFingerprint,
        state: "queued",
        attempts: 0,
        owner: null,
        lease_expires_at: null,
        version: 0,
        side_effect_state: "not_started",
        side_effect_kind: null,
        expected_result_ref: null,
        review_job_id: null,
        result_ref: null,
        error_code: null,
        error_detail: null,
        settlement_fingerprint: null,
        next_attempt_at: now,
        created_at: now,
        started_at: null,
        settled_at: null,
        updated_at: now,
      })
      .returning()
      .get()
    return { created: true, job: decode(inserted) } as const
  })
}

function admissionIdentity(input: EnqueueInput) {
  return {
    projectId: input.projectId,
    sessionId: input.sessionId ?? null,
    runId: input.runId ?? null,
    trigger: input.trigger,
    dedupeKey: input.dedupeKey,
    candidateInputRef: input.candidateInputRef,
    policy: input.policy,
    maxAttempts: input.maxAttempts ?? 3,
  }
}

function validateEnqueue(input: EnqueueInput) {
  return Effect.gen(function* () {
    yield* requireText("projectId", input.projectId)
    yield* requireText("dedupeKey", input.dedupeKey)
    yield* requireText("candidateInputRef", input.candidateInputRef)
    if (input.sessionId !== undefined && input.sessionId !== null) yield* requireText("sessionId", input.sessionId)
    if (input.runId !== undefined && input.runId !== null) yield* requireText("runId", input.runId)
    if (input.maxAttempts !== undefined && (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0)) {
      return yield* new InputError({ field: "maxAttempts", reason: "must be a positive safe integer" })
    }
  })
}

function requireText(field: string, value: string) {
  if (value.trim().length > 0) return Effect.void
  return new InputError({ field, reason: "must be non-empty" })
}

function activeFence(input: Fence, now: number) {
  return and(
    eq(LearningJobTable.job_id, input.jobId),
    inArray(LearningJobTable.state, ActiveStates),
    eq(LearningJobTable.owner, input.owner),
    eq(LearningJobTable.version, input.expectedVersion),
    gt(LearningJobTable.lease_expires_at, now),
  )
}

function sideEffectKind(state: ActiveState): SideEffectKind {
  if (state === "running") return "extraction"
  if (state === "reviewing") return "reviewer"
  return "governance"
}

function fenceError(jobId: string, reason = "owner, lease, state, or version fence was lost") {
  return new FenceError({ jobId, reason })
}

function decode(row: typeof LearningJobTable.$inferSelect): Record {
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    runId: row.run_id,
    trigger: row.trigger,
    dedupeKey: row.dedupe_key,
    candidateInputRef: row.candidate_input_ref,
    policy: row.policy,
    maxAttempts: row.max_attempts,
    admissionFingerprint: row.admission_fingerprint,
    state: row.state,
    attempts: row.attempts,
    owner: row.owner,
    leaseExpiresAt: row.lease_expires_at,
    version: row.version,
    sideEffectState: row.side_effect_state,
    sideEffectKind: row.side_effect_kind,
    expectedResultRef: row.expected_result_ref,
    reviewJobId: row.review_job_id,
    resultRef: row.result_ref,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    settlementFingerprint: row.settlement_fingerprint,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  }
}
