import { Database } from "@deepagent-code/core/database/database"
import { Hash } from "@deepagent-code/core/util/hash"
import {
  MessageTable,
  PartTable,
  SessionIntentTable,
  SessionSteerTable,
  SessionTable,
} from "@deepagent-code/core/session/sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { and, eq, max, sql } from "drizzle-orm"
import { Data, Effect, Types } from "effect"
import { randomUUID } from "node:crypto"
import { MessageID, SessionID } from "./schema"
import { SessionMutationEpoch } from "./mutation-epoch"
import {
  SessionActivityAdmissionTable,
  SessionActivityProgressTable,
  SessionLegacyActivityAdmissionTable,
  SessionLegacyActivityTable,
} from "./activity-sql"
import { SessionToolRequestReceiptTable } from "./tool-request-receipt.sql"
import { SessionActivityOwner } from "./activity-owner"

export type Source = "composer" | "intelligence" | "followup" | "rewrite"
export type Variant = "original" | "rewritten"
export type Delivery = "turn" | "steer" | "queue" | "goal_steer"

export class Conflict extends Data.TaggedError("SessionPromptIntent.Conflict")<{
  readonly intentID: string
  readonly reason: string
}> {}

export class InProgress extends Data.TaggedError("SessionPromptIntent.InProgress")<{
  readonly intentID: string
}> {}

export type Error = Conflict | InProgress | SessionMutationEpoch.Stale

export type Receipt = {
  readonly intentID: string
  readonly sessionID: SessionID
  readonly source: Source
  readonly state: "preparing" | "admitting" | "admitted" | "canceled" | "superseded" | "failed"
  readonly variant?: Variant
  readonly payloadHash?: string
  readonly delivery?: Delivery
  readonly messageID?: MessageID
  readonly correlationID?: MessageID
  readonly ownerToken?: string
  readonly mutationEpoch: number
  readonly version: number
}

export type Claim =
  | {
      readonly kind: "claimed"
      readonly receipt: Receipt & {
        readonly state: "admitting"
        readonly ownerToken: string
        readonly messageID: MessageID
      }
    }
  | {
      readonly kind: "admitted"
      readonly receipt: Receipt & { readonly state: "admitted"; readonly messageID: MessageID }
    }

export type Activity = {
  readonly activityID: string
  readonly admissionID: string
  readonly sessionID: SessionID
  readonly state: "active" | "settled" | "failed" | "interrupted" | "recovery_required"
}

export type Progress = {
  readonly activityID: string
  readonly revision: number
  readonly assistantMessageID: MessageID
  readonly textPartID?: string
  readonly state: "provisional" | "progress" | "final" | "interrupted" | "recovery_required"
}

const leaseDuration = 30_000

const fromRow = (row: typeof SessionIntentTable.$inferSelect): Receipt => ({
  intentID: row.intent_id,
  sessionID: SessionID.make(row.session_id),
  source: row.source,
  state: row.state,
  ...(row.selected_variant ? { variant: row.selected_variant } : {}),
  ...(row.selected_payload_hash ? { payloadHash: row.selected_payload_hash } : {}),
  ...(row.delivery ? { delivery: row.delivery } : {}),
  ...(row.admitted_message_id ? { messageID: MessageID.make(row.admitted_message_id) } : {}),
  ...(row.correlation_id ? { correlationID: MessageID.make(row.correlation_id) } : {}),
  ...(row.owner_token ? { ownerToken: row.owner_token } : {}),
  mutationEpoch: row.mutation_epoch,
  version: row.version,
})

export const prepare = Effect.fn("SessionPromptIntent.prepare")(function* (input: {
  readonly intentID: string
  readonly sessionID: SessionID
  readonly source: Source
}) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const session = yield* tx
            .select({ mutationEpoch: SessionTable.mutation_epoch })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!session) return yield* Effect.die(`Session not found: ${input.sessionID}`)
          const now = Date.now()
          const inserted = yield* tx
            .insert(SessionIntentTable)
            .values({
              intent_id: input.intentID,
              session_id: input.sessionID,
              source: input.source,
              state: "preparing",
              mutation_epoch: session.mutationEpoch,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoNothing()
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (inserted) return fromRow(inserted)
          const existing = yield* tx
            .select()
            .from(SessionIntentTable)
            .where(eq(SessionIntentTable.intent_id, input.intentID))
            .get()
            .pipe(Effect.orDie)
          if (existing?.session_id !== input.sessionID || existing.source !== input.source)
            return yield* Effect.fail(new Conflict({ intentID: input.intentID, reason: "intent identity was reused" }))
          if (existing.mutation_epoch !== session.mutationEpoch)
            return yield* Effect.fail(
              new SessionMutationEpoch.Stale({
                sessionID: input.sessionID,
                observed: existing.mutation_epoch,
                current: session.mutationEpoch,
              }),
            )
          return fromRow(existing)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const claim = Effect.fn("SessionPromptIntent.claim")(function* (input: {
  readonly intentID: string
  readonly sessionID: SessionID
  readonly source: Source
  readonly variant: Variant
  readonly payloadHash: string
  readonly messageID: MessageID
}) {
  const { db } = yield* Database.Service
  const now = Date.now()
  const ownerToken = randomUUID()
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const session = yield* tx
            .select({ mutationEpoch: SessionTable.mutation_epoch })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!session) return yield* Effect.die(`Session not found: ${input.sessionID}`)
          const inserted = yield* tx
            .insert(SessionIntentTable)
            .values({
              intent_id: input.intentID,
              session_id: input.sessionID,
              source: input.source,
              state: "admitting",
              selected_variant: input.variant,
              selected_payload_hash: input.payloadHash,
              admitted_message_id: input.messageID,
              correlation_id: input.messageID,
              owner_token: ownerToken,
              lease_expires_at: now + leaseDuration,
              mutation_epoch: session.mutationEpoch,
              version: 1,
              time_created: now,
              time_selected: now,
              time_updated: now,
            })
            .onConflictDoNothing()
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (inserted) {
            const receipt = fromRow(inserted)
            return {
              kind: "claimed" as const,
              receipt: { ...receipt, state: "admitting" as const, ownerToken, messageID: input.messageID },
            }
          }

          const existing = yield* tx
            .select()
            .from(SessionIntentTable)
            .where(eq(SessionIntentTable.intent_id, input.intentID))
            .get()
            .pipe(Effect.orDie)
          if (!existing) return yield* Effect.die("Session prompt intent disappeared during claim")
          if (
            existing.session_id !== input.sessionID ||
            existing.source !== input.source ||
            (existing.selected_variant !== null && existing.selected_variant !== input.variant) ||
            (existing.selected_payload_hash !== null && existing.selected_payload_hash !== input.payloadHash)
          ) {
            return yield* Effect.fail(
              new Conflict({ intentID: input.intentID, reason: "intent payload or selected variant conflicts" }),
            )
          }
          if (existing.mutation_epoch !== session.mutationEpoch)
            return yield* Effect.fail(
              new SessionMutationEpoch.Stale({
                sessionID: input.sessionID,
                observed: existing.mutation_epoch,
                current: session.mutationEpoch,
              }),
            )
          if (existing.state === "canceled" || existing.state === "superseded") {
            return yield* Effect.fail(new Conflict({ intentID: input.intentID, reason: `intent is ${existing.state}` }))
          }

          const correlationID = existing.correlation_id ?? existing.admitted_message_id
          const direct = existing.admitted_message_id
            ? yield* tx
                .select({ id: MessageTable.id })
                .from(MessageTable)
                .where(
                  and(
                    eq(MessageTable.id, MessageID.make(existing.admitted_message_id)),
                    eq(MessageTable.session_id, input.sessionID),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
            : undefined
          const steer = correlationID
            ? yield* tx
                .select({ id: SessionSteerTable.id, delivery: SessionSteerTable.delivery })
                .from(SessionSteerTable)
                .where(
                  and(
                    eq(SessionSteerTable.session_id, input.sessionID),
                    eq(SessionSteerTable.correlation_id, correlationID),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
            : undefined
          if (direct || steer || existing.state === "admitted") {
            const messageID = MessageID.make(steer?.id ?? existing.admitted_message_id ?? input.messageID)
            const delivery = steer?.delivery ?? existing.delivery ?? "turn"
            const admitted = yield* tx
              .update(SessionIntentTable)
              .set({
                state: "admitted",
                delivery,
                admitted_message_id: messageID,
                owner_token: null,
                lease_expires_at: null,
                time_admitted: existing.time_admitted ?? now,
                time_updated: now,
                version: existing.version + 1,
              })
              .where(eq(SessionIntentTable.intent_id, input.intentID))
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!admitted) return yield* Effect.die("Session prompt intent disappeared during reconciliation")
            const receipt = fromRow(admitted)
            return { kind: "admitted" as const, receipt: { ...receipt, state: "admitted" as const, messageID } }
          }
          if (existing.state === "admitting" && existing.lease_expires_at !== null && existing.lease_expires_at > now) {
            return yield* Effect.fail(new InProgress({ intentID: input.intentID }))
          }

          const messageID = MessageID.make(existing.correlation_id ?? existing.admitted_message_id ?? input.messageID)
          const claimed = yield* tx
            .update(SessionIntentTable)
            .set({
              state: "admitting",
              selected_variant: input.variant,
              selected_payload_hash: input.payloadHash,
              admitted_message_id: messageID,
              correlation_id: messageID,
              owner_token: ownerToken,
              lease_expires_at: now + leaseDuration,
              time_selected: existing.time_selected ?? now,
              time_updated: now,
              version: existing.version + 1,
            })
            .where(
              and(eq(SessionIntentTable.intent_id, input.intentID), eq(SessionIntentTable.version, existing.version)),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!claimed) return yield* Effect.fail(new InProgress({ intentID: input.intentID }))
          const receipt = fromRow(claimed)
          return {
            kind: "claimed" as const,
            receipt: { ...receipt, state: "admitting" as const, ownerToken, messageID },
          }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const complete = Effect.fn("SessionPromptIntent.complete")(function* (input: {
  readonly intentID: string
  readonly ownerToken: string
  readonly messageID: MessageID
  readonly delivery: Delivery
}) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(SessionIntentTable)
            .where(eq(SessionIntentTable.intent_id, input.intentID))
            .get()
            .pipe(Effect.orDie)
          if (!existing)
            return yield* Effect.fail(new Conflict({ intentID: input.intentID, reason: "intent vanished" }))
          const session = yield* tx
            .select({ mutationEpoch: SessionTable.mutation_epoch })
            .from(SessionTable)
            .where(eq(SessionTable.id, existing.session_id))
            .get()
            .pipe(Effect.orDie)
          if (!session) return yield* Effect.die(`Session not found: ${existing.session_id}`)
          if (existing.mutation_epoch !== session.mutationEpoch)
            return yield* Effect.fail(
              new SessionMutationEpoch.Stale({
                sessionID: SessionID.make(existing.session_id),
                observed: existing.mutation_epoch,
                current: session.mutationEpoch,
              }),
            )
          if (
            existing.state === "admitted" &&
            existing.delivery === input.delivery &&
            existing.admitted_message_id === input.messageID
          )
            return fromRow(existing)
          const now = Date.now()
          const updated = yield* tx
            .update(SessionIntentTable)
            .set({
              state: "admitted",
              delivery: input.delivery,
              admitted_message_id: input.messageID,
              owner_token: null,
              lease_expires_at: null,
              time_admitted: now,
              time_updated: now,
              version: sql`${SessionIntentTable.version} + 1`,
            })
            .where(
              and(
                eq(SessionIntentTable.intent_id, input.intentID),
                eq(SessionIntentTable.state, "admitting"),
                eq(SessionIntentTable.owner_token, input.ownerToken),
                eq(SessionIntentTable.mutation_epoch, session.mutationEpoch),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (updated) return fromRow(updated)
          return yield* Effect.fail(
            new Conflict({ intentID: input.intentID, reason: "intent admission ownership was lost" }),
          )
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

const messageData = (info: SessionV1.User): typeof MessageTable.$inferInsert.data => {
  const { id: _, sessionID: __, ...data } = info
  return data as Types.DeepMutable<typeof data>
}

const partData = (part: SessionV1.Part): typeof PartTable.$inferInsert.data => {
  const { id: _, messageID: __, sessionID: ___, ...data } = part
  return data as Types.DeepMutable<typeof data>
}

export const materializeTurn = Effect.fn("SessionPromptIntent.materializeTurn")(function* (input: {
  readonly receipt: Receipt & {
    readonly state: "admitting"
    readonly ownerToken: string
    readonly messageID: MessageID
  }
  readonly message: { readonly info: SessionV1.User; readonly parts: ReadonlyArray<SessionV1.Part> }
}) {
  const { db } = yield* Database.Service
  if (input.message.info.id !== input.receipt.messageID || input.message.info.sessionID !== input.receipt.sessionID)
    return yield* Effect.fail(
      new Conflict({ intentID: input.receipt.intentID, reason: "materialized message does not match intent identity" }),
    )
  if (
    input.message.parts.some(
      (part) => part.messageID !== input.message.info.id || part.sessionID !== input.receipt.sessionID,
    )
  )
    return yield* Effect.fail(
      new Conflict({ intentID: input.receipt.intentID, reason: "materialized parts do not match intent identity" }),
    )
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const session = yield* tx
            .select({ mutationEpoch: SessionTable.mutation_epoch })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.receipt.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!session) return yield* Effect.die(`Session not found: ${input.receipt.sessionID}`)
          if (session.mutationEpoch !== input.receipt.mutationEpoch)
            return yield* Effect.fail(
              new SessionMutationEpoch.Stale({
                sessionID: input.receipt.sessionID,
                observed: input.receipt.mutationEpoch,
                current: session.mutationEpoch,
              }),
            )
          const intent = yield* tx
            .select()
            .from(SessionIntentTable)
            .where(eq(SessionIntentTable.intent_id, input.receipt.intentID))
            .get()
            .pipe(Effect.orDie)
          if (
            !intent ||
            intent.state !== "admitting" ||
            intent.owner_token !== input.receipt.ownerToken ||
            intent.mutation_epoch !== session.mutationEpoch
          )
            return yield* Effect.fail(
              new Conflict({ intentID: input.receipt.intentID, reason: "intent admission ownership was lost" }),
            )
          const storedMessage = yield* tx
            .select()
            .from(MessageTable)
            .where(eq(MessageTable.id, input.message.info.id))
            .get()
            .pipe(Effect.orDie)
          const data = messageData(input.message.info)
          if (
            storedMessage &&
            (storedMessage.session_id !== input.receipt.sessionID ||
              JSON.stringify(storedMessage.data) !== JSON.stringify(data))
          )
            return yield* Effect.fail(
              new Conflict({ intentID: input.receipt.intentID, reason: "message ID conflicts with persisted content" }),
            )
          if (!storedMessage)
            yield* tx
              .insert(MessageTable)
              .values({
                id: input.message.info.id,
                session_id: input.message.info.sessionID,
                time_created: input.message.info.time.created,
                data,
              })
              .run()
              .pipe(Effect.orDie)
          yield* Effect.forEach(input.message.parts, (part) =>
            Effect.gen(function* () {
              const stored = yield* tx
                .select()
                .from(PartTable)
                .where(eq(PartTable.id, part.id))
                .get()
                .pipe(Effect.orDie)
              const data = partData(part)
              if (
                stored &&
                (stored.message_id !== part.messageID ||
                  stored.session_id !== part.sessionID ||
                  JSON.stringify(stored.data) !== JSON.stringify(data))
              )
                return yield* Effect.fail(
                  new Conflict({
                    intentID: input.receipt.intentID,
                    reason: "part ID conflicts with persisted content",
                  }),
                )
              if (!stored)
                yield* tx
                  .insert(PartTable)
                  .values({
                    id: part.id,
                    message_id: part.messageID,
                    session_id: part.sessionID,
                    time_created: input.message.info.time.created,
                    data,
                  })
                  .run()
                  .pipe(Effect.orDie)
            }),
          )
          const now = Date.now()
          const admitted = yield* tx
            .update(SessionIntentTable)
            .set({
              state: "admitted",
              delivery: "turn",
              admitted_message_id: input.message.info.id,
              owner_token: null,
              lease_expires_at: null,
              time_admitted: now,
              time_updated: now,
              version: intent.version + 1,
            })
            .where(
              and(
                eq(SessionIntentTable.intent_id, input.receipt.intentID),
                eq(SessionIntentTable.version, intent.version),
                eq(SessionIntentTable.owner_token, input.receipt.ownerToken),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!admitted)
            return yield* Effect.fail(
              new Conflict({ intentID: input.receipt.intentID, reason: "intent admission ownership was lost" }),
            )
          if (!intent.selected_payload_hash)
            return yield* Effect.fail(
              new Conflict({ intentID: input.receipt.intentID, reason: "intent payload fingerprint is missing" }),
            )
          const admissionID = Hash.sha256(`session-activity-admission:v1:legacy:${intent.intent_id}`)
          yield* tx
            .insert(SessionActivityAdmissionTable)
            .values({
              admission_id: admissionID,
              session_id: input.receipt.sessionID,
              source_kind: "legacy_intent",
              legacy_intent_id: intent.intent_id,
              admitted_message_id: input.message.info.id,
              delivery: "turn",
              payload_fingerprint_kind: "payload_hash",
              payload_fingerprint: intent.selected_payload_hash,
              created_at: intent.time_created,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          const admission = yield* tx
            .select()
            .from(SessionActivityAdmissionTable)
            .where(eq(SessionActivityAdmissionTable.legacy_intent_id, intent.intent_id))
            .get()
            .pipe(Effect.orDie)
          if (
            !admission ||
            admission.session_id !== input.receipt.sessionID ||
            admission.admitted_message_id !== input.message.info.id ||
            admission.delivery !== "turn" ||
            admission.payload_fingerprint_kind !== "payload_hash" ||
            admission.payload_fingerprint !== intent.selected_payload_hash
          )
            return yield* Effect.fail(
              new Conflict({ intentID: input.receipt.intentID, reason: "activity admission identity conflicts" }),
            )
          const existingActivity = yield* tx
            .select()
            .from(SessionLegacyActivityTable)
            .where(eq(SessionLegacyActivityTable.trigger_admission_id, admissionID))
            .get()
            .pipe(Effect.orDie)
          const activityID = existingActivity?.activity_id ?? Hash.sha256(`session-legacy-activity:v1:${admissionID}`)
          if (!existingActivity) {
            const active = yield* tx
              .select()
              .from(SessionLegacyActivityTable)
              .where(
                and(
                  eq(SessionLegacyActivityTable.session_id, input.receipt.sessionID),
                  eq(SessionLegacyActivityTable.state, "active"),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (active)
              return yield* Effect.fail(
                new Conflict({
                  intentID: input.receipt.intentID,
                  reason: `legacy activity ${active.activity_id} requires recovery before a new turn`,
                }),
              )
            const latest = yield* tx
              .select({ ordinal: max(SessionLegacyActivityTable.ordinal) })
              .from(SessionLegacyActivityTable)
              .where(eq(SessionLegacyActivityTable.session_id, input.receipt.sessionID))
              .get()
              .pipe(Effect.orDie)
            yield* tx
              .insert(SessionLegacyActivityTable)
              .values({
                activity_id: activityID,
                session_id: input.receipt.sessionID,
                ordinal: (latest?.ordinal ?? -1) + 1,
                trigger_admission_id: admissionID,
                owner_token: SessionActivityOwner.processOwnerToken,
                state: "active",
                terminal_reason: null,
                created_at: now,
                settled_at: null,
              })
              .run()
              .pipe(Effect.orDie)
          }
          yield* tx
            .insert(SessionLegacyActivityAdmissionTable)
            .values({
              activity_id: activityID,
              admission_id: admissionID,
              ordinal: 0,
              role: "trigger",
              attached_at: now,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          const membership = yield* tx
            .select()
            .from(SessionLegacyActivityAdmissionTable)
            .where(eq(SessionLegacyActivityAdmissionTable.admission_id, admissionID))
            .get()
            .pipe(Effect.orDie)
          if (membership?.activity_id !== activityID || membership.ordinal !== 0 || membership.role !== "trigger")
            return yield* Effect.fail(
              new Conflict({ intentID: input.receipt.intentID, reason: "activity trigger membership conflicts" }),
            )
          return fromRow(admitted)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const activityForMessage = Effect.fn("SessionPromptIntent.activityForMessage")(function* (input: {
  readonly sessionID: SessionID
  readonly messageID: MessageID
}) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({
      activityID: SessionLegacyActivityTable.activity_id,
      admissionID: SessionLegacyActivityAdmissionTable.admission_id,
      sessionID: SessionLegacyActivityTable.session_id,
      state: SessionLegacyActivityTable.state,
    })
    .from(SessionLegacyActivityTable)
    .innerJoin(
      SessionLegacyActivityAdmissionTable,
      eq(SessionLegacyActivityAdmissionTable.activity_id, SessionLegacyActivityTable.activity_id),
    )
    .innerJoin(
      SessionActivityAdmissionTable,
      eq(SessionActivityAdmissionTable.admission_id, SessionLegacyActivityAdmissionTable.admission_id),
    )
    .where(
      and(
        eq(SessionLegacyActivityTable.session_id, input.sessionID),
        eq(SessionActivityAdmissionTable.admitted_message_id, input.messageID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  return {
    activityID: row.activityID,
    admissionID: row.admissionID,
    sessionID: SessionID.make(row.sessionID),
    state: row.state,
  } satisfies Activity
})

export const beginProgress = Effect.fn("SessionPromptIntent.beginProgress")(function* (input: {
  readonly activityID: string
  readonly assistantMessageID: MessageID
  readonly providerReceiptID: string
}) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(SessionActivityProgressTable)
            .where(eq(SessionActivityProgressTable.assistant_message_id, input.assistantMessageID))
            .get()
          if (existing) {
            if (existing.activity_id !== input.activityID || existing.provider_receipt_id !== input.providerReceiptID)
              return yield* Effect.die(new Error(`activity progress identity conflicts: ${input.assistantMessageID}`))
            return progress(existing)
          }
          const activity = yield* tx
            .select()
            .from(SessionLegacyActivityTable)
            .where(eq(SessionLegacyActivityTable.activity_id, input.activityID))
            .get()
          if (!activity || activity.state !== "active")
            return yield* Effect.die(new Error(`legacy activity is not active: ${input.activityID}`))
          const latest = yield* tx
            .select({ revision: max(SessionActivityProgressTable.revision) })
            .from(SessionActivityProgressTable)
            .where(eq(SessionActivityProgressTable.activity_id, input.activityID))
            .get()
          const row = {
            activity_id: input.activityID,
            revision: (latest?.revision ?? -1) + 1,
            assistant_message_id: input.assistantMessageID,
            text_part_id: null,
            provider_receipt_id: input.providerReceiptID,
            state: "provisional" as const,
            finish_observed: null,
            response_fingerprint: null,
            created_at: Date.now(),
            settled_at: null,
          }
          yield* tx.insert(SessionActivityProgressTable).values(row).run()
          return progress(row)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export const settleProgress = Effect.fn("SessionPromptIntent.settleProgress")(function* (input: {
  readonly activityID: string
  readonly assistantMessageID: MessageID
}) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select()
            .from(SessionActivityProgressTable)
            .where(eq(SessionActivityProgressTable.assistant_message_id, input.assistantMessageID))
            .get()
          if (!current || current.activity_id !== input.activityID)
            return yield* Effect.die(new Error(`activity progress is missing: ${input.assistantMessageID}`))
          if (current.state !== "provisional") return progress(current)
          const receipt = yield* tx
            .select()
            .from(SessionToolRequestReceiptTable)
            .where(eq(SessionToolRequestReceiptTable.receipt_id, current.provider_receipt_id))
            .get()
          if (!receipt)
            return yield* Effect.die(new Error(`provider receipt is missing: ${current.provider_receipt_id}`))
          if (!["settled", "failed", "indeterminate_after_crash"].includes(receipt.provider_state))
            return yield* Effect.die(
              new Error(`provider receipt is not terminal: ${current.provider_receipt_id}: ${receipt.provider_state}`),
            )
          const assistant = yield* tx
            .select()
            .from(MessageTable)
            .where(eq(MessageTable.id, input.assistantMessageID))
            .get()
          if (!assistant || assistant.session_id !== receipt.session_id || assistant.data.role !== "assistant")
            return yield* Effect.die(new Error(`assistant response ownership mismatch: ${input.assistantMessageID}`))
          const assistantData = assistant.data as Omit<SessionV1.Assistant, "id" | "sessionID">
          const currentAdmission = yield* tx
            .select({ ordinal: SessionLegacyActivityAdmissionTable.ordinal })
            .from(SessionLegacyActivityAdmissionTable)
            .innerJoin(
              SessionActivityAdmissionTable,
              eq(SessionActivityAdmissionTable.admission_id, SessionLegacyActivityAdmissionTable.admission_id),
            )
            .where(
              and(
                eq(SessionLegacyActivityAdmissionTable.activity_id, input.activityID),
                eq(SessionActivityAdmissionTable.admitted_message_id, assistantData.parentID),
              ),
            )
            .get()
          const latestAdmission = yield* tx
            .select({ ordinal: max(SessionLegacyActivityAdmissionTable.ordinal) })
            .from(SessionLegacyActivityAdmissionTable)
            .where(eq(SessionLegacyActivityAdmissionTable.activity_id, input.activityID))
            .get()
          const pendingAdmission =
            currentAdmission && typeof latestAdmission?.ordinal === "number"
              ? currentAdmission.ordinal < latestAdmission.ordinal
              : false
          const parts = yield* tx
            .select()
            .from(PartTable)
            .where(
              and(
                eq(PartTable.message_id, input.assistantMessageID),
                eq(PartTable.session_id, SessionID.make(receipt.session_id)),
              ),
            )
            .all()
          const textParts = parts.filter((part) => part.data.type === "text")
          const text = textParts.findLast((part) => {
            if (part.data.type !== "text") return false
            return (part.data as Omit<SessionV1.TextPart, "id" | "sessionID" | "messageID">).text.trim() !== ""
          })
          const hasToolCalls = parts.some((part) => {
            if (part.data.type !== "tool") return false
            const data = part.data as Omit<SessionV1.ToolPart, "id" | "sessionID" | "messageID">
            if (data.metadata?.providerExecuted) return false
            return !(data.state.status === "error" && data.state.metadata?.interrupted === true)
          })
          const state =
            receipt.provider_state === "indeterminate_after_crash"
              ? "recovery_required"
              : receipt.provider_state === "failed"
                ? receipt.request_error_code === "AbortError"
                  ? "interrupted"
                  : "recovery_required"
                : !assistantData.time.completed || !assistantData.finish
                  ? "recovery_required"
                  : assistantData.finish === "tool-calls" ||
                      assistantData.finish === "length" ||
                      hasToolCalls ||
                      pendingAdmission
                    ? "progress"
                    : "final"
          const now = Date.now()
          const updated = yield* tx
            .update(SessionActivityProgressTable)
            .set({
              text_part_id: text?.id ?? null,
              state,
              finish_observed: assistantData.finish ?? receipt.request_error_code ?? null,
              response_fingerprint: receipt.response_fingerprint,
              settled_at: now,
            })
            .where(
              and(
                eq(SessionActivityProgressTable.activity_id, input.activityID),
                eq(SessionActivityProgressTable.revision, current.revision),
                eq(SessionActivityProgressTable.state, "provisional"),
              ),
            )
            .returning()
            .get()
          if (!updated)
            return yield* Effect.die(new Error(`activity progress settlement CAS lost: ${input.activityID}`))
          yield* Effect.forEach(
            textParts,
            (part) => {
              const data = part.data as Omit<SessionV1.TextPart, "id" | "sessionID" | "messageID">
              return tx
                .update(PartTable)
                .set({
                  data: {
                    ...data,
                    metadata: {
                      ...(data.metadata ?? {}),
                      deepagent_activity_progress: {
                        activity_id: input.activityID,
                        revision: current.revision,
                        state,
                      },
                    },
                  } as typeof PartTable.$inferInsert.data,
                })
                .where(
                  and(
                    eq(PartTable.id, part.id),
                    eq(PartTable.message_id, input.assistantMessageID),
                    eq(PartTable.session_id, SessionID.make(receipt.session_id)),
                  ),
                )
                .run()
            },
            { discard: true },
          )
          if (state !== "progress") {
            const activityState =
              state === "final" ? "settled" : state === "interrupted" ? "interrupted" : "recovery_required"
            const terminal = yield* tx
              .update(SessionLegacyActivityTable)
              .set({
                state: activityState,
                terminal_reason: assistantData.finish ?? receipt.request_error_code ?? state,
                settled_at: now,
              })
              .where(
                and(
                  eq(SessionLegacyActivityTable.activity_id, input.activityID),
                  eq(SessionLegacyActivityTable.state, "active"),
                ),
              )
              .returning({ activityID: SessionLegacyActivityTable.activity_id })
              .get()
            if (!terminal)
              return yield* Effect.die(new Error(`legacy activity settlement CAS lost: ${input.activityID}`))
          }
          return progress(updated)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export const recoverActiveActivities = Effect.fn("SessionPromptIntent.recoverActiveActivities")(function* (
  ownerToken = SessionActivityOwner.processOwnerToken,
) {
  const { db } = yield* Database.Service
  const active = yield* db
    .select({ activityID: SessionLegacyActivityTable.activity_id })
    .from(SessionLegacyActivityTable)
    .where(
      and(
        eq(SessionLegacyActivityTable.state, "active"),
        sql`${SessionLegacyActivityTable.owner_token} != ${ownerToken}`,
      ),
    )
    .all()
    .pipe(Effect.orDie)
  yield* Effect.forEach(
    active,
    (activity) =>
      Effect.gen(function* () {
        const latest = yield* db
          .select()
          .from(SessionActivityProgressTable)
          .where(eq(SessionActivityProgressTable.activity_id, activity.activityID))
          .orderBy(sql`${SessionActivityProgressTable.revision} DESC`)
          .get()
          .pipe(Effect.orDie)
        const receipt = latest
          ? yield* db
              .select({ state: SessionToolRequestReceiptTable.provider_state })
              .from(SessionToolRequestReceiptTable)
              .where(eq(SessionToolRequestReceiptTable.receipt_id, latest.provider_receipt_id))
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (
          latest?.state === "provisional" &&
          receipt &&
          ["settled", "failed", "indeterminate_after_crash"].includes(receipt.state)
        ) {
          yield* settleProgress({
            activityID: activity.activityID,
            assistantMessageID: MessageID.make(latest.assistant_message_id),
          })
          return
        }
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const now = Date.now()
                yield* tx
                  .update(SessionLegacyActivityTable)
                  .set({
                    state: "recovery_required",
                    terminal_reason: latest
                      ? `process restarted after activity progress ${latest.state}`
                      : "process restarted before provider progress admission",
                    settled_at: now,
                  })
                  .where(
                    and(
                      eq(SessionLegacyActivityTable.activity_id, activity.activityID),
                      eq(SessionLegacyActivityTable.state, "active"),
                    ),
                  )
                  .run()
                if (latest?.state === "provisional")
                  yield* tx
                    .update(SessionActivityProgressTable)
                    .set({ state: "recovery_required", finish_observed: "process_restart", settled_at: now })
                    .where(
                      and(
                        eq(SessionActivityProgressTable.activity_id, activity.activityID),
                        eq(SessionActivityProgressTable.revision, latest.revision),
                        eq(SessionActivityProgressTable.state, "provisional"),
                      ),
                    )
                    .run()
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
    { discard: true },
  )
  return active.length
})

export const interruptActivity = Effect.fn("SessionPromptIntent.interruptActivity")(function* (activityID: string) {
  const { db } = yield* Database.Service
  yield* db
    .update(SessionLegacyActivityTable)
    .set({ state: "interrupted", terminal_reason: "aborted_before_provider_settlement", settled_at: Date.now() })
    .where(and(eq(SessionLegacyActivityTable.activity_id, activityID), eq(SessionLegacyActivityTable.state, "active")))
    .run()
    .pipe(Effect.orDie)
})

export const retireDisabledSteerActivity = Effect.fn("SessionPromptIntent.retireDisabledSteerActivity")(function* (
  sessionID: SessionID,
) {
  const { db } = yield* Database.Service
  const activity = yield* db
    .select({ activityID: SessionLegacyActivityTable.activity_id })
    .from(SessionLegacyActivityTable)
    .innerJoin(
      SessionActivityAdmissionTable,
      eq(SessionActivityAdmissionTable.admission_id, SessionLegacyActivityTable.trigger_admission_id),
    )
    .where(
      and(
        eq(SessionLegacyActivityTable.session_id, sessionID),
        eq(SessionLegacyActivityTable.state, "active"),
        eq(SessionActivityAdmissionTable.delivery, "steer"),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!activity) return false
  yield* db
    .update(SessionLegacyActivityTable)
    .set({
      state: "interrupted",
      terminal_reason: "steering_disabled_before_absorption",
      settled_at: Date.now(),
    })
    .where(
      and(
        eq(SessionLegacyActivityTable.activity_id, activity.activityID),
        eq(SessionLegacyActivityTable.state, "active"),
      ),
    )
    .run()
    .pipe(Effect.orDie)
  return true
})

const progress = (row: typeof SessionActivityProgressTable.$inferSelect): Progress => ({
  activityID: row.activity_id,
  revision: row.revision,
  assistantMessageID: MessageID.make(row.assistant_message_id),
  ...(row.text_part_id ? { textPartID: row.text_part_id } : {}),
  state: row.state,
})

export const renew = Effect.fn("SessionPromptIntent.renew")(function* (input: {
  readonly intentID: string
  readonly ownerToken: string
}) {
  const { db } = yield* Database.Service
  const updated = yield* db
    .update(SessionIntentTable)
    .set({ lease_expires_at: Date.now() + leaseDuration, time_updated: Date.now() })
    .where(
      and(
        eq(SessionIntentTable.intent_id, input.intentID),
        eq(SessionIntentTable.state, "admitting"),
        eq(SessionIntentTable.owner_token, input.ownerToken),
      ),
    )
    .returning({ intentID: SessionIntentTable.intent_id })
    .get()
    .pipe(Effect.orDie)
  return updated !== undefined
})

export const fail = Effect.fn("SessionPromptIntent.fail")(function* (input: {
  readonly intentID: string
  readonly ownerToken: string
}) {
  const { db } = yield* Database.Service
  yield* db
    .update(SessionIntentTable)
    .set({
      state: "failed",
      owner_token: null,
      lease_expires_at: null,
      time_updated: Date.now(),
      version: sql`${SessionIntentTable.version} + 1`,
    })
    .where(
      and(
        eq(SessionIntentTable.intent_id, input.intentID),
        eq(SessionIntentTable.state, "admitting"),
        eq(SessionIntentTable.owner_token, input.ownerToken),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

export * as SessionPromptIntent from "./prompt-intent"
