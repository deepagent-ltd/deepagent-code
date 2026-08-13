export * as DeepAgentLearningGovernance from "./learning-governance"

import { and, asc, eq, gt, isNotNull, isNull, lt, lte, or } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import {
  LearningGovernanceActionTable,
  LearningGovernanceCompensationTable,
  LearningGovernancePlanTable,
} from "./learning-governance.sql"
import { LearningJobTable } from "./learning-job.sql"

type DatabaseClient = Database.Interface["db"]
type Transaction = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer T) => unknown ? T : never
type ActionKind = "document_stage" | "memory_inbox"
type PlanState = "prepared" | "settled" | "recovery_required"
type ActionState = "prepared" | "running" | "settled" | "recovery_required"
type CompensationKind = "document_quarantine" | "memory_inbox_revoke"

export type ActionInput = {
  readonly candidateId: string
  readonly kind: ActionKind
  readonly payload: unknown
  readonly predecessorSequence?: number
}

export type PrepareInput = {
  readonly jobId: string
  readonly owner: string
  readonly expectedJobVersion: number
  readonly leaseMs: number
  readonly actions: readonly ActionInput[]
  readonly now?: number
}

export type PlanRecord = {
  readonly planId: string
  readonly jobId: string
  readonly policy: "manual_review"
  readonly payload: unknown
  readonly payloadJson: string
  readonly payloadFingerprint: string
  readonly actionCount: number
  readonly jobOwner: string
  readonly sourceJobVersion: number
  readonly jobStartedVersion: number
  readonly state: PlanState
  readonly version: number
  readonly resultRef: string | null
  readonly resultHash: string | null
  readonly resultFingerprint: string | null
  readonly errorCode: string | null
  readonly errorDetail: string | null
  readonly createdAt: number
  readonly settledAt: number | null
  readonly updatedAt: number
}

export type ActionRecord = {
  readonly actionId: string
  readonly planId: string
  readonly candidateId: string
  readonly sequence: number
  readonly kind: ActionKind
  readonly predecessorActionId: string | null
  readonly payload: unknown
  readonly payloadJson: string
  readonly payloadFingerprint: string
  readonly state: ActionState
  readonly owner: string | null
  readonly leaseExpiresAt: number | null
  readonly version: number
  readonly resultRef: string | null
  readonly resultHash: string | null
  readonly resultFingerprint: string | null
  readonly errorCode: string | null
  readonly errorDetail: string | null
  readonly createdAt: number
  readonly settledAt: number | null
  readonly updatedAt: number
}

export type CompensationRecord = {
  readonly compensationId: string
  readonly planId: string
  readonly actionId: string
  readonly sequence: number
  readonly kind: CompensationKind
  readonly sourcePayloadFingerprint: string
  readonly state: ActionState
  readonly owner: string | null
  readonly leaseExpiresAt: number | null
  readonly version: number
  readonly resultRef: string | null
  readonly resultHash: string | null
  readonly resultFingerprint: string | null
  readonly errorCode: string | null
  readonly errorDetail: string | null
  readonly createdAt: number
  readonly settledAt: number | null
  readonly updatedAt: number
}

export type Snapshot = {
  readonly plan: PlanRecord
  readonly actions: readonly ActionRecord[]
}

export class InputError extends Schema.TaggedErrorClass<InputError>()("DeepAgentLearningGovernance.InputError", {
  field: Schema.String,
  reason: Schema.String,
}) {}

export class IdentityConflictError extends Schema.TaggedErrorClass<IdentityConflictError>()(
  "DeepAgentLearningGovernance.IdentityConflictError",
  { planId: Schema.String },
) {}

export class FenceError extends Schema.TaggedErrorClass<FenceError>()("DeepAgentLearningGovernance.FenceError", {
  id: Schema.String,
  reason: Schema.String,
}) {}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export const prepare = Effect.fn("DeepAgentLearningGovernance.prepare")(function* (
  db: DatabaseClient,
  input: PrepareInput,
) {
  yield* requireText("jobId", input.jobId)
  yield* requireText("owner", input.owner)
  yield* requireVersion("expectedJobVersion", input.expectedJobVersion)
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    return yield* new InputError({ field: "leaseMs", reason: "must be a positive safe integer" })
  }
  const now = input.now ?? Date.now()
  const actions = yield* prepareActions(planIdForJob(input.jobId), input.actions)
  const payloadJson = CanonicalJson.stringify({
    schemaVersion: "deepagent.learning_governance_plan.v1",
    jobId: input.jobId,
    policy: "manual_review",
    actions: actions.map((action) => ({
      candidateId: action.candidateId,
      kind: action.kind,
      predecessorSequence: action.predecessorSequence,
      payload: action.payload,
    })),
  })
  const payloadFingerprint = Hash.sha256(payloadJson)
  const planId = planIdForJob(input.jobId)

  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select()
          .from(LearningGovernancePlanTable)
          .where(eq(LearningGovernancePlanTable.plan_id, planId))
          .get()
        if (existing) {
          if (
            existing.job_id !== input.jobId ||
            existing.payload_json !== payloadJson ||
            existing.payload_fingerprint !== payloadFingerprint ||
            existing.action_count !== actions.length ||
            existing.job_owner !== input.owner ||
            existing.source_job_version !== input.expectedJobVersion
          ) {
            return yield* new IdentityConflictError({ planId })
          }
          return yield* reconstructInTransaction(tx, existing)
        }

        const liveJob = yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, input.jobId)).get()
        if (
          !liveJob ||
          liveJob.state !== "governance" ||
          liveJob.side_effect_state !== "not_started" ||
          liveJob.side_effect_kind !== null ||
          liveJob.owner !== input.owner ||
          liveJob.version !== input.expectedJobVersion ||
          liveJob.lease_expires_at === null ||
          liveJob.lease_expires_at <= now
        ) {
          return yield* new FenceError({
            id: input.jobId,
            reason: "live governance job owner, lease, or version was lost",
          })
        }

        yield* tx.insert(LearningGovernancePlanTable).values({
          plan_id: planId,
          job_id: input.jobId,
          policy: "manual_review",
          payload_json: payloadJson,
          payload_fingerprint: payloadFingerprint,
          action_count: actions.length,
          job_owner: input.owner,
          source_job_version: input.expectedJobVersion,
          job_started_version: input.expectedJobVersion + 1,
          state: "prepared",
          version: 0,
          created_at: now,
          updated_at: now,
        })
        yield* Effect.forEach(actions, (action) =>
          tx.insert(LearningGovernanceActionTable).values({
            action_id: action.actionId,
            plan_id: planId,
            candidate_id: action.candidateId,
            sequence: action.sequence,
            kind: action.kind,
            predecessor_action_id:
              action.predecessorSequence === null ? null : actions[action.predecessorSequence]!.actionId,
            payload_json: action.payloadJson,
            payload_fingerprint: action.payloadFingerprint,
            state: "prepared",
            version: 0,
            created_at: now,
            updated_at: now,
          }),
        )
        const job = yield* tx
          .update(LearningJobTable)
          .set({
            side_effect_state: "started",
            side_effect_kind: "governance",
            lease_expires_at: now + input.leaseMs,
            version: input.expectedJobVersion + 1,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningJobTable.job_id, input.jobId),
              eq(LearningJobTable.state, "governance"),
              eq(LearningJobTable.side_effect_state, "not_started"),
              isNull(LearningJobTable.side_effect_kind),
              eq(LearningJobTable.owner, input.owner),
              eq(LearningJobTable.version, input.expectedJobVersion),
              gt(LearningJobTable.lease_expires_at, now),
            ),
          )
          .returning()
          .get()
        if (!job) {
          return yield* new FenceError({
            id: input.jobId,
            reason: "live governance job owner, lease, or version was lost",
          })
        }
        const plan = yield* tx
          .select()
          .from(LearningGovernancePlanTable)
          .where(eq(LearningGovernancePlanTable.plan_id, planId))
          .get()
        return yield* reconstructInTransaction(tx, plan!)
      }),
    { behavior: "immediate" },
  )
})

export const get = Effect.fn("DeepAgentLearningGovernance.get")(function* (db: DatabaseClient, planId: string) {
  const plan = yield* db
    .select()
    .from(LearningGovernancePlanTable)
    .where(eq(LearningGovernancePlanTable.plan_id, planId))
    .get()
  if (!plan) return undefined
  return yield* reconstructInTransaction(db, plan)
})

export const getByJob = Effect.fn("DeepAgentLearningGovernance.getByJob")(function* (
  db: DatabaseClient,
  jobId: string,
) {
  const plan = yield* db
    .select()
    .from(LearningGovernancePlanTable)
    .where(eq(LearningGovernancePlanTable.job_id, jobId))
    .get()
  if (!plan) return undefined
  return yield* reconstructInTransaction(db, plan)
})

export const claimAction = Effect.fn("DeepAgentLearningGovernance.claimAction")(function* (
  db: DatabaseClient,
  input: { readonly planId: string; readonly owner: string; readonly leaseMs: number; readonly now?: number },
) {
  yield* requireText("planId", input.planId)
  yield* requireText("owner", input.owner)
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    return yield* new InputError({ field: "leaseMs", reason: "must be a positive safe integer" })
  }
  const now = input.now ?? Date.now()

  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const plan = yield* tx
          .select()
          .from(LearningGovernancePlanTable)
          .where(eq(LearningGovernancePlanTable.plan_id, input.planId))
          .get()
        if (!plan || plan.state !== "prepared") return undefined
        const job = yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, plan.job_id)).get()
        if (
          !job ||
          job.state !== "governance" ||
          job.side_effect_state !== "started" ||
          job.side_effect_kind !== "governance" ||
          job.owner !== input.owner ||
          job.version !== plan.job_started_version ||
          job.lease_expires_at === null ||
          job.lease_expires_at <= now
        ) {
          return yield* new FenceError({ id: plan.job_id, reason: "live governance job fence was lost" })
        }
        const actions = yield* tx
          .select()
          .from(LearningGovernanceActionTable)
          .where(eq(LearningGovernanceActionTable.plan_id, input.planId))
          .orderBy(asc(LearningGovernanceActionTable.sequence))
          .all()
        const settled = new Set(
          actions.filter((action) => action.state === "settled").map((action) => action.action_id),
        )
        const next = actions.find(
          (action) =>
            (action.predecessor_action_id === null || settled.has(action.predecessor_action_id)) &&
            (action.state === "prepared" ||
              (action.state === "running" && action.lease_expires_at !== null && action.lease_expires_at <= now)),
        )
        if (!next) return undefined
        const claimed = yield* tx
          .update(LearningGovernanceActionTable)
          .set({
            state: "running",
            owner: input.owner,
            lease_expires_at: job.lease_expires_at,
            version: next.version + 1,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningGovernanceActionTable.action_id, next.action_id),
              eq(LearningGovernanceActionTable.version, next.version),
              next.state === "prepared"
                ? eq(LearningGovernanceActionTable.state, "prepared")
                : and(
                    eq(LearningGovernanceActionTable.state, "running"),
                    eq(LearningGovernanceActionTable.owner, next.owner!),
                    lteLease(now),
                  ),
            ),
          )
          .returning()
          .get()
        return claimed ? decodeAction(claimed) : undefined
      }),
    { behavior: "immediate" },
  )
})

export const takeover = Effect.fn("DeepAgentLearningGovernance.takeover")(function* (
  db: DatabaseClient,
  input: { readonly jobId: string; readonly owner: string; readonly leaseMs: number; readonly now?: number },
) {
  yield* requireText("jobId", input.jobId)
  yield* requireText("owner", input.owner)
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    return yield* new InputError({ field: "leaseMs", reason: "must be a positive safe integer" })
  }
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const plan = yield* tx
          .select()
          .from(LearningGovernancePlanTable)
          .where(eq(LearningGovernancePlanTable.job_id, input.jobId))
          .get()
        if (!plan || plan.state !== "prepared") return undefined
        const job = yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, input.jobId)).get()
        if (
          !job ||
          job.state !== "governance" ||
          job.side_effect_state !== "started" ||
          job.side_effect_kind !== "governance" ||
          job.lease_expires_at === null ||
          job.lease_expires_at > now ||
          job.version !== plan.job_started_version
        )
          return undefined
        const claimed = yield* tx
          .update(LearningJobTable)
          .set({
            owner: input.owner,
            lease_expires_at: now + input.leaseMs,
            version: job.version + 1,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningJobTable.job_id, input.jobId),
              eq(LearningJobTable.state, "governance"),
              eq(LearningJobTable.side_effect_state, "started"),
              eq(LearningJobTable.side_effect_kind, "governance"),
              eq(LearningJobTable.version, job.version),
              lte(LearningJobTable.lease_expires_at, now),
            ),
          )
          .returning()
          .get()
        if (!claimed) return yield* new FenceError({ id: input.jobId, reason: "governance takeover fence was lost" })
        const rebound = yield* tx
          .update(LearningGovernancePlanTable)
          .set({
            job_owner: input.owner,
            job_started_version: claimed.version,
            version: plan.version + 1,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningGovernancePlanTable.plan_id, plan.plan_id),
              eq(LearningGovernancePlanTable.state, "prepared"),
              eq(LearningGovernancePlanTable.version, plan.version),
            ),
          )
          .returning()
          .get()
        if (!rebound) return yield* new FenceError({ id: plan.plan_id, reason: "plan takeover fence was lost" })
        return yield* reconstructInTransaction(tx, rebound)
      }),
    { behavior: "immediate" },
  )
})

export const takeoverNext = Effect.fn("DeepAgentLearningGovernance.takeoverNext")(function* (
  db: DatabaseClient,
  input: { readonly owner: string; readonly leaseMs: number; readonly now?: number },
) {
  const now = input.now ?? Date.now()
  const expired = yield* db
    .select({ jobId: LearningJobTable.job_id })
    .from(LearningJobTable)
    .innerJoin(LearningGovernancePlanTable, eq(LearningGovernancePlanTable.job_id, LearningJobTable.job_id))
    .where(
      and(
        eq(LearningJobTable.state, "governance"),
        eq(LearningJobTable.side_effect_state, "started"),
        eq(LearningJobTable.side_effect_kind, "governance"),
        lte(LearningJobTable.lease_expires_at, now),
        eq(LearningGovernancePlanTable.state, "prepared"),
      ),
    )
    .orderBy(asc(LearningJobTable.lease_expires_at), asc(LearningJobTable.job_id))
    .get()
  if (!expired) return undefined
  return yield* takeover(db, { jobId: expired.jobId, owner: input.owner, leaseMs: input.leaseMs, now })
})

export const failAction = Effect.fn("DeepAgentLearningGovernance.failAction")(function* (
  db: DatabaseClient,
  input: {
    readonly actionId: string
    readonly owner: string
    readonly expectedVersion: number
    readonly errorCode: string
    readonly errorDetail: string
    readonly now?: number
  },
) {
  yield* requireText("actionId", input.actionId)
  yield* requireText("owner", input.owner)
  yield* requireVersion("expectedVersion", input.expectedVersion)
  yield* requireText("errorCode", input.errorCode)
  yield* requireText("errorDetail", input.errorDetail)
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const action = yield* tx
          .select()
          .from(LearningGovernanceActionTable)
          .where(eq(LearningGovernanceActionTable.action_id, input.actionId))
          .get()
        const plan = action
          ? yield* tx
              .select()
              .from(LearningGovernancePlanTable)
              .where(eq(LearningGovernancePlanTable.plan_id, action.plan_id))
              .get()
          : undefined
        const job = plan
          ? yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, plan.job_id)).get()
          : undefined
        if (
          !action ||
          !plan ||
          !job ||
          plan.state !== "prepared" ||
          job.state !== "governance" ||
          job.side_effect_state !== "started" ||
          job.side_effect_kind !== "governance" ||
          job.owner !== input.owner ||
          job.version !== plan.job_started_version ||
          job.lease_expires_at === null ||
          job.lease_expires_at <= now
        ) {
          return yield* new FenceError({ id: input.actionId, reason: "live governance job fence was lost" })
        }
        const failed = yield* tx
          .update(LearningGovernanceActionTable)
          .set({
            state: "recovery_required",
            owner: null,
            lease_expires_at: null,
            version: input.expectedVersion + 1,
            error_code: input.errorCode,
            error_detail: input.errorDetail,
            settled_at: now,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningGovernanceActionTable.action_id, input.actionId),
              eq(LearningGovernanceActionTable.state, "running"),
              eq(LearningGovernanceActionTable.owner, input.owner),
              eq(LearningGovernanceActionTable.version, input.expectedVersion),
            ),
          )
          .returning()
          .get()
        if (!failed) return yield* new FenceError({ id: input.actionId, reason: "action failure fence was lost" })
        yield* failPlanAndJob(tx, failed.plan_id, input.errorCode, input.errorDetail, now)
        return decodeAction(failed)
      }),
    { behavior: "immediate" },
  )
})

export const settleAction = Effect.fn("DeepAgentLearningGovernance.settleAction")(function* (
  db: DatabaseClient,
  input: {
    readonly actionId: string
    readonly owner: string
    readonly expectedVersion: number
    readonly resultRef: string
    readonly resultHash: string
    readonly now?: number
  },
) {
  yield* requireText("actionId", input.actionId)
  yield* requireText("owner", input.owner)
  yield* requireVersion("expectedVersion", input.expectedVersion)
  yield* requireText("resultRef", input.resultRef)
  yield* requireHash("resultHash", input.resultHash)
  const now = input.now ?? Date.now()
  const resultFingerprint = settlementFingerprint(input.resultRef, input.resultHash)

  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select()
          .from(LearningGovernanceActionTable)
          .where(eq(LearningGovernanceActionTable.action_id, input.actionId))
          .get()
        if (!existing) return yield* new FenceError({ id: input.actionId, reason: "action does not exist" })
        if (existing.state === "settled") {
          if (
            existing.result_ref === input.resultRef &&
            existing.result_hash === input.resultHash &&
            existing.result_fingerprint === resultFingerprint
          ) {
            return decodeAction(existing)
          }
          if (input.expectedVersion !== existing.version) {
            return yield* new FenceError({ id: input.actionId, reason: "action conflict version fence was lost" })
          }
          const plan = yield* tx
            .select()
            .from(LearningGovernancePlanTable)
            .where(eq(LearningGovernancePlanTable.plan_id, existing.plan_id))
            .get()
          const job = plan
            ? yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, plan.job_id)).get()
            : undefined
          if (job?.state === "completed") {
            return yield* new FenceError({
              id: input.actionId,
              reason: "completed learning job forbids conflicting governance action output",
            })
          }
          const conflicted = yield* tx
            .update(LearningGovernanceActionTable)
            .set({
              state: "recovery_required",
              version: existing.version + 1,
              error_code: "governance_action_output_conflict",
              error_detail: CanonicalJson.stringify({
                attemptedResultRef: input.resultRef,
                attemptedResultHash: input.resultHash,
                attemptedResultFingerprint: resultFingerprint,
              }),
              settled_at: now,
              updated_at: now,
            })
            .where(
              and(
                eq(LearningGovernanceActionTable.action_id, input.actionId),
                eq(LearningGovernanceActionTable.state, "settled"),
                eq(LearningGovernanceActionTable.version, existing.version),
              ),
            )
            .returning()
            .get()
          if (!conflicted)
            return yield* new FenceError({ id: input.actionId, reason: "action conflict fence was lost" })
          yield* failPlanAndJob(tx, existing.plan_id, "governance_action_output_conflict", input.actionId, now)
          return decodeAction(conflicted)
        }
        const plan = yield* tx
          .select()
          .from(LearningGovernancePlanTable)
          .where(eq(LearningGovernancePlanTable.plan_id, existing.plan_id))
          .get()
        const job = plan
          ? yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, plan.job_id)).get()
          : undefined
        if (
          !plan ||
          plan.state !== "prepared" ||
          !job ||
          job.state !== "governance" ||
          job.side_effect_state !== "started" ||
          job.side_effect_kind !== "governance" ||
          job.owner !== input.owner ||
          job.version !== plan.job_started_version ||
          job.lease_expires_at === null ||
          job.lease_expires_at <= now
        ) {
          return yield* new FenceError({ id: input.actionId, reason: "live governance job fence was lost" })
        }
        const settled = yield* tx
          .update(LearningGovernanceActionTable)
          .set({
            state: "settled",
            owner: null,
            lease_expires_at: null,
            version: input.expectedVersion + 1,
            result_ref: input.resultRef,
            result_hash: input.resultHash,
            result_fingerprint: resultFingerprint,
            settled_at: now,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningGovernanceActionTable.action_id, input.actionId),
              eq(LearningGovernanceActionTable.state, "running"),
              eq(LearningGovernanceActionTable.owner, input.owner),
              eq(LearningGovernanceActionTable.version, input.expectedVersion),
              gt(LearningGovernanceActionTable.lease_expires_at, now),
            ),
          )
          .returning()
          .get()
        if (!settled)
          return yield* new FenceError({ id: input.actionId, reason: "action owner, lease, or version was lost" })
        return decodeAction(settled)
      }),
    { behavior: "immediate" },
  )
})

export const settlePlan = Effect.fn("DeepAgentLearningGovernance.settlePlan")(function* (
  db: DatabaseClient,
  input: {
    readonly planId: string
    readonly owner: string
    readonly expectedVersion: number
    readonly resultRef: string
    readonly resultHash: string
    readonly now?: number
  },
) {
  yield* requireText("planId", input.planId)
  yield* requireText("owner", input.owner)
  yield* requireVersion("expectedVersion", input.expectedVersion)
  yield* requireText("resultRef", input.resultRef)
  yield* requireHash("resultHash", input.resultHash)
  const now = input.now ?? Date.now()
  const resultFingerprint = settlementFingerprint(input.resultRef, input.resultHash)

  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select()
          .from(LearningGovernancePlanTable)
          .where(eq(LearningGovernancePlanTable.plan_id, input.planId))
          .get()
        if (!existing) return yield* new FenceError({ id: input.planId, reason: "plan does not exist" })
        if (existing.state === "settled") {
          if (
            existing.result_ref === input.resultRef &&
            existing.result_hash === input.resultHash &&
            existing.result_fingerprint === resultFingerprint
          ) {
            return yield* reconstructInTransaction(tx, existing)
          }
          if (input.expectedVersion !== existing.version) {
            return yield* new FenceError({ id: input.planId, reason: "plan conflict version fence was lost" })
          }
          const job = yield* tx
            .select()
            .from(LearningJobTable)
            .where(eq(LearningJobTable.job_id, existing.job_id))
            .get()
          if (job?.state === "completed") {
            return yield* new FenceError({
              id: input.planId,
              reason: "completed learning job forbids conflicting governance plan output",
            })
          }
          const conflicted = yield* tx
            .update(LearningGovernancePlanTable)
            .set({
              state: "recovery_required",
              version: existing.version + 1,
              error_code: "governance_plan_output_conflict",
              error_detail: CanonicalJson.stringify({
                attemptedResultRef: input.resultRef,
                attemptedResultHash: input.resultHash,
                attemptedResultFingerprint: resultFingerprint,
              }),
              settled_at: now,
              updated_at: now,
            })
            .where(
              and(
                eq(LearningGovernancePlanTable.plan_id, input.planId),
                eq(LearningGovernancePlanTable.state, "settled"),
                eq(LearningGovernancePlanTable.version, existing.version),
              ),
            )
            .returning()
            .get()
          if (!conflicted) return yield* new FenceError({ id: input.planId, reason: "plan conflict fence was lost" })
          yield* failJob(tx, existing.job_id, "governance_plan_output_conflict", input.planId, now)
          return yield* reconstructInTransaction(tx, conflicted)
        }
        const actions = yield* tx
          .select()
          .from(LearningGovernanceActionTable)
          .where(eq(LearningGovernanceActionTable.plan_id, input.planId))
          .all()
        if (actions.length !== existing.action_count || actions.some((action) => action.state !== "settled")) {
          return yield* new FenceError({ id: input.planId, reason: "all declared governance actions must be settled" })
        }
        const job = yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, existing.job_id)).get()
        if (
          !job ||
          job.state !== "governance" ||
          job.side_effect_state !== "started" ||
          job.side_effect_kind !== "governance" ||
          job.owner !== input.owner ||
          job.version !== existing.job_started_version ||
          job.lease_expires_at === null ||
          job.lease_expires_at <= now
        ) {
          return yield* new FenceError({ id: existing.job_id, reason: "live governance job fence was lost" })
        }
        const plan = yield* tx
          .update(LearningGovernancePlanTable)
          .set({
            state: "settled",
            version: input.expectedVersion + 1,
            result_ref: input.resultRef,
            result_hash: input.resultHash,
            result_fingerprint: resultFingerprint,
            settled_at: now,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningGovernancePlanTable.plan_id, input.planId),
              eq(LearningGovernancePlanTable.state, "prepared"),
              eq(LearningGovernancePlanTable.version, input.expectedVersion),
            ),
          )
          .returning()
          .get()
        if (!plan) return yield* new FenceError({ id: input.planId, reason: "plan version fence was lost" })
        const settledJob = yield* tx
          .update(LearningJobTable)
          .set({
            side_effect_state: "settled",
            result_ref: input.resultRef,
            version: job.version + 1,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningJobTable.job_id, job.job_id),
              eq(LearningJobTable.state, "governance"),
              eq(LearningJobTable.side_effect_state, "started"),
              eq(LearningJobTable.side_effect_kind, "governance"),
              eq(LearningJobTable.owner, input.owner),
              eq(LearningJobTable.version, job.version),
              gt(LearningJobTable.lease_expires_at, now),
            ),
          )
          .returning()
          .get()
        if (!settledJob) return yield* new FenceError({ id: job.job_id, reason: "job settlement fence was lost" })
        return yield* reconstructInTransaction(tx, plan)
      }),
    { behavior: "immediate" },
  )
})

export const prepareCompensation = Effect.fn("DeepAgentLearningGovernance.prepareCompensation")(function* (
  db: DatabaseClient,
  input: { readonly planId: string; readonly errorCode: string; readonly errorDetail: string; readonly now?: number },
) {
  yield* requireText("planId", input.planId)
  yield* requireText("errorCode", input.errorCode)
  yield* requireText("errorDetail", input.errorDetail)
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const plan = yield* tx
          .select()
          .from(LearningGovernancePlanTable)
          .where(eq(LearningGovernancePlanTable.plan_id, input.planId))
          .get()
        if (!plan) return yield* new FenceError({ id: input.planId, reason: "plan does not exist" })
        if (plan.state !== "recovery_required")
          return yield* new FenceError({ id: input.planId, reason: "only a failed governance plan may compensate" })
        const reversible = yield* reversibleActions(tx, input.planId)
        const existing = yield* tx
          .select()
          .from(LearningGovernanceCompensationTable)
          .where(eq(LearningGovernanceCompensationTable.plan_id, input.planId))
          .orderBy(asc(LearningGovernanceCompensationTable.sequence))
          .all()
        if (existing.length > 0) {
          if (
            existing.length !== reversible.length ||
            existing.some(
              (item, sequence) =>
                item.action_id !== reversible[sequence]?.action_id ||
                item.source_payload_fingerprint !== reversible[sequence]?.payload_fingerprint,
            )
          )
            return yield* new IdentityConflictError({ planId: input.planId })
          return existing.map(decodeCompensation)
        }
        yield* insertCompensations(tx, reversible, now)
        const current = yield* tx
          .select()
          .from(LearningGovernanceCompensationTable)
          .where(eq(LearningGovernanceCompensationTable.plan_id, input.planId))
          .orderBy(asc(LearningGovernanceCompensationTable.sequence))
          .all()
        return current.map(decodeCompensation)
      }),
    { behavior: "immediate" },
  )
})

export const claimCompensation = Effect.fn("DeepAgentLearningGovernance.claimCompensation")(function* (
  db: DatabaseClient,
  input: { readonly planId: string; readonly owner: string; readonly leaseMs: number; readonly now?: number },
) {
  yield* requireText("planId", input.planId)
  yield* requireText("owner", input.owner)
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0)
    return yield* new InputError({ field: "leaseMs", reason: "must be a positive safe integer" })
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const items = yield* tx
          .select()
          .from(LearningGovernanceCompensationTable)
          .where(eq(LearningGovernanceCompensationTable.plan_id, input.planId))
          .orderBy(asc(LearningGovernanceCompensationTable.sequence))
          .all()
        const plan = yield* tx
          .select()
          .from(LearningGovernancePlanTable)
          .where(eq(LearningGovernancePlanTable.plan_id, input.planId))
          .get()
        const job = plan
          ? yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, plan.job_id)).get()
          : undefined
        if (!plan || plan.state !== "recovery_required" || !job || job.state !== "recovery_required")
          return yield* new FenceError({ id: input.planId, reason: "compensation requires a failed plan and job" })
        const prior = new Set(items.filter((item) => item.state === "settled").map((item) => item.sequence))
        const next = items.find(
          (item) =>
            (item.sequence === 0 || prior.has(item.sequence - 1)) &&
            (item.state === "prepared" ||
              (item.state === "running" && item.lease_expires_at !== null && item.lease_expires_at <= now)),
        )
        if (!next) return undefined
        const claimed = yield* tx
          .update(LearningGovernanceCompensationTable)
          .set({
            state: "running",
            owner: input.owner,
            lease_expires_at: now + input.leaseMs,
            version: next.version + 1,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningGovernanceCompensationTable.compensation_id, next.compensation_id),
              eq(LearningGovernanceCompensationTable.version, next.version),
              next.state === "prepared"
                ? eq(LearningGovernanceCompensationTable.state, "prepared")
                : and(
                    eq(LearningGovernanceCompensationTable.state, "running"),
                    eq(LearningGovernanceCompensationTable.owner, next.owner!),
                    lte(LearningGovernanceCompensationTable.lease_expires_at, now),
                  ),
            ),
          )
          .returning()
          .get()
        return claimed ? decodeCompensation(claimed) : undefined
      }),
    { behavior: "immediate" },
  )
})

export const claimNextCompensation = Effect.fn("DeepAgentLearningGovernance.claimNextCompensation")(function* (
  db: DatabaseClient,
  input: { readonly owner: string; readonly leaseMs: number; readonly now?: number },
) {
  const now = input.now ?? Date.now()
  const next = yield* db
    .select({ planId: LearningGovernanceCompensationTable.plan_id })
    .from(LearningGovernanceCompensationTable)
    .where(
      or(
        eq(LearningGovernanceCompensationTable.state, "prepared"),
        and(
          eq(LearningGovernanceCompensationTable.state, "running"),
          lte(LearningGovernanceCompensationTable.lease_expires_at, now),
        ),
      ),
    )
    .orderBy(asc(LearningGovernanceCompensationTable.created_at), asc(LearningGovernanceCompensationTable.sequence))
    .get()
  if (!next) return undefined
  return yield* claimCompensation(db, { ...input, planId: next.planId })
})

export const getAction = Effect.fn("DeepAgentLearningGovernance.getAction")(function* (
  db: DatabaseClient,
  actionId: string,
) {
  const action = yield* db
    .select()
    .from(LearningGovernanceActionTable)
    .where(eq(LearningGovernanceActionTable.action_id, actionId))
    .get()
  return action ? decodeAction(action) : undefined
})

export const settleCompensation = Effect.fn("DeepAgentLearningGovernance.settleCompensation")(function* (
  db: DatabaseClient,
  input: {
    readonly compensationId: string
    readonly owner: string
    readonly expectedVersion: number
    readonly resultRef: string
    readonly resultHash: string
    readonly now?: number
  },
) {
  yield* requireText("compensationId", input.compensationId)
  yield* requireText("owner", input.owner)
  yield* requireVersion("expectedVersion", input.expectedVersion)
  yield* requireText("resultRef", input.resultRef)
  yield* requireHash("resultHash", input.resultHash)
  const now = input.now ?? Date.now()
  const resultFingerprint = settlementFingerprint(input.resultRef, input.resultHash)
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select()
          .from(LearningGovernanceCompensationTable)
          .where(eq(LearningGovernanceCompensationTable.compensation_id, input.compensationId))
          .get()
        if (!existing) return yield* new FenceError({ id: input.compensationId, reason: "compensation missing" })
        if (existing.state === "settled") {
          if (
            existing.result_ref === input.resultRef &&
            existing.result_hash === input.resultHash &&
            existing.result_fingerprint === resultFingerprint
          )
            return decodeCompensation(existing)
          return yield* new FenceError({ id: input.compensationId, reason: "compensation output conflict" })
        }
        const settled = yield* tx
          .update(LearningGovernanceCompensationTable)
          .set({
            state: "settled",
            owner: null,
            lease_expires_at: null,
            version: input.expectedVersion + 1,
            result_ref: input.resultRef,
            result_hash: input.resultHash,
            result_fingerprint: resultFingerprint,
            settled_at: now,
            updated_at: now,
          })
          .where(
            and(
              eq(LearningGovernanceCompensationTable.compensation_id, input.compensationId),
              eq(LearningGovernanceCompensationTable.state, "running"),
              eq(LearningGovernanceCompensationTable.owner, input.owner),
              eq(LearningGovernanceCompensationTable.version, input.expectedVersion),
              gt(LearningGovernanceCompensationTable.lease_expires_at, now),
            ),
          )
          .returning()
          .get()
        if (!settled) return yield* new FenceError({ id: input.compensationId, reason: "compensation fence lost" })
        return decodeCompensation(settled)
      }),
    { behavior: "immediate" },
  )
})

export const failCompensation = Effect.fn("DeepAgentLearningGovernance.failCompensation")(function* (
  db: DatabaseClient,
  input: {
    readonly compensationId: string
    readonly owner: string
    readonly expectedVersion: number
    readonly errorCode: string
    readonly errorDetail: string
    readonly now?: number
  },
) {
  yield* requireText("compensationId", input.compensationId)
  yield* requireText("owner", input.owner)
  yield* requireVersion("expectedVersion", input.expectedVersion)
  yield* requireText("errorCode", input.errorCode)
  const now = input.now ?? Date.now()
  const failed = yield* db
    .update(LearningGovernanceCompensationTable)
    .set({
      state: "recovery_required",
      owner: null,
      lease_expires_at: null,
      version: input.expectedVersion + 1,
      error_code: input.errorCode,
      error_detail: input.errorDetail,
      settled_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(LearningGovernanceCompensationTable.compensation_id, input.compensationId),
        eq(LearningGovernanceCompensationTable.state, "running"),
        eq(LearningGovernanceCompensationTable.owner, input.owner),
        eq(LearningGovernanceCompensationTable.version, input.expectedVersion),
        gt(LearningGovernanceCompensationTable.lease_expires_at, now),
      ),
    )
    .returning()
    .get()
  if (!failed) return yield* new FenceError({ id: input.compensationId, reason: "compensation failure fence lost" })
  return decodeCompensation(failed)
})

function prepareActions(planId: string, input: readonly ActionInput[]) {
  return Effect.gen(function* () {
    const actions = yield* Effect.forEach(input, (action, sequence) =>
      Effect.gen(function* () {
        yield* requireText(`actions[${sequence}].candidateId`, action.candidateId)
        if (
          action.predecessorSequence !== undefined &&
          (!Number.isSafeInteger(action.predecessorSequence) ||
            action.predecessorSequence < 0 ||
            action.predecessorSequence >= sequence)
        ) {
          return yield* new InputError({
            field: `actions[${sequence}].predecessorSequence`,
            reason: "must reference an earlier action",
          })
        }
        const payloadJson = CanonicalJson.stringify(action.payload)
        return {
          actionId: stableActionId(planId, action.candidateId, action.kind),
          candidateId: action.candidateId,
          sequence,
          kind: action.kind,
          predecessorSequence: action.predecessorSequence ?? null,
          payload: action.payload,
          payloadJson,
          payloadFingerprint: Hash.sha256(payloadJson),
        } as const
      }),
    )
    if (new Set(actions.map((action) => `${action.candidateId}\0${action.kind}`)).size !== actions.length) {
      return yield* new InputError({ field: "actions", reason: "candidate and kind pairs must be unique" })
    }
    return actions
  })
}

function reconstructInTransaction(
  db: Pick<DatabaseClient, "select">,
  plan: typeof LearningGovernancePlanTable.$inferSelect,
) {
  return Effect.gen(function* () {
    const actions = yield* db
      .select()
      .from(LearningGovernanceActionTable)
      .where(eq(LearningGovernanceActionTable.plan_id, plan.plan_id))
      .orderBy(asc(LearningGovernanceActionTable.sequence))
      .all()
    return { plan: decodePlan(plan), actions: actions.map(decodeAction) } satisfies Snapshot
  })
}

function failPlanAndJob(tx: Transaction, planId: string, errorCode: string, errorDetail: string, now: number) {
  return Effect.gen(function* () {
    const plan = yield* tx
      .select()
      .from(LearningGovernancePlanTable)
      .where(eq(LearningGovernancePlanTable.plan_id, planId))
      .get()
    if (!plan) return yield* new FenceError({ id: planId, reason: "plan does not exist" })
    if (plan.state === "prepared" || plan.state === "settled") {
      yield* tx
        .update(LearningGovernancePlanTable)
        .set({
          state: "recovery_required",
          version: plan.version + 1,
          error_code: errorCode,
          error_detail: errorDetail,
          settled_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(LearningGovernancePlanTable.plan_id, planId),
            or(eq(LearningGovernancePlanTable.state, "prepared"), eq(LearningGovernancePlanTable.state, "settled")),
            eq(LearningGovernancePlanTable.version, plan.version),
          ),
        )
      const reversible = yield* reversibleActions(tx, planId)
      const existing = yield* tx
        .select({ actionId: LearningGovernanceCompensationTable.action_id })
        .from(LearningGovernanceCompensationTable)
        .where(eq(LearningGovernanceCompensationTable.plan_id, planId))
        .all()
      if (existing.length === 0) yield* insertCompensations(tx, reversible, now)
    }
    yield* failJob(tx, plan.job_id, errorCode, errorDetail, now)
  })
}

function reversibleActions(tx: Transaction, planId: string) {
  return tx
    .select()
    .from(LearningGovernanceActionTable)
    .where(
      and(
        eq(LearningGovernanceActionTable.plan_id, planId),
        or(
          eq(LearningGovernanceActionTable.state, "settled"),
          and(
            eq(LearningGovernanceActionTable.state, "recovery_required"),
            isNotNull(LearningGovernanceActionTable.result_ref),
            isNotNull(LearningGovernanceActionTable.result_hash),
            isNotNull(LearningGovernanceActionTable.result_fingerprint),
          ),
        ),
      ),
    )
    .orderBy(asc(LearningGovernanceActionTable.sequence))
    .all()
    .pipe(Effect.map((actions) => actions.reverse()))
}

function insertCompensations(
  tx: Transaction,
  actions: readonly (typeof LearningGovernanceActionTable.$inferSelect)[],
  now: number,
) {
  return Effect.forEach(actions, (action, sequence) =>
    tx.insert(LearningGovernanceCompensationTable).values({
      compensation_id: stableCompensationId(action.action_id),
      plan_id: action.plan_id,
      action_id: action.action_id,
      sequence,
      kind: action.kind === "document_stage" ? "document_quarantine" : "memory_inbox_revoke",
      source_payload_fingerprint: action.payload_fingerprint,
      state: "prepared",
      version: 0,
      created_at: now,
      updated_at: now,
    }),
  )
}

function failJob(tx: Transaction, jobId: string, errorCode: string, errorDetail: string, now: number) {
  return Effect.gen(function* () {
    const job = yield* tx.select().from(LearningJobTable).where(eq(LearningJobTable.job_id, jobId)).get()
    if (
      !job ||
      job.state !== "governance" ||
      (job.side_effect_state !== "started" && job.side_effect_state !== "settled")
    )
      return
    yield* tx
      .update(LearningJobTable)
      .set({
        state: "recovery_required",
        owner: null,
        lease_expires_at: null,
        version: job.version + 1,
        side_effect_state: "unknown",
        error_code: errorCode,
        error_detail: errorDetail,
        settled_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(LearningJobTable.job_id, jobId),
          eq(LearningJobTable.state, "governance"),
          or(eq(LearningJobTable.side_effect_state, "started"), eq(LearningJobTable.side_effect_state, "settled")),
          eq(LearningJobTable.version, job.version),
        ),
      )
  })
}

function planIdForJob(jobId: string) {
  return `learning-governance:${Hash.sha256(jobId)}`
}

function stableActionId(planId: string, candidateId: string, kind: ActionKind) {
  return `learning-governance-action:${Hash.sha256(`${planId}\0${candidateId}\0${kind}`)}`
}

function stableCompensationId(actionId: string) {
  return `learning-governance-compensation:${Hash.sha256(actionId)}`
}

function settlementFingerprint(resultRef: string, resultHash: string) {
  return Hash.sha256(CanonicalJson.stringify({ resultRef, resultHash }))
}

function lteLease(now: number) {
  return or(
    lt(LearningGovernanceActionTable.lease_expires_at, now),
    eq(LearningGovernanceActionTable.lease_expires_at, now),
  )
}

function requireText(field: string, value: string) {
  if (value.trim().length > 0) return Effect.void
  return new InputError({ field, reason: "must be non-empty" })
}

function requireVersion(field: string, value: number) {
  if (Number.isSafeInteger(value) && value >= 0) return Effect.void
  return new InputError({ field, reason: "must be a non-negative safe integer" })
}

function requireHash(field: string, value: string) {
  if (/^[0-9a-f]{64}$/.test(value)) return Effect.void
  return new InputError({ field, reason: "must be a lowercase SHA-256 hash" })
}

function parseJson(value: string) {
  return decodeJson(value).pipe(
    Option.match({
      onNone: () => value,
      onSome: (decoded) => decoded,
    }),
  )
}

function decodePlan(row: typeof LearningGovernancePlanTable.$inferSelect): PlanRecord {
  return {
    planId: row.plan_id,
    jobId: row.job_id,
    policy: row.policy,
    payload: parseJson(row.payload_json),
    payloadJson: row.payload_json,
    payloadFingerprint: row.payload_fingerprint,
    actionCount: row.action_count,
    jobOwner: row.job_owner,
    sourceJobVersion: row.source_job_version,
    jobStartedVersion: row.job_started_version,
    state: row.state,
    version: row.version,
    resultRef: row.result_ref,
    resultHash: row.result_hash,
    resultFingerprint: row.result_fingerprint,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  }
}

function decodeAction(row: typeof LearningGovernanceActionTable.$inferSelect): ActionRecord {
  return {
    actionId: row.action_id,
    planId: row.plan_id,
    candidateId: row.candidate_id,
    sequence: row.sequence,
    kind: row.kind,
    predecessorActionId: row.predecessor_action_id,
    payload: parseJson(row.payload_json),
    payloadJson: row.payload_json,
    payloadFingerprint: row.payload_fingerprint,
    state: row.state,
    owner: row.owner,
    leaseExpiresAt: row.lease_expires_at,
    version: row.version,
    resultRef: row.result_ref,
    resultHash: row.result_hash,
    resultFingerprint: row.result_fingerprint,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  }
}

function decodeCompensation(row: typeof LearningGovernanceCompensationTable.$inferSelect): CompensationRecord {
  return {
    compensationId: row.compensation_id,
    planId: row.plan_id,
    actionId: row.action_id,
    sequence: row.sequence,
    kind: row.kind,
    sourcePayloadFingerprint: row.source_payload_fingerprint,
    state: row.state,
    owner: row.owner,
    leaseExpiresAt: row.lease_expires_at,
    version: row.version,
    resultRef: row.result_ref,
    resultHash: row.result_hash,
    resultFingerprint: row.result_fingerprint,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  }
}
