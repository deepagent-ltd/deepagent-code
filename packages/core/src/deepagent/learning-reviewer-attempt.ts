export * as DeepAgentLearningReviewerAttempt from "./learning-reviewer-attempt"

import { and, eq, gt, lte } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { LearningJobTable } from "./learning-job.sql"
import { LearningReviewerAttemptTable } from "./learning-reviewer-attempt.sql"

type DatabaseClient = Database.Interface["db"]
const HashPattern = /^[0-9a-f]{64}$/

export type State = typeof LearningReviewerAttemptTable.$inferSelect.state
export type Verdict = "approve" | "reject" | "manual_review"
export type Record = ReturnType<typeof decode>

export class InputError extends Schema.TaggedErrorClass<InputError>()("DeepAgentLearningReviewerAttempt.InputError", {
  field: Schema.String,
  reason: Schema.String,
}) {}

export class FenceError extends Schema.TaggedErrorClass<FenceError>()("DeepAgentLearningReviewerAttempt.FenceError", {
  attemptId: Schema.String,
  reason: Schema.String,
}) {}

export const getByJob = Effect.fn("DeepAgentLearningReviewerAttempt.getByJob")(function* (
  db: DatabaseClient,
  jobId: string,
) {
  const row = yield* db
    .select()
    .from(LearningReviewerAttemptTable)
    .where(eq(LearningReviewerAttemptTable.job_id, jobId))
    .get()
  return row ? decode(row) : undefined
})

export const prepare = Effect.fn("DeepAgentLearningReviewerAttempt.prepare")(function* (
  db: DatabaseClient,
  input: {
    readonly attemptId: string
    readonly jobId: string
    readonly owner: string
    readonly expectedJobVersion: number
    readonly leaseMs: number
    readonly reviewSessionId: string
    readonly requestRef: string
    readonly requestHash: string
    readonly sourceCandidateIds: readonly string[]
    readonly providerId: string
    readonly modelId: string
    readonly policyHash: string
    readonly now?: number
  },
) {
  yield* validatePrepare(input)
  const now = input.now ?? Date.now()
  const sourceCandidateIds = canonicalCandidateIds(input.sourceCandidateIds)
  const sourceCandidateIdsJson = CanonicalJson.stringify(sourceCandidateIds)
  const sourceCandidateSetHash = Hash.sha256(sourceCandidateIdsJson)
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select()
          .from(LearningReviewerAttemptTable)
          .where(eq(LearningReviewerAttemptTable.job_id, input.jobId))
          .get()
        if (existing) {
          if (!samePreparedIdentity(existing, input, sourceCandidateIdsJson, sourceCandidateSetHash)) {
            return yield* new FenceError({ attemptId: input.attemptId, reason: "reviewer attempt identity conflict" })
          }
          return { created: false, attempt: decode(existing), jobVersion: input.expectedJobVersion } as const
        }
        const job = yield* tx
          .update(LearningJobTable)
          .set({
            side_effect_state: "started",
            side_effect_kind: "reviewer",
            expected_result_ref: input.requestRef,
            review_job_id: input.attemptId,
            lease_expires_at: now + input.leaseMs,
            version: input.expectedJobVersion + 1,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningJobTable.job_id, input.jobId),
              eq(LearningJobTable.state, "reviewing"),
              eq(LearningJobTable.side_effect_state, "not_started"),
              eq(LearningJobTable.owner, input.owner),
              eq(LearningJobTable.version, input.expectedJobVersion),
              gt(LearningJobTable.lease_expires_at, now),
            ),
          )
          .returning({ version: LearningJobTable.version })
          .get()
        if (!job)
          return yield* new FenceError({ attemptId: input.attemptId, reason: "learning job prepare fence lost" })
        const row = {
          attempt_id: input.attemptId,
          job_id: input.jobId,
          state: "prepared" as const,
          version: 0,
          owner: input.owner,
          review_session_id: input.reviewSessionId,
          request_ref: input.requestRef,
          request_hash: input.requestHash,
          source_candidate_ids_json: sourceCandidateIdsJson,
          source_candidate_set_hash: sourceCandidateSetHash,
          provider_id: input.providerId,
          model_id: input.modelId,
          policy_hash: input.policyHash,
          response_ref: null,
          response_hash: null,
          verdict: null,
          selected_candidate_ids_json: null,
          selected_subset_hash: null,
          error_code: null,
          error_detail: null,
          created_at: now,
          dispatched_at: null,
          settled_at: null,
          updated_at: now,
        }
        yield* tx.insert(LearningReviewerAttemptTable).values(row).run()
        return { created: true, attempt: decode(row), jobVersion: job.version } as const
      }),
    { behavior: "immediate" },
  )
})

export const dispatch = Effect.fn("DeepAgentLearningReviewerAttempt.dispatch")(function* (
  db: DatabaseClient,
  input: {
    readonly attemptId: string
    readonly owner: string
    readonly expectedVersion: number
    readonly now?: number
  },
) {
  const now = input.now ?? Date.now()
  const updated = yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const current = yield* tx
          .select({ attempt: LearningReviewerAttemptTable, job: LearningJobTable })
          .from(LearningReviewerAttemptTable)
          .innerJoin(LearningJobTable, eq(LearningJobTable.job_id, LearningReviewerAttemptTable.job_id))
          .where(eq(LearningReviewerAttemptTable.attempt_id, input.attemptId))
          .get()
        if (
          !current ||
          current.attempt.owner !== input.owner ||
          current.attempt.version !== input.expectedVersion ||
          current.attempt.state !== "prepared" ||
          current.job.state !== "reviewing" ||
          current.job.side_effect_state !== "started" ||
          current.job.side_effect_kind !== "reviewer" ||
          current.job.review_job_id !== input.attemptId ||
          current.job.expected_result_ref !== current.attempt.request_ref ||
          current.job.owner !== input.owner ||
          current.job.lease_expires_at === null ||
          current.job.lease_expires_at <= now
        ) {
          return undefined
        }
        return yield* tx
          .update(LearningReviewerAttemptTable)
          .set({ state: "dispatching", version: input.expectedVersion + 1, dispatched_at: now, updated_at: now })
          .where(
            and(
              eq(LearningReviewerAttemptTable.attempt_id, input.attemptId),
              eq(LearningReviewerAttemptTable.owner, input.owner),
              eq(LearningReviewerAttemptTable.version, input.expectedVersion),
              eq(LearningReviewerAttemptTable.state, "prepared"),
            ),
          )
          .returning()
          .get()
      }),
    { behavior: "immediate" },
  )
  if (!updated) return yield* fence(input.attemptId, "reviewer dispatch fence lost")
  return decode(updated)
})

export const quarantineDispatching = Effect.fn("DeepAgentLearningReviewerAttempt.quarantineDispatching")(function* (
  db: DatabaseClient,
  input: {
    readonly attemptId: string
    readonly owner: string
    readonly expectedAttemptVersion: number
    readonly expectedJobVersion: number
    readonly errorCode: string
    readonly errorDetail: string
    readonly now?: number
  },
) {
  yield* requireText("errorCode", input.errorCode)
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const attempt = yield* tx
          .update(LearningReviewerAttemptTable)
          .set({
            state: "recovery_required",
            version: input.expectedAttemptVersion + 1,
            error_code: input.errorCode,
            error_detail: input.errorDetail,
            settled_at: now,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningReviewerAttemptTable.attempt_id, input.attemptId),
              eq(LearningReviewerAttemptTable.owner, input.owner),
              eq(LearningReviewerAttemptTable.version, input.expectedAttemptVersion),
              eq(LearningReviewerAttemptTable.state, "dispatching"),
            ),
          )
          .returning()
          .get()
        if (!attempt) return yield* fence(input.attemptId, "reviewer quarantine fence lost")
        const job = yield* tx
          .update(LearningJobTable)
          .set({
            state: "recovery_required",
            owner: null,
            lease_expires_at: null,
            version: input.expectedJobVersion + 1,
            error_code: input.errorCode,
            error_detail: input.errorDetail,
            settled_at: now,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningJobTable.job_id, attempt.job_id),
              eq(LearningJobTable.owner, input.owner),
              eq(LearningJobTable.version, input.expectedJobVersion),
              eq(LearningJobTable.state, "reviewing"),
              eq(LearningJobTable.side_effect_state, "started"),
              eq(LearningJobTable.side_effect_kind, "reviewer"),
              eq(LearningJobTable.review_job_id, input.attemptId),
            ),
          )
          .returning({ version: LearningJobTable.version })
          .get()
        if (!job) return yield* fence(input.attemptId, "learning job reviewer quarantine fence lost")
        return { attempt: decode(attempt), jobVersion: job.version }
      }),
    { behavior: "immediate" },
  )
})

export const takeoverPrepared = Effect.fn("DeepAgentLearningReviewerAttempt.takeoverPrepared")(function* (
  db: DatabaseClient,
  input: { readonly owner: string; readonly leaseMs: number; readonly now?: number },
) {
  yield* requireText("owner", input.owner)
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    return yield* new InputError({ field: "leaseMs", reason: "must be a positive safe integer" })
  }
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const stale = yield* tx
          .select({ attempt: LearningReviewerAttemptTable, job: LearningJobTable })
          .from(LearningReviewerAttemptTable)
          .innerJoin(LearningJobTable, eq(LearningJobTable.job_id, LearningReviewerAttemptTable.job_id))
          .where(
            and(
              eq(LearningReviewerAttemptTable.state, "prepared"),
              eq(LearningJobTable.state, "reviewing"),
              eq(LearningJobTable.side_effect_state, "started"),
              eq(LearningJobTable.side_effect_kind, "reviewer"),
              lte(LearningJobTable.lease_expires_at, now),
            ),
          )
          .get()
        if (!stale) return undefined
        const job = yield* tx
          .update(LearningJobTable)
          .set({
            owner: input.owner,
            lease_expires_at: now + input.leaseMs,
            version: stale.job.version + 1,
            error_code: "reviewer_prepared_owner_takeover",
            error_detail:
              "The prior worker expired before reviewer dispatch; the immutable prepared request may continue.",
            updated_at: now,
          })
          .where(
            and(
              eq(LearningJobTable.job_id, stale.job.job_id),
              eq(LearningJobTable.version, stale.job.version),
              eq(LearningJobTable.state, "reviewing"),
              eq(LearningJobTable.side_effect_state, "started"),
              lte(LearningJobTable.lease_expires_at, now),
            ),
          )
          .returning({ version: LearningJobTable.version })
          .get()
        if (!job) return undefined
        const attempt = yield* tx
          .update(LearningReviewerAttemptTable)
          .set({ owner: input.owner, version: stale.attempt.version + 1, updated_at: now })
          .where(
            and(
              eq(LearningReviewerAttemptTable.attempt_id, stale.attempt.attempt_id),
              eq(LearningReviewerAttemptTable.version, stale.attempt.version),
              eq(LearningReviewerAttemptTable.state, "prepared"),
            ),
          )
          .returning()
          .get()
        if (!attempt) return yield* fence(stale.attempt.attempt_id, "prepared reviewer takeover fence lost")
        return { attempt: decode(attempt), jobId: stale.job.job_id, jobVersion: job.version }
      }),
    { behavior: "immediate" },
  )
})

export const settle = Effect.fn("DeepAgentLearningReviewerAttempt.settle")(function* (
  db: DatabaseClient,
  input: {
    readonly attemptId: string
    readonly owner: string
    readonly expectedAttemptVersion: number
    readonly expectedJobVersion: number
    readonly responseRef: string
    readonly responseHash: string
    readonly verdict: Verdict
    readonly selectedCandidateIds: readonly string[]
    readonly now?: number
  },
) {
  yield* requireHash("responseHash", input.responseHash)
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const current = yield* tx
          .select()
          .from(LearningReviewerAttemptTable)
          .where(eq(LearningReviewerAttemptTable.attempt_id, input.attemptId))
          .get()
        if (!current) return yield* fence(input.attemptId, "reviewer attempt is missing")
        const source = decodeCandidateIds(current.source_candidate_ids_json)
        const selected = canonicalCandidateIds(input.selectedCandidateIds)
        if (selected.some((candidateId) => !source.includes(candidateId))) {
          return yield* new FenceError({
            attemptId: input.attemptId,
            reason: "reviewer selected a candidate outside the frozen source set",
          })
        }
        if (input.verdict === "reject" && selected.length > 0) {
          return yield* new FenceError({
            attemptId: input.attemptId,
            reason: "a rejected reviewer response cannot authorize candidates",
          })
        }
        const selectedJson = CanonicalJson.stringify(selected)
        const selectedSubsetHash = Hash.sha256(selectedJson)
        const attempt = yield* tx
          .update(LearningReviewerAttemptTable)
          .set({
            state: "settled",
            version: input.expectedAttemptVersion + 1,
            response_ref: input.responseRef,
            response_hash: input.responseHash,
            verdict: input.verdict,
            selected_candidate_ids_json: selectedJson,
            selected_subset_hash: selectedSubsetHash,
            settled_at: now,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningReviewerAttemptTable.attempt_id, input.attemptId),
              eq(LearningReviewerAttemptTable.owner, input.owner),
              eq(LearningReviewerAttemptTable.version, input.expectedAttemptVersion),
              eq(LearningReviewerAttemptTable.state, "dispatching"),
            ),
          )
          .returning()
          .get()
        if (!attempt) return yield* fence(input.attemptId, "reviewer settlement fence lost")
        const job = yield* tx
          .update(LearningJobTable)
          .set({
            side_effect_state: "settled",
            result_ref: input.responseRef,
            version: input.expectedJobVersion + 1,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningJobTable.job_id, current.job_id),
              eq(LearningJobTable.owner, input.owner),
              eq(LearningJobTable.version, input.expectedJobVersion),
              eq(LearningJobTable.state, "reviewing"),
              eq(LearningJobTable.side_effect_state, "started"),
              eq(LearningJobTable.side_effect_kind, "reviewer"),
              eq(LearningJobTable.review_job_id, input.attemptId),
              eq(LearningJobTable.expected_result_ref, current.request_ref),
              gt(LearningJobTable.lease_expires_at, now),
            ),
          )
          .returning({ version: LearningJobTable.version })
          .get()
        if (!job) return yield* fence(input.attemptId, "learning job reviewer settlement fence lost")
        return { attempt: decode(attempt), jobVersion: job.version }
      }),
    { behavior: "immediate" },
  )
})

export const recoverStaleDispatching = Effect.fn("DeepAgentLearningReviewerAttempt.recoverStaleDispatching")(function* (
  db: DatabaseClient,
  input?: { readonly now?: number },
) {
  const now = input?.now ?? Date.now()
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const stale = yield* tx
            .select({ attempt: LearningReviewerAttemptTable, job: LearningJobTable })
            .from(LearningReviewerAttemptTable)
            .innerJoin(LearningJobTable, eq(LearningJobTable.job_id, LearningReviewerAttemptTable.job_id))
            .where(
              and(
                eq(LearningReviewerAttemptTable.state, "dispatching"),
                eq(LearningJobTable.state, "reviewing"),
                eq(LearningJobTable.side_effect_state, "started"),
                lte(LearningJobTable.lease_expires_at, now),
              ),
            )
            .all()
          return yield* Effect.forEach(stale, ({ attempt, job }) =>
            Effect.gen(function* () {
              const receipt = yield* tx
                .update(LearningReviewerAttemptTable)
                .set({
                  state: "recovery_required",
                  version: attempt.version + 1,
                  error_code: "reviewer_dispatch_indeterminate_after_crash",
                  error_detail: "The reviewer provider turn may have been dispatched; automatic replay is forbidden.",
                  settled_at: now,
                  updated_at: now,
                })
                .where(
                  and(
                    eq(LearningReviewerAttemptTable.attempt_id, attempt.attempt_id),
                    eq(LearningReviewerAttemptTable.version, attempt.version),
                    eq(LearningReviewerAttemptTable.state, "dispatching"),
                  ),
                )
                .returning()
                .get()
              if (!receipt) return undefined
              yield* tx
                .update(LearningJobTable)
                .set({
                  state: "recovery_required",
                  owner: null,
                  lease_expires_at: null,
                  version: job.version + 1,
                  error_code: "reviewer_dispatch_indeterminate_after_crash",
                  error_detail:
                    "The isolated reviewer dispatch receipt is indeterminate; provider work was not replayed.",
                  settled_at: now,
                  updated_at: now,
                })
                .where(
                  and(
                    eq(LearningJobTable.job_id, job.job_id),
                    eq(LearningJobTable.version, job.version),
                    eq(LearningJobTable.state, "reviewing"),
                    eq(LearningJobTable.side_effect_state, "started"),
                    lte(LearningJobTable.lease_expires_at, now),
                  ),
                )
                .run()
              return decode(receipt)
            }),
          )
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.map((rows) => rows.filter((row): row is Record => row !== undefined)))
})

function validatePrepare(input: {
  readonly attemptId: string
  readonly jobId: string
  readonly owner: string
  readonly leaseMs: number
  readonly reviewSessionId: string
  readonly requestRef: string
  readonly requestHash: string
  readonly sourceCandidateIds: readonly string[]
  readonly providerId: string
  readonly modelId: string
  readonly policyHash: string
}) {
  return Effect.gen(function* () {
    yield* requireText("attemptId", input.attemptId)
    yield* requireText("jobId", input.jobId)
    yield* requireText("owner", input.owner)
    yield* requireText("reviewSessionId", input.reviewSessionId)
    yield* requireText("requestRef", input.requestRef)
    yield* requireText("providerId", input.providerId)
    yield* requireText("modelId", input.modelId)
    yield* requireHash("requestHash", input.requestHash)
    yield* requireHash("policyHash", input.policyHash)
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      return yield* new InputError({ field: "leaseMs", reason: "must be a positive safe integer" })
    }
    canonicalCandidateIds(input.sourceCandidateIds)
  })
}

function samePreparedIdentity(
  row: typeof LearningReviewerAttemptTable.$inferSelect,
  input: {
    readonly attemptId: string
    readonly reviewSessionId: string
    readonly requestRef: string
    readonly requestHash: string
    readonly providerId: string
    readonly modelId: string
    readonly policyHash: string
  },
  sourceCandidateIdsJson: string,
  sourceCandidateSetHash: string,
) {
  return (
    row.attempt_id === input.attemptId &&
    row.state === "prepared" &&
    row.review_session_id === input.reviewSessionId &&
    row.request_ref === input.requestRef &&
    row.request_hash === input.requestHash &&
    row.source_candidate_ids_json === sourceCandidateIdsJson &&
    row.source_candidate_set_hash === sourceCandidateSetHash &&
    row.provider_id === input.providerId &&
    row.model_id === input.modelId &&
    row.policy_hash === input.policyHash
  )
}

function canonicalCandidateIds(input: readonly string[]) {
  const ids = [...input].sort()
  if (ids.length !== new Set(ids).size || ids.some((candidateId) => candidateId.trim().length === 0)) {
    throw new InputError({ field: "candidateIds", reason: "must contain unique non-empty candidate IDs" })
  }
  return ids
}

function decodeCandidateIds(input: string) {
  const value = JSON.parse(input)
  if (!Array.isArray(value) || value.some((candidateId) => typeof candidateId !== "string")) {
    throw new Error("Frozen reviewer candidate set is invalid")
  }
  return canonicalCandidateIds(value)
}

function requireText(field: string, value: string) {
  if (value.trim().length > 0) return Effect.void
  return new InputError({ field, reason: "must be non-empty" })
}

function requireHash(field: string, value: string) {
  if (HashPattern.test(value)) return Effect.void
  return new InputError({ field, reason: "must be a lowercase SHA-256" })
}

function fence(attemptId: string, reason: string) {
  return new FenceError({ attemptId, reason })
}

function decode(row: typeof LearningReviewerAttemptTable.$inferSelect) {
  return {
    attemptId: row.attempt_id,
    jobId: row.job_id,
    state: row.state,
    version: row.version,
    owner: row.owner,
    reviewSessionId: row.review_session_id,
    requestRef: row.request_ref,
    requestHash: row.request_hash,
    sourceCandidateIds: decodeCandidateIds(row.source_candidate_ids_json),
    sourceCandidateSetHash: row.source_candidate_set_hash,
    providerId: row.provider_id,
    modelId: row.model_id,
    policyHash: row.policy_hash,
    responseRef: row.response_ref,
    responseHash: row.response_hash,
    verdict: row.verdict,
    selectedCandidateIds: row.selected_candidate_ids_json ? decodeCandidateIds(row.selected_candidate_ids_json) : null,
    selectedSubsetHash: row.selected_subset_hash,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  }
}
