export * as DeepAgentLearningAdmissionOutbox from "./learning-admission-outbox"

import { and, asc, eq, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { LearningAdmissionOutboxTable } from "./learning-admission-outbox.sql"

type DatabaseClient = Database.Interface["db"]

export type State = "pending" | "admitted" | "rejected"

export type Record = {
  readonly intentId: string
  readonly sessionId: string
  readonly runId: string
  readonly trigger: "idle" | "pause" | "project_switch" | "session_finalization"
  readonly dedupeKey: string
  readonly payloadJson: string
  readonly payloadFingerprint: string
  readonly state: State
  readonly jobId: string | null
  readonly candidateInputRef: string | null
  readonly rejectionCode: string | null
  readonly rejectionDetail: string | null
  readonly createdAt: number
  readonly settledAt: number | null
  readonly updatedAt: number
}

export type RecordInput = {
  readonly sessionId: string
  readonly runId: string
  readonly trigger: Record["trigger"]
  readonly dedupeKey: string
  readonly payload: unknown
  readonly now?: number
}

export class IdentityConflictError extends Schema.TaggedErrorClass<IdentityConflictError>()(
  "DeepAgentLearningAdmissionOutbox.IdentityConflictError",
  { dedupeKey: Schema.String },
) {}

export class FenceError extends Schema.TaggedErrorClass<FenceError>()("DeepAgentLearningAdmissionOutbox.FenceError", {
  intentId: Schema.String,
  reason: Schema.String,
}) {}

export const record = Effect.fn("DeepAgentLearningAdmissionOutbox.record")(function* (
  db: DatabaseClient,
  input: RecordInput,
) {
  const payloadJson = CanonicalJson.stringify(input.payload)
  const payloadFingerprint = Hash.sha256(payloadJson)
  const intentId = stableIntentId(input.dedupeKey)
  const now = input.now ?? Date.now()

  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select()
          .from(LearningAdmissionOutboxTable)
          .where(
            or(
              eq(LearningAdmissionOutboxTable.intent_id, intentId),
              eq(LearningAdmissionOutboxTable.dedupe_key, input.dedupeKey),
            ),
          )
          .get()
        if (existing) {
          if (existing.dedupe_key !== input.dedupeKey || existing.payload_fingerprint !== payloadFingerprint) {
            return yield* new IdentityConflictError({ dedupeKey: input.dedupeKey })
          }
          return { created: false, intent: decode(existing) } as const
        }
        const inserted = yield* tx
          .insert(LearningAdmissionOutboxTable)
          .values({
            intent_id: intentId,
            session_id: input.sessionId,
            run_id: input.runId,
            trigger: input.trigger,
            dedupe_key: input.dedupeKey,
            payload_json: payloadJson,
            payload_fingerprint: payloadFingerprint,
            state: "pending",
            job_id: null,
            candidate_input_ref: null,
            rejection_code: null,
            rejection_detail: null,
            created_at: now,
            settled_at: null,
            updated_at: now,
          })
          .returning()
          .get()
        return { created: true, intent: decode(inserted) } as const
      }),
    { behavior: "immediate" },
  )
})

export const pending = Effect.fn("DeepAgentLearningAdmissionOutbox.pending")(function* (
  db: DatabaseClient,
  input?: { readonly limit?: number },
) {
  const limit = input?.limit ?? 128
  return (yield* db
    .select()
    .from(LearningAdmissionOutboxTable)
    .where(eq(LearningAdmissionOutboxTable.state, "pending"))
    .orderBy(asc(LearningAdmissionOutboxTable.created_at))
    .limit(limit)).map(decode)
})

export const get = Effect.fn("DeepAgentLearningAdmissionOutbox.get")(function* (db: DatabaseClient, intentId: string) {
  const row = yield* db
    .select()
    .from(LearningAdmissionOutboxTable)
    .where(eq(LearningAdmissionOutboxTable.intent_id, intentId))
    .get()
  return row ? decode(row) : undefined
})

export const admit = Effect.fn("DeepAgentLearningAdmissionOutbox.admit")(function* (
  db: DatabaseClient,
  input: {
    readonly intentId: string
    readonly payloadFingerprint: string
    readonly jobId: string
    readonly candidateInputRef: string
    readonly now?: number
  },
) {
  const now = input.now ?? Date.now()
  const updated = yield* db
    .update(LearningAdmissionOutboxTable)
    .set({
      state: "admitted",
      job_id: input.jobId,
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
  if (updated) return decode(updated)
  const current = yield* get(db, input.intentId)
  if (
    current?.state === "admitted" &&
    current.payloadFingerprint === input.payloadFingerprint &&
    current.jobId === input.jobId &&
    current.candidateInputRef === input.candidateInputRef
  ) {
    return current
  }
  return yield* new FenceError({ intentId: input.intentId, reason: "admission settlement lost its pending fence" })
})

export const reject = Effect.fn("DeepAgentLearningAdmissionOutbox.reject")(function* (
  db: DatabaseClient,
  input: {
    readonly intentId: string
    readonly payloadFingerprint: string
    readonly code: string
    readonly detail: string
    readonly now?: number
  },
) {
  const now = input.now ?? Date.now()
  const updated = yield* db
    .update(LearningAdmissionOutboxTable)
    .set({
      state: "rejected",
      rejection_code: input.code,
      rejection_detail: input.detail,
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
  if (updated) return decode(updated)
  const current = yield* get(db, input.intentId)
  if (
    current?.state === "rejected" &&
    current.payloadFingerprint === input.payloadFingerprint &&
    current.rejectionCode === input.code &&
    current.rejectionDetail === input.detail
  ) {
    return current
  }
  return yield* new FenceError({ intentId: input.intentId, reason: "rejection settlement lost its pending fence" })
})

function stableIntentId(dedupeKey: string) {
  return `learning-admission:${Hash.sha256(dedupeKey)}`
}

function decode(row: typeof LearningAdmissionOutboxTable.$inferSelect): Record {
  return {
    intentId: row.intent_id,
    sessionId: row.session_id,
    runId: row.run_id,
    trigger: row.trigger,
    dedupeKey: row.dedupe_key,
    payloadJson: row.payload_json,
    payloadFingerprint: row.payload_fingerprint,
    state: row.state,
    jobId: row.job_id,
    candidateInputRef: row.candidate_input_ref,
    rejectionCode: row.rejection_code,
    rejectionDetail: row.rejection_detail,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  }
}
