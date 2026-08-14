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
import { and, asc, eq, inArray, isNull, lte, max, sql } from "drizzle-orm"
import { Data, Effect, Types } from "effect"
import { randomUUID } from "node:crypto"
import { MessageID, SessionID } from "./schema"
import { SessionMutationEpoch } from "./mutation-epoch"
import {
  SessionActivityAdmissionTable,
  SessionActivityProgressTable,
  SessionLegacyActivityAdmissionTable,
  SessionLegacyActivityRunTable,
  SessionLegacyActivityTable,
  SessionLegacyActivityTerminalTable,
} from "./activity-sql"
import { SessionActivityObjectiveTable } from "@deepagent-code/core/deepagent/activity-authority.sql"
import { SessionToolRequestReceiptTable } from "./tool-request-receipt.sql"
import { SessionActivityOwner } from "./activity-owner"
import { pause as pauseAtActivityCrashPoint } from "./activity-crash-test"

export type Source = "composer" | "intelligence" | "followup" | "rewrite"
export type Variant = "original" | "rewritten"
export type Delivery = "turn" | "steer" | "queue" | "goal_steer"
export type ExecutionMode = "run_now" | "deferred"
export type ActivityTerminalState = "settled" | "failed" | "interrupted" | "recovery_required"
export type ActivityTerminalSource =
  | "provider_final"
  | "host_stop"
  | "cancel"
  | "compaction"
  | "restart_recovery"
  | "same_process_recovery"
  | "migration_repair"
  | "migration_backfill"

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
  readonly executionMode?: "legacy" | ExecutionMode
  readonly executionState?: "legacy" | "pending" | "claimed" | "absorbed" | "canceled"
  readonly executionClaimID?: string
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

export type RunIdentity = {
  readonly runID: string
  readonly activityID: string
  readonly sessionID: SessionID
  readonly mutationEpoch: number
  readonly generation: number
  readonly ownerToken: string
}

export type ProviderInputBoundary = RunIdentity & {
  readonly membershipOrdinal: number
}

export type ProviderInputBoundaryResult =
  | { readonly kind: "ready"; readonly boundary: ProviderInputBoundary }
  | { readonly kind: "pending_steer" }

export type MaterializedTurn = Receipt & {
  readonly state: "admitted"
  readonly messageID: MessageID
  readonly admissionID: string
  readonly executionMode: ExecutionMode
  readonly run?: RunIdentity
}

export type ActivityTerminalDecision = {
  readonly state: ActivityTerminalState
  readonly reasonCode: string
  readonly source: Exclude<ActivityTerminalSource, "migration_backfill">
  readonly operationID: string
  readonly ownerToken: string
}

export type FinalizeResult =
  | { readonly kind: "terminal_committed"; readonly invalidation: ProjectionInvalidation }
  | { readonly kind: "exact_replay"; readonly invalidation: ProjectionInvalidation }
  | { readonly kind: "follow_up_required"; readonly membershipOrdinal: number }

export type Progress = {
  readonly activityID: string
  readonly revision: number
  readonly assistantMessageID: MessageID
  readonly textPartID?: string
  readonly state: "provisional" | "progress" | "final" | "interrupted" | "recovery_required"
}

export type ProjectionInvalidation = {
  readonly activityID: string
  readonly sessionID: SessionID
  readonly assistantMessageID?: MessageID
}

const leaseDuration = 30_000
type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

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
  executionMode: row.execution_mode,
  executionState: row.execution_state,
  ...(row.execution_claim_id ? { executionClaimID: row.execution_claim_id } : {}),
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
  readonly executionMode?: ExecutionMode
}) {
  const { db } = yield* Database.Service
  const now = Date.now()
  const ownerToken = `${SessionActivityOwner.processOwnerToken}:${randomUUID()}`
  const executionMode = input.executionMode ?? "run_now"
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
              execution_mode: executionMode,
              execution_state: "pending",
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
            (existing.selected_payload_hash !== null && existing.selected_payload_hash !== input.payloadHash) ||
            (existing.execution_mode !== "legacy" && existing.execution_mode !== executionMode)
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
          if (
            existing.state === "admitting" &&
            existing.lease_expires_at !== null &&
            existing.lease_expires_at > now &&
            claimOwnerMayStillBeAlive(existing.owner_token)
          ) {
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
              execution_mode: executionMode,
              execution_state: "pending",
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

function claimOwnerMayStillBeAlive(ownerToken: string | null) {
  if (!ownerToken) return true
  const [pid, processToken, claimToken, ...rest] = ownerToken.split(":")
  if (
    rest.length > 0 ||
    !/^\d+$/.test(pid) ||
    !/^[0-9a-f-]{36}$/.test(processToken) ||
    !/^[0-9a-f-]{36}$/.test(claimToken)
  )
    return true
  if (`${pid}:${processToken}` === SessionActivityOwner.processOwnerToken) return true
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

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
  readonly executionMode?: ExecutionMode
  readonly run?: { readonly runID: string; readonly generation: number; readonly ownerToken: string }
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
          const executionMode = input.executionMode ?? (intent.execution_mode === "deferred" ? "deferred" : "run_now")
          if (intent.execution_mode !== "legacy" && intent.execution_mode !== executionMode)
            return yield* Effect.fail(
              new Conflict({ intentID: input.receipt.intentID, reason: "intent execution mode conflicts" }),
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
              execution_mode: executionMode,
              execution_state: "pending",
              execution_claim_id: null,
              execution_claimed_at: null,
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
              execution_mode: executionMode,
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
            admission.execution_mode !== executionMode ||
            admission.payload_fingerprint_kind !== "payload_hash" ||
            admission.payload_fingerprint !== intent.selected_payload_hash
          )
            return yield* Effect.fail(
              new Conflict({ intentID: input.receipt.intentID, reason: "activity admission identity conflicts" }),
            )
          if (executionMode === "deferred")
            return {
              ...fromRow(admitted),
              state: "admitted" as const,
              messageID: input.message.info.id,
              admissionID,
              executionMode,
            } satisfies MaterializedTurn
          const existingActivity = yield* tx
            .select()
            .from(SessionLegacyActivityTable)
            .where(eq(SessionLegacyActivityTable.trigger_admission_id, admissionID))
            .get()
            .pipe(Effect.orDie)
          const activityID = existingActivity?.activity_id ?? Hash.sha256(`session-legacy-activity:v1:${admissionID}`)
          const runID = input.run?.runID ?? Hash.sha256(`session-legacy-activity-run:v1:${activityID}`)
          const generation =
            input.run?.generation ??
            ((yield* tx
              .select({ generation: max(SessionLegacyActivityRunTable.generation) })
              .from(SessionLegacyActivityRunTable)
              .where(
                and(
                  eq(SessionLegacyActivityRunTable.session_id, input.receipt.sessionID),
                  eq(SessionLegacyActivityRunTable.mutation_epoch, session.mutationEpoch),
                ),
              )
              .get()
              .pipe(Effect.orDie))?.generation ?? -1) + 1
          const runOwnerToken = input.run?.ownerToken ?? SessionActivityOwner.processOwnerToken
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
                owner_token: runOwnerToken,
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
          const claimed = yield* tx
            .update(SessionIntentTable)
            .set({ execution_state: "claimed", execution_claim_id: runID, execution_claimed_at: now })
            .where(
              and(
                eq(SessionIntentTable.intent_id, input.receipt.intentID),
                eq(SessionIntentTable.execution_state, "pending"),
                isNull(SessionIntentTable.execution_claim_id),
                eq(SessionIntentTable.mutation_epoch, session.mutationEpoch),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!claimed)
            return yield* Effect.fail(
              new Conflict({ intentID: input.receipt.intentID, reason: "activity execution claim was lost" }),
            )
          yield* tx
            .insert(SessionLegacyActivityRunTable)
            .values({
              run_id: runID,
              activity_id: activityID,
              session_id: input.receipt.sessionID,
              mutation_epoch: session.mutationEpoch,
              generation,
              owner_token: runOwnerToken,
              state: "running",
              started_at: now,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          const run = yield* tx
            .select()
            .from(SessionLegacyActivityRunTable)
            .where(eq(SessionLegacyActivityRunTable.run_id, runID))
            .get()
            .pipe(Effect.orDie)
          if (
            !run ||
            run.activity_id !== activityID ||
            run.session_id !== input.receipt.sessionID ||
            run.mutation_epoch !== session.mutationEpoch ||
            run.generation !== generation ||
            run.owner_token !== runOwnerToken ||
            run.state !== "running"
          )
            return yield* Effect.fail(
              new Conflict({ intentID: input.receipt.intentID, reason: "activity run identity conflicts" }),
            )
          const deferred = yield* tx
            .select({
              intentID: SessionIntentTable.intent_id,
              admissionID: SessionActivityAdmissionTable.admission_id,
            })
            .from(SessionIntentTable)
            .innerJoin(
              SessionActivityAdmissionTable,
              eq(SessionActivityAdmissionTable.legacy_intent_id, SessionIntentTable.intent_id),
            )
            .where(
              and(
                eq(SessionIntentTable.session_id, input.receipt.sessionID),
                eq(SessionIntentTable.mutation_epoch, session.mutationEpoch),
                eq(SessionIntentTable.state, "admitted"),
                eq(SessionIntentTable.execution_mode, "deferred"),
                eq(SessionIntentTable.execution_state, "pending"),
                isNull(SessionIntentTable.execution_claim_id),
                lte(SessionIntentTable.time_created, intent.time_created),
              ),
            )
            .orderBy(asc(SessionIntentTable.time_created), asc(SessionIntentTable.intent_id))
            .all()
            .pipe(Effect.orDie)
          yield* Effect.forEach(
            deferred,
            (candidate, index) =>
              Effect.gen(function* () {
                const absorbed = yield* tx
                  .update(SessionIntentTable)
                  .set({ execution_state: "absorbed", execution_claim_id: runID, execution_claimed_at: now })
                  .where(
                    and(
                      eq(SessionIntentTable.intent_id, candidate.intentID),
                      eq(SessionIntentTable.execution_state, "pending"),
                      isNull(SessionIntentTable.execution_claim_id),
                      eq(SessionIntentTable.mutation_epoch, session.mutationEpoch),
                    ),
                  )
                  .returning({ intentID: SessionIntentTable.intent_id })
                  .get()
                  .pipe(Effect.orDie)
                if (!absorbed)
                  return yield* Effect.fail(
                    new Conflict({ intentID: candidate.intentID, reason: "deferred execution claim was lost" }),
                  )
                yield* tx
                  .insert(SessionLegacyActivityAdmissionTable)
                  .values({
                    activity_id: activityID,
                    admission_id: candidate.admissionID,
                    ordinal: index + 1,
                    role: "deferred_context",
                    attached_at: now,
                  })
                  .run()
                  .pipe(Effect.orDie)
              }),
            { discard: true },
          )
          return {
            ...fromRow(claimed),
            state: "admitted" as const,
            messageID: input.message.info.id,
            admissionID,
            executionMode,
            run: {
              runID,
              activityID,
              sessionID: input.receipt.sessionID,
              mutationEpoch: session.mutationEpoch,
              generation,
              ownerToken: runOwnerToken,
            },
          } satisfies MaterializedTurn
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const claimDeferredActivity = Effect.fn("SessionPromptIntent.claimDeferredActivity")(function* (input: {
  readonly sessionID: SessionID
  readonly messageID?: MessageID
  readonly run?: { readonly runID: string; readonly generation: number; readonly ownerToken: string }
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
          const candidates = yield* tx
            .select({
              intentID: SessionIntentTable.intent_id,
              admissionID: SessionActivityAdmissionTable.admission_id,
              messageID: SessionActivityAdmissionTable.admitted_message_id,
              timeCreated: SessionIntentTable.time_created,
            })
            .from(SessionIntentTable)
            .innerJoin(
              SessionActivityAdmissionTable,
              eq(SessionActivityAdmissionTable.legacy_intent_id, SessionIntentTable.intent_id),
            )
            .where(
              and(
                eq(SessionIntentTable.session_id, input.sessionID),
                eq(SessionIntentTable.mutation_epoch, session.mutationEpoch),
                eq(SessionIntentTable.state, "admitted"),
                eq(SessionIntentTable.execution_mode, "deferred"),
                eq(SessionIntentTable.execution_state, "pending"),
                isNull(SessionIntentTable.execution_claim_id),
                ...(input.messageID ? [eq(SessionActivityAdmissionTable.admitted_message_id, input.messageID)] : []),
              ),
            )
            .orderBy(asc(SessionIntentTable.time_created), asc(SessionIntentTable.intent_id))
            .all()
            .pipe(Effect.orDie)
          if (candidates.length === 0) return undefined
          if (candidates.length > 1)
            return yield* Effect.fail(
              new Conflict({
                intentID: candidates[0]!.intentID,
                reason: "multiple deferred prompts require an explicit message identity",
              }),
            )
          const candidate = candidates[0]!
          const activityID = Hash.sha256(`session-legacy-activity:v1:${candidate.admissionID}`)
          const runID = input.run?.runID ?? Hash.sha256(`session-legacy-activity-run:v1:${activityID}`)
          const generation =
            input.run?.generation ??
            ((yield* tx
              .select({ generation: max(SessionLegacyActivityRunTable.generation) })
              .from(SessionLegacyActivityRunTable)
              .where(
                and(
                  eq(SessionLegacyActivityRunTable.session_id, input.sessionID),
                  eq(SessionLegacyActivityRunTable.mutation_epoch, session.mutationEpoch),
                ),
              )
              .get()
              .pipe(Effect.orDie))?.generation ?? -1) + 1
          const ownerToken = input.run?.ownerToken ?? SessionActivityOwner.processOwnerToken
          const active = yield* tx
            .select({ activityID: SessionLegacyActivityTable.activity_id })
            .from(SessionLegacyActivityTable)
            .where(
              and(
                eq(SessionLegacyActivityTable.session_id, input.sessionID),
                eq(SessionLegacyActivityTable.state, "active"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (active)
            return yield* Effect.fail(
              new Conflict({
                intentID: candidate.intentID,
                reason: `legacy activity ${active.activityID} requires recovery before deferred execution`,
              }),
            )
          const now = Date.now()
          yield* tx
            .insert(SessionLegacyActivityTable)
            .values({
              activity_id: activityID,
              session_id: input.sessionID,
              ordinal:
                ((yield* tx
                  .select({ ordinal: max(SessionLegacyActivityTable.ordinal) })
                  .from(SessionLegacyActivityTable)
                  .where(eq(SessionLegacyActivityTable.session_id, input.sessionID))
                  .get()
                  .pipe(Effect.orDie))?.ordinal ?? -1) + 1,
              trigger_admission_id: candidate.admissionID,
              owner_token: ownerToken,
              state: "active",
              created_at: now,
            })
            .run()
            .pipe(Effect.orDie)
          yield* tx
            .insert(SessionLegacyActivityAdmissionTable)
            .values({
              activity_id: activityID,
              admission_id: candidate.admissionID,
              ordinal: 0,
              role: "trigger",
              attached_at: now,
            })
            .run()
            .pipe(Effect.orDie)
          const claimed = yield* tx
            .update(SessionIntentTable)
            .set({ execution_state: "claimed", execution_claim_id: runID, execution_claimed_at: now })
            .where(
              and(
                eq(SessionIntentTable.intent_id, candidate.intentID),
                eq(SessionIntentTable.execution_state, "pending"),
                isNull(SessionIntentTable.execution_claim_id),
                eq(SessionIntentTable.mutation_epoch, session.mutationEpoch),
              ),
            )
            .returning({ intentID: SessionIntentTable.intent_id })
            .get()
            .pipe(Effect.orDie)
          if (!claimed)
            return yield* Effect.fail(
              new Conflict({ intentID: candidate.intentID, reason: "deferred execution claim was lost" }),
            )
          yield* tx
            .insert(SessionLegacyActivityRunTable)
            .values({
              run_id: runID,
              activity_id: activityID,
              session_id: input.sessionID,
              mutation_epoch: session.mutationEpoch,
              generation,
              owner_token: ownerToken,
              state: "running",
              started_at: now,
            })
            .run()
            .pipe(Effect.orDie)
          return {
            runID,
            activityID,
            sessionID: input.sessionID,
            mutationEpoch: session.mutationEpoch,
            generation,
            ownerToken,
          } satisfies RunIdentity
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const claimActiveActivityRun = Effect.fn("SessionPromptIntent.claimActiveActivityRun")(function* (input: {
  readonly sessionID: SessionID
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
          const active = yield* tx
            .select({
              activityID: SessionLegacyActivityTable.activity_id,
              ownerToken: SessionLegacyActivityTable.owner_token,
              intentID: SessionIntentTable.intent_id,
              executionMode: SessionIntentTable.execution_mode,
              executionState: SessionIntentTable.execution_state,
              executionClaimID: SessionIntentTable.execution_claim_id,
            })
            .from(SessionLegacyActivityTable)
            .innerJoin(
              SessionActivityAdmissionTable,
              eq(SessionActivityAdmissionTable.admission_id, SessionLegacyActivityTable.trigger_admission_id),
            )
            .innerJoin(
              SessionIntentTable,
              eq(SessionIntentTable.intent_id, SessionActivityAdmissionTable.legacy_intent_id),
            )
            .where(
              and(
                eq(SessionLegacyActivityTable.session_id, input.sessionID),
                eq(SessionLegacyActivityTable.state, "active"),
                eq(SessionIntentTable.mutation_epoch, session.mutationEpoch),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!active) return undefined
          if (active.executionMode !== "run_now") return undefined
          const existing = yield* tx
            .select()
            .from(SessionLegacyActivityRunTable)
            .where(
              and(
                eq(SessionLegacyActivityRunTable.activity_id, active.activityID),
                eq(SessionLegacyActivityRunTable.session_id, input.sessionID),
                eq(SessionLegacyActivityRunTable.mutation_epoch, session.mutationEpoch),
                inArray(SessionLegacyActivityRunTable.state, ["running", "finalizing"]),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (existing)
            return {
              runID: existing.run_id,
              activityID: existing.activity_id,
              sessionID: SessionID.make(existing.session_id),
              mutationEpoch: existing.mutation_epoch,
              generation: existing.generation,
              ownerToken: existing.owner_token,
            } satisfies RunIdentity
          const runID = Hash.sha256(`session-legacy-activity-run:v1:${active.activityID}`)
          if (active.executionState === "claimed" && active.executionClaimID !== runID)
            return yield* Effect.fail(
              new Conflict({ intentID: active.intentID, reason: "active activity claim is owned by another run" }),
            )
          if (active.executionState !== "claimed") {
            if (active.executionState !== "pending")
              return yield* Effect.fail(
                new Conflict({ intentID: active.intentID, reason: "active activity execution cannot be claimed" }),
              )
            const claimed = yield* tx
              .update(SessionIntentTable)
              .set({
                execution_state: "claimed",
                execution_claim_id: runID,
                execution_claimed_at: Date.now(),
              })
              .where(
                and(
                  eq(SessionIntentTable.intent_id, active.intentID),
                  eq(SessionIntentTable.execution_mode, "run_now"),
                  eq(SessionIntentTable.execution_state, "pending"),
                  eq(SessionIntentTable.mutation_epoch, session.mutationEpoch),
                ),
              )
              .returning({ intentID: SessionIntentTable.intent_id })
              .get()
              .pipe(Effect.orDie)
            if (!claimed)
              return yield* Effect.fail(
                new Conflict({ intentID: active.intentID, reason: "active activity execution claim was lost" }),
              )
          }
          const generation =
            ((yield* tx
              .select({ generation: max(SessionLegacyActivityRunTable.generation) })
              .from(SessionLegacyActivityRunTable)
              .where(
                and(
                  eq(SessionLegacyActivityRunTable.session_id, input.sessionID),
                  eq(SessionLegacyActivityRunTable.mutation_epoch, session.mutationEpoch),
                ),
              )
              .get()
              .pipe(Effect.orDie))?.generation ?? -1) + 1
          yield* tx
            .insert(SessionLegacyActivityRunTable)
            .values({
              run_id: runID,
              activity_id: active.activityID,
              session_id: input.sessionID,
              mutation_epoch: session.mutationEpoch,
              generation,
              owner_token: active.ownerToken,
              state: "running",
              started_at: Date.now(),
            })
            .run()
            .pipe(Effect.orDie)
          return {
            runID,
            activityID: active.activityID,
            sessionID: input.sessionID,
            mutationEpoch: session.mutationEpoch,
            generation,
            ownerToken: active.ownerToken,
          } satisfies RunIdentity
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const markRunFinalizing = Effect.fn("SessionPromptIntent.markRunFinalizing")(function* (run: RunIdentity) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select()
            .from(SessionLegacyActivityRunTable)
            .where(eq(SessionLegacyActivityRunTable.run_id, run.runID))
            .get()
          if (
            !current ||
            current.activity_id !== run.activityID ||
            current.session_id !== run.sessionID ||
            current.mutation_epoch !== run.mutationEpoch ||
            current.generation !== run.generation ||
            current.owner_token !== run.ownerToken ||
            !["running", "finalizing"].includes(current.state)
          )
            return yield* Effect.fail(
              new Conflict({ intentID: run.runID, reason: "activity run cannot enter finalizing" }),
            )
          if (current.state === "finalizing") return
          const updated = yield* tx
            .update(SessionLegacyActivityRunTable)
            .set({ state: "finalizing" })
            .where(
              and(
                eq(SessionLegacyActivityRunTable.run_id, run.runID),
                eq(SessionLegacyActivityRunTable.owner_token, run.ownerToken),
                eq(SessionLegacyActivityRunTable.state, "running"),
              ),
            )
            .returning({ runID: SessionLegacyActivityRunTable.run_id })
            .get()
          if (!updated)
            return yield* Effect.fail(new Conflict({ intentID: run.runID, reason: "activity run finalizing CAS lost" }))
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

export const markRunRunning = Effect.fn("SessionPromptIntent.markRunRunning")(function* (run: RunIdentity) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select()
            .from(SessionLegacyActivityRunTable)
            .where(eq(SessionLegacyActivityRunTable.run_id, run.runID))
            .get()
          if (
            !current ||
            current.activity_id !== run.activityID ||
            current.session_id !== run.sessionID ||
            current.mutation_epoch !== run.mutationEpoch ||
            current.generation !== run.generation ||
            current.owner_token !== run.ownerToken ||
            !["running", "finalizing"].includes(current.state)
          )
            return yield* Effect.fail(
              new Conflict({ intentID: run.runID, reason: "activity run cannot resume running" }),
            )
          if (current.state === "running") return
          const updated = yield* tx
            .update(SessionLegacyActivityRunTable)
            .set({ state: "running" })
            .where(
              and(
                eq(SessionLegacyActivityRunTable.run_id, run.runID),
                eq(SessionLegacyActivityRunTable.owner_token, run.ownerToken),
                eq(SessionLegacyActivityRunTable.state, "finalizing"),
              ),
            )
            .returning({ runID: SessionLegacyActivityRunTable.run_id })
            .get()
          if (!updated)
            return yield* Effect.fail(new Conflict({ intentID: run.runID, reason: "activity run resume CAS lost" }))
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
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

export const activeActivityForSession = Effect.fn("SessionPromptIntent.activeActivityForSession")(function* (
  sessionID: SessionID,
) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({
      activityID: SessionLegacyActivityTable.activity_id,
      admissionID: SessionLegacyActivityTable.trigger_admission_id,
      messageID: SessionActivityAdmissionTable.admitted_message_id,
      sessionID: SessionLegacyActivityTable.session_id,
      state: SessionLegacyActivityTable.state,
    })
    .from(SessionLegacyActivityTable)
    .innerJoin(
      SessionActivityAdmissionTable,
      eq(SessionActivityAdmissionTable.admission_id, SessionLegacyActivityTable.trigger_admission_id),
    )
    .where(and(eq(SessionLegacyActivityTable.session_id, sessionID), eq(SessionLegacyActivityTable.state, "active")))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  return {
    activityID: row.activityID,
    admissionID: row.admissionID,
    messageID: MessageID.make(row.messageID),
    sessionID: SessionID.make(row.sessionID),
    state: row.state,
  }
})

export const freezeProviderInputBoundary = Effect.fn("SessionPromptIntent.freezeProviderInputBoundary")(function* (
  run: RunIdentity,
  options?: { readonly includePendingSteers?: boolean },
) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const session = yield* tx
            .select({ mutationEpoch: SessionTable.mutation_epoch })
            .from(SessionTable)
            .where(eq(SessionTable.id, run.sessionID))
            .get()
            .pipe(Effect.orDie)
          const current = yield* tx
            .select()
            .from(SessionLegacyActivityRunTable)
            .where(eq(SessionLegacyActivityRunTable.run_id, run.runID))
            .get()
            .pipe(Effect.orDie)
          if (
            !session ||
            session.mutationEpoch !== run.mutationEpoch ||
            !current ||
            current.activity_id !== run.activityID ||
            current.session_id !== run.sessionID ||
            current.mutation_epoch !== run.mutationEpoch ||
            current.generation !== run.generation ||
            current.owner_token !== run.ownerToken ||
            !["running", "finalizing"].includes(current.state)
          )
            return yield* Effect.fail(new Conflict({ intentID: run.runID, reason: "activity run ownership is stale" }))
          const pendingSteer =
            options?.includePendingSteers === false
              ? undefined
              : yield* tx
                  .select({ id: SessionSteerTable.id })
                  .from(SessionSteerTable)
                  .where(
                    and(
                      eq(SessionSteerTable.session_id, run.sessionID),
                      eq(SessionSteerTable.mutation_epoch, run.mutationEpoch),
                      eq(SessionSteerTable.delivery, "steer"),
                      isNull(SessionSteerTable.consumed_seq),
                      isNull(SessionSteerTable.superseded_at),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
          if (pendingSteer) return { kind: "pending_steer" as const }
          const membership = yield* tx
            .select({ ordinal: max(SessionLegacyActivityAdmissionTable.ordinal) })
            .from(SessionLegacyActivityAdmissionTable)
            .where(eq(SessionLegacyActivityAdmissionTable.activity_id, run.activityID))
            .get()
            .pipe(Effect.orDie)
          return {
            kind: "ready" as const,
            boundary: { ...run, membershipOrdinal: membership?.ordinal ?? 0 },
          } satisfies ProviderInputBoundaryResult
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const beginProgress = Effect.fn("SessionPromptIntent.beginProgress")(function* (input: {
  readonly activityID: string
  readonly assistantMessageID: MessageID
  readonly providerReceiptID: string
  readonly membershipOrdinal?: number
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
            input_membership_ordinal: input.membershipOrdinal ?? 0,
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

const settleProgressInTransaction = Effect.fn("SessionPromptIntent.settleProgressInTransaction")(function* (
  tx: Transaction,
  input: {
    readonly activityID: string
    readonly assistantMessageID: MessageID
  },
  settleActivity: boolean,
) {
  const current = yield* tx
    .select()
    .from(SessionActivityProgressTable)
    .where(eq(SessionActivityProgressTable.assistant_message_id, input.assistantMessageID))
    .get()
  if (!current || current.activity_id !== input.activityID)
    return yield* Effect.die(new Error(`activity progress is missing: ${input.assistantMessageID}`))
  if (current.state !== "provisional") return { value: progress(current), row: current }
  const activity = yield* tx
    .select()
    .from(SessionLegacyActivityTable)
    .where(eq(SessionLegacyActivityTable.activity_id, input.activityID))
    .get()
  if (!activity) return yield* Effect.die(new Error(`legacy activity is missing: ${input.activityID}`))
  const receipt = yield* tx
    .select()
    .from(SessionToolRequestReceiptTable)
    .where(eq(SessionToolRequestReceiptTable.receipt_id, current.provider_receipt_id))
    .get()
  if (!receipt) return yield* Effect.die(new Error(`provider receipt is missing: ${current.provider_receipt_id}`))
  if (!["settled", "failed", "indeterminate_after_crash"].includes(receipt.provider_state))
    return yield* Effect.die(
      new Error(`provider receipt is not terminal: ${current.provider_receipt_id}: ${receipt.provider_state}`),
    )
  const assistant = yield* tx.select().from(MessageTable).where(eq(MessageTable.id, input.assistantMessageID)).get()
  if (!assistant || assistant.session_id !== receipt.session_id || assistant.data.role !== "assistant")
    return yield* Effect.die(new Error(`assistant response ownership mismatch: ${input.assistantMessageID}`))
  const assistantData = assistant.data as Omit<SessionV1.Assistant, "id" | "sessionID">
  const latestAdmission = yield* tx
    .select({ ordinal: max(SessionLegacyActivityAdmissionTable.ordinal) })
    .from(SessionLegacyActivityAdmissionTable)
    .where(eq(SessionLegacyActivityAdmissionTable.activity_id, input.activityID))
    .get()
  const pendingAdmission =
    typeof latestAdmission?.ordinal === "number" ? current.input_membership_ordinal < latestAdmission.ordinal : false
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
    activity.state === "interrupted"
      ? "interrupted"
      : activity.state === "recovery_required" || activity.state === "failed"
        ? "recovery_required"
        : receipt.provider_state === "indeterminate_after_crash"
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
  if (!updated) return yield* Effect.die(new Error(`activity progress settlement CAS lost: ${input.activityID}`))
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
  if (settleActivity && state !== "progress") {
    const activityState = state === "final" ? "settled" : state === "interrupted" ? "interrupted" : "recovery_required"
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
    if (!terminal && activity.state === "active")
      return yield* Effect.die(new Error(`legacy activity settlement CAS lost: ${input.activityID}`))
    yield* settleMonitoringObjectiveInTransaction(
      tx,
      input.activityID,
      state === "final" ? "completed" : state === "interrupted" ? "interrupted" : "recovery_required",
      assistantData.finish ?? receipt.request_error_code ?? state,
      now,
    )
  }
  return { value: progress(updated), row: updated }
})

const settleMonitoringObjectiveInTransaction = Effect.fn("SessionPromptIntent.settleMonitoringObjectiveInTransaction")(
  function* (
    tx: Transaction,
    activityID: string,
    state: "completed" | "interrupted" | "recovery_required",
    terminalReason: string,
    now: number,
  ) {
    const objective = yield* tx
      .select()
      .from(SessionActivityObjectiveTable)
      .where(
        and(
          eq(SessionActivityObjectiveTable.activity_kind, "legacy"),
          eq(SessionActivityObjectiveTable.activity_id, activityID),
        ),
      )
      .get()
    if (objective?.enforcement_state !== "monitoring" || !["active", "needs_human"].includes(objective.state)) return
    const updated = yield* tx
      .update(SessionActivityObjectiveTable)
      .set({
        version: objective.version + 1,
        state,
        terminal_reason: terminalReason,
        updated_at: now,
        settled_at: now,
      })
      .where(
        and(
          eq(SessionActivityObjectiveTable.activity_kind, "legacy"),
          eq(SessionActivityObjectiveTable.activity_id, activityID),
          eq(SessionActivityObjectiveTable.version, objective.version),
          sql`${SessionActivityObjectiveTable.state} IN ('active', 'needs_human')`,
        ),
      )
      .returning({ activityID: SessionActivityObjectiveTable.activity_id })
      .get()
    if (!updated) return yield* Effect.die(new Error(`activity objective settlement CAS lost: ${activityID}`))
  },
)

export const settleProgress = Effect.fn("SessionPromptIntent.settleProgress")(function* (input: {
  readonly activityID: string
  readonly assistantMessageID: MessageID
}) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction((tx) => settleProgressInTransaction(tx, input, true).pipe(Effect.map((settled) => settled.value)), {
      behavior: "immediate",
    })
    .pipe(Effect.orDie)
})

export const settleProgressOnly = Effect.fn("SessionPromptIntent.settleProgressOnly")(function* (input: {
  readonly activityID: string
  readonly assistantMessageID: MessageID
}) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction((tx) => settleProgressInTransaction(tx, input, false).pipe(Effect.map((settled) => settled.value)), {
      behavior: "immediate",
    })
    .pipe(Effect.orDie)
})

export const finalizeActivityWithRevision = Effect.fn("SessionPromptIntent.finalizeActivityWithRevision")(
  function* (input: {
    readonly run: RunIdentity
    readonly assistantMessageID: MessageID
    readonly decision: ActivityTerminalDecision
  }) {
    const { db } = yield* Database.Service
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select()
              .from(SessionLegacyActivityTerminalTable)
              .where(eq(SessionLegacyActivityTerminalTable.activity_id, input.run.activityID))
              .get()
            if (existing) {
              const replayProgress = yield* tx
                .select({
                  revision: SessionActivityProgressTable.revision,
                  membershipOrdinal: SessionActivityProgressTable.input_membership_ordinal,
                  state: SessionActivityProgressTable.state,
                })
                .from(SessionActivityProgressTable)
                .where(
                  and(
                    eq(SessionActivityProgressTable.activity_id, input.run.activityID),
                    eq(SessionActivityProgressTable.assistant_message_id, input.assistantMessageID),
                  ),
                )
                .get()
              const replayDecision = replayProgress
                ? terminalDecisionForProgress(input.decision, replayProgress.state)
                : input.decision
              if (
                existing.session_id !== input.run.sessionID ||
                existing.mutation_epoch !== input.run.mutationEpoch ||
                existing.state !== replayDecision.state ||
                existing.reason_code !== replayDecision.reasonCode ||
                existing.source !== replayDecision.source ||
                existing.operation_id !== replayDecision.operationID ||
                existing.run_id !== input.run.runID ||
                existing.assistant_message_id !== input.assistantMessageID ||
                existing.progress_revision !== replayProgress?.revision ||
                existing.membership_ordinal !== replayProgress?.membershipOrdinal ||
                existing.owner_token !== input.decision.ownerToken
              )
                return yield* Effect.fail(
                  new Conflict({ intentID: input.run.runID, reason: "activity terminal replay diverged" }),
                )
              return {
                kind: "exact_replay" as const,
                invalidation: {
                  activityID: input.run.activityID,
                  sessionID: input.run.sessionID,
                  assistantMessageID: input.assistantMessageID,
                },
              } satisfies FinalizeResult
            }
            if (input.decision.ownerToken !== input.run.ownerToken)
              return yield* Effect.fail(
                new Conflict({ intentID: input.run.runID, reason: "activity terminal owner conflicts" }),
              )
            const session = yield* tx
              .select({ mutationEpoch: SessionTable.mutation_epoch })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.run.sessionID))
              .get()
            const run = yield* tx
              .select()
              .from(SessionLegacyActivityRunTable)
              .where(eq(SessionLegacyActivityRunTable.run_id, input.run.runID))
              .get()
            const activity = yield* tx
              .select()
              .from(SessionLegacyActivityTable)
              .where(eq(SessionLegacyActivityTable.activity_id, input.run.activityID))
              .get()
            if (
              !session ||
              session.mutationEpoch !== input.run.mutationEpoch ||
              !run ||
              run.activity_id !== input.run.activityID ||
              run.session_id !== input.run.sessionID ||
              run.mutation_epoch !== input.run.mutationEpoch ||
              run.generation !== input.run.generation ||
              run.owner_token !== input.run.ownerToken ||
              !["running", "finalizing"].includes(run.state) ||
              !activity ||
              activity.session_id !== input.run.sessionID ||
              activity.owner_token !== input.run.ownerToken ||
              activity.state !== "active"
            )
              return yield* Effect.fail(
                new Conflict({ intentID: input.run.runID, reason: "activity terminal ownership is stale" }),
              )
            const settled = yield* settleProgressInTransaction(
              tx,
              { activityID: input.run.activityID, assistantMessageID: input.assistantMessageID },
              false,
            )
            const decision = terminalDecisionForProgress(input.decision, settled.row.state)
            const latestMembership =
              (yield* tx
                .select({ ordinal: max(SessionLegacyActivityAdmissionTable.ordinal) })
                .from(SessionLegacyActivityAdmissionTable)
                .where(eq(SessionLegacyActivityAdmissionTable.activity_id, input.run.activityID))
                .get())?.ordinal ?? 0
            const now = Date.now()
            if (decision.source === "cancel") yield* cancelPendingActivitySteers(tx, input.run, now)
            const pendingSteer = yield* tx
              .select({ id: SessionSteerTable.id })
              .from(SessionSteerTable)
              .innerJoin(
                SessionActivityAdmissionTable,
                eq(SessionActivityAdmissionTable.admitted_message_id, SessionSteerTable.id),
              )
              .innerJoin(
                SessionLegacyActivityAdmissionTable,
                eq(SessionLegacyActivityAdmissionTable.admission_id, SessionActivityAdmissionTable.admission_id),
              )
              .where(
                and(
                  eq(SessionSteerTable.session_id, input.run.sessionID),
                  eq(SessionSteerTable.mutation_epoch, input.run.mutationEpoch),
                  eq(SessionSteerTable.delivery, "steer"),
                  eq(SessionLegacyActivityAdmissionTable.activity_id, input.run.activityID),
                  isNull(SessionSteerTable.consumed_seq),
                  isNull(SessionSteerTable.superseded_at),
                ),
              )
              .get()
            if (
              decision.source !== "cancel" &&
              (latestMembership > settled.row.input_membership_ordinal || pendingSteer)
            )
              return {
                kind: "follow_up_required" as const,
                membershipOrdinal: latestMembership,
              } satisfies FinalizeResult
            yield* pauseAtActivityCrashPoint("inside_revision_terminal_transaction")
            const runState =
              decision.state === "settled"
                ? "completed"
                : decision.state === "failed"
                  ? "failed"
                  : decision.state === "interrupted"
                    ? "interrupted"
                    : "recovery_required"
            const terminalRun = yield* tx
              .update(SessionLegacyActivityRunTable)
              .set({ state: runState, terminal_at: now, terminal_reason: decision.reasonCode })
              .where(
                and(
                  eq(SessionLegacyActivityRunTable.run_id, input.run.runID),
                  eq(SessionLegacyActivityRunTable.owner_token, input.run.ownerToken),
                  inArray(SessionLegacyActivityRunTable.state, ["running", "finalizing"]),
                ),
              )
              .returning({ runID: SessionLegacyActivityRunTable.run_id })
              .get()
            if (!terminalRun)
              return yield* Effect.fail(
                new Conflict({ intentID: input.run.runID, reason: "activity run terminal CAS lost" }),
              )
            const terminalActivity = yield* tx
              .update(SessionLegacyActivityTable)
              .set({ state: decision.state, terminal_reason: decision.reasonCode, settled_at: now })
              .where(
                and(
                  eq(SessionLegacyActivityTable.activity_id, input.run.activityID),
                  eq(SessionLegacyActivityTable.owner_token, input.run.ownerToken),
                  eq(SessionLegacyActivityTable.state, "active"),
                ),
              )
              .returning({ activityID: SessionLegacyActivityTable.activity_id })
              .get()
            if (!terminalActivity)
              return yield* Effect.fail(
                new Conflict({ intentID: input.run.runID, reason: "activity terminal CAS lost" }),
              )
            yield* settleMonitoringObjectiveInTransaction(
              tx,
              input.run.activityID,
              decision.state === "settled"
                ? "completed"
                : decision.state === "failed"
                  ? "recovery_required"
                  : decision.state,
              decision.reasonCode,
              now,
            )
            yield* tx
              .insert(SessionLegacyActivityTerminalTable)
              .values({
                activity_id: input.run.activityID,
                session_id: input.run.sessionID,
                mutation_epoch: input.run.mutationEpoch,
                state: decision.state,
                reason_code: decision.reasonCode,
                source: decision.source,
                operation_id: decision.operationID,
                run_id: input.run.runID,
                assistant_message_id: input.assistantMessageID,
                progress_revision: settled.row.revision,
                membership_ordinal: settled.row.input_membership_ordinal,
                owner_token: input.run.ownerToken,
                created_at: now,
              })
              .run()
            return {
              kind: "terminal_committed" as const,
              invalidation: {
                activityID: input.run.activityID,
                sessionID: input.run.sessionID,
                assistantMessageID: input.assistantMessageID,
              },
            } satisfies FinalizeResult
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die))
      .pipe(Effect.catchTag("SqlError", Effect.die))
  },
)

export const finalizeActivityWithoutRevision = Effect.fn("SessionPromptIntent.finalizeActivityWithoutRevision")(
  function* (input: {
    readonly run: RunIdentity
    readonly membershipOrdinal: number
    readonly decision: ActivityTerminalDecision
  }) {
    const { db } = yield* Database.Service
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select()
              .from(SessionLegacyActivityTerminalTable)
              .where(eq(SessionLegacyActivityTerminalTable.activity_id, input.run.activityID))
              .get()
            if (existing) {
              if (
                existing.session_id !== input.run.sessionID ||
                existing.mutation_epoch !== input.run.mutationEpoch ||
                existing.state !== input.decision.state ||
                existing.reason_code !== input.decision.reasonCode ||
                existing.source !== input.decision.source ||
                existing.operation_id !== input.decision.operationID ||
                existing.run_id !== input.run.runID ||
                existing.assistant_message_id !== null ||
                existing.progress_revision !== null ||
                existing.membership_ordinal !== input.membershipOrdinal ||
                existing.owner_token !== input.decision.ownerToken
              )
                return yield* Effect.fail(
                  new Conflict({ intentID: input.run.runID, reason: "activity terminal replay diverged" }),
                )
              return {
                kind: "exact_replay" as const,
                invalidation: { activityID: input.run.activityID, sessionID: input.run.sessionID },
              } satisfies FinalizeResult
            }
            if (input.decision.ownerToken !== input.run.ownerToken)
              return yield* Effect.fail(
                new Conflict({ intentID: input.run.runID, reason: "activity terminal owner conflicts" }),
              )
            const session = yield* tx
              .select({ mutationEpoch: SessionTable.mutation_epoch })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.run.sessionID))
              .get()
            const run = yield* tx
              .select()
              .from(SessionLegacyActivityRunTable)
              .where(eq(SessionLegacyActivityRunTable.run_id, input.run.runID))
              .get()
            const activity = yield* tx
              .select()
              .from(SessionLegacyActivityTable)
              .where(eq(SessionLegacyActivityTable.activity_id, input.run.activityID))
              .get()
            if (
              !session ||
              session.mutationEpoch !== input.run.mutationEpoch ||
              !run ||
              run.activity_id !== input.run.activityID ||
              run.session_id !== input.run.sessionID ||
              run.mutation_epoch !== input.run.mutationEpoch ||
              run.generation !== input.run.generation ||
              run.owner_token !== input.run.ownerToken ||
              !["running", "finalizing"].includes(run.state) ||
              !activity ||
              activity.session_id !== input.run.sessionID ||
              activity.owner_token !== input.run.ownerToken ||
              activity.state !== "active"
            )
              return yield* Effect.fail(
                new Conflict({ intentID: input.run.runID, reason: "activity terminal ownership is stale" }),
              )
            const membershipOrdinal =
              (yield* tx
                .select({ ordinal: max(SessionLegacyActivityAdmissionTable.ordinal) })
                .from(SessionLegacyActivityAdmissionTable)
                .where(eq(SessionLegacyActivityAdmissionTable.activity_id, input.run.activityID))
                .get())?.ordinal ?? 0
            const now = Date.now()
            if (input.decision.source === "cancel") yield* cancelPendingActivitySteers(tx, input.run, now)
            const pendingSteer = yield* tx
              .select({ id: SessionSteerTable.id })
              .from(SessionSteerTable)
              .innerJoin(
                SessionActivityAdmissionTable,
                eq(SessionActivityAdmissionTable.admitted_message_id, SessionSteerTable.id),
              )
              .innerJoin(
                SessionLegacyActivityAdmissionTable,
                eq(SessionLegacyActivityAdmissionTable.admission_id, SessionActivityAdmissionTable.admission_id),
              )
              .where(
                and(
                  eq(SessionSteerTable.session_id, input.run.sessionID),
                  eq(SessionSteerTable.mutation_epoch, input.run.mutationEpoch),
                  eq(SessionSteerTable.delivery, "steer"),
                  eq(SessionLegacyActivityAdmissionTable.activity_id, input.run.activityID),
                  isNull(SessionSteerTable.consumed_seq),
                  isNull(SessionSteerTable.superseded_at),
                ),
              )
              .get()
            if (input.decision.source !== "cancel" && (membershipOrdinal > input.membershipOrdinal || pendingSteer))
              return { kind: "follow_up_required" as const, membershipOrdinal } satisfies FinalizeResult
            yield* pauseAtActivityCrashPoint("inside_revision_terminal_transaction")
            const runState = terminalRunState(input.decision.state)
            const terminalRun = yield* tx
              .update(SessionLegacyActivityRunTable)
              .set({ state: runState, terminal_at: now, terminal_reason: input.decision.reasonCode })
              .where(
                and(
                  eq(SessionLegacyActivityRunTable.run_id, input.run.runID),
                  eq(SessionLegacyActivityRunTable.owner_token, input.run.ownerToken),
                  inArray(SessionLegacyActivityRunTable.state, ["running", "finalizing"]),
                ),
              )
              .returning({ runID: SessionLegacyActivityRunTable.run_id })
              .get()
            if (!terminalRun)
              return yield* Effect.fail(
                new Conflict({ intentID: input.run.runID, reason: "activity run terminal CAS lost" }),
              )
            const terminalActivity = yield* tx
              .update(SessionLegacyActivityTable)
              .set({ state: input.decision.state, terminal_reason: input.decision.reasonCode, settled_at: now })
              .where(
                and(
                  eq(SessionLegacyActivityTable.activity_id, input.run.activityID),
                  eq(SessionLegacyActivityTable.owner_token, input.run.ownerToken),
                  eq(SessionLegacyActivityTable.state, "active"),
                ),
              )
              .returning({ activityID: SessionLegacyActivityTable.activity_id })
              .get()
            if (!terminalActivity)
              return yield* Effect.fail(
                new Conflict({ intentID: input.run.runID, reason: "activity terminal CAS lost" }),
              )
            yield* settleMonitoringObjectiveInTransaction(
              tx,
              input.run.activityID,
              input.decision.state === "settled"
                ? "completed"
                : input.decision.state === "failed"
                  ? "recovery_required"
                  : input.decision.state,
              input.decision.reasonCode,
              now,
            )
            yield* tx
              .insert(SessionLegacyActivityTerminalTable)
              .values({
                activity_id: input.run.activityID,
                session_id: input.run.sessionID,
                mutation_epoch: input.run.mutationEpoch,
                state: input.decision.state,
                reason_code: input.decision.reasonCode,
                source: input.decision.source,
                operation_id: input.decision.operationID,
                run_id: input.run.runID,
                membership_ordinal: input.membershipOrdinal,
                owner_token: input.run.ownerToken,
                created_at: now,
              })
              .run()
            return {
              kind: "terminal_committed" as const,
              invalidation: { activityID: input.run.activityID, sessionID: input.run.sessionID },
            } satisfies FinalizeResult
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die))
      .pipe(Effect.catchTag("SqlError", Effect.die))
  },
)

export const finalizeCancellationBeforeProgress = Effect.fn("SessionPromptIntent.finalizeCancellationBeforeProgress")(
  function* (run: RunIdentity) {
    const { db } = yield* Database.Service
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select()
              .from(SessionLegacyActivityTerminalTable)
              .where(eq(SessionLegacyActivityTerminalTable.activity_id, run.activityID))
              .get()
            if (existing) {
              if (
                existing.session_id !== run.sessionID ||
                existing.mutation_epoch !== run.mutationEpoch ||
                existing.state !== "interrupted" ||
                existing.reason_code !== "user_cancelled" ||
                existing.source !== "cancel" ||
                existing.operation_id !== `${run.runID}:terminal` ||
                existing.run_id !== run.runID ||
                existing.owner_token !== run.ownerToken
              )
                return yield* Effect.fail(
                  new Conflict({ intentID: run.runID, reason: "activity cancellation replay diverged" }),
                )
              return {
                kind: "exact_replay" as const,
                invalidation: {
                  activityID: run.activityID,
                  sessionID: run.sessionID,
                  ...(existing.assistant_message_id
                    ? { assistantMessageID: MessageID.make(existing.assistant_message_id) }
                    : {}),
                },
              } satisfies FinalizeResult
            }
            const progress = yield* tx
              .select({ assistantMessageID: SessionActivityProgressTable.assistant_message_id })
              .from(SessionActivityProgressTable)
              .where(eq(SessionActivityProgressTable.activity_id, run.activityID))
              .limit(1)
              .get()
            if (progress) return undefined
            const session = yield* tx
              .select({ mutationEpoch: SessionTable.mutation_epoch })
              .from(SessionTable)
              .where(eq(SessionTable.id, run.sessionID))
              .get()
            const currentRun = yield* tx
              .select()
              .from(SessionLegacyActivityRunTable)
              .where(eq(SessionLegacyActivityRunTable.run_id, run.runID))
              .get()
            const activity = yield* tx
              .select()
              .from(SessionLegacyActivityTable)
              .where(eq(SessionLegacyActivityTable.activity_id, run.activityID))
              .get()
            if (
              !session ||
              session.mutationEpoch !== run.mutationEpoch ||
              !currentRun ||
              currentRun.activity_id !== run.activityID ||
              currentRun.session_id !== run.sessionID ||
              currentRun.mutation_epoch !== run.mutationEpoch ||
              currentRun.generation !== run.generation ||
              currentRun.owner_token !== run.ownerToken ||
              !["running", "finalizing"].includes(currentRun.state) ||
              !activity ||
              activity.session_id !== run.sessionID ||
              activity.owner_token !== run.ownerToken ||
              activity.state !== "active"
            )
              return yield* Effect.fail(
                new Conflict({ intentID: run.runID, reason: "activity cancellation ownership is stale" }),
              )
            const membershipOrdinal =
              (yield* tx
                .select({ ordinal: max(SessionLegacyActivityAdmissionTable.ordinal) })
                .from(SessionLegacyActivityAdmissionTable)
                .where(eq(SessionLegacyActivityAdmissionTable.activity_id, run.activityID))
                .get())?.ordinal ?? 0
            const now = Date.now()
            yield* cancelPendingActivitySteers(tx, run, now)
            const terminalRun = yield* tx
              .update(SessionLegacyActivityRunTable)
              .set({ state: "interrupted", terminal_at: now, terminal_reason: "user_cancelled" })
              .where(
                and(
                  eq(SessionLegacyActivityRunTable.run_id, run.runID),
                  eq(SessionLegacyActivityRunTable.owner_token, run.ownerToken),
                  inArray(SessionLegacyActivityRunTable.state, ["running", "finalizing"]),
                ),
              )
              .returning({ runID: SessionLegacyActivityRunTable.run_id })
              .get()
            if (!terminalRun)
              return yield* Effect.fail(
                new Conflict({ intentID: run.runID, reason: "activity cancellation run CAS lost" }),
              )
            const terminalActivity = yield* tx
              .update(SessionLegacyActivityTable)
              .set({ state: "interrupted", terminal_reason: "user_cancelled", settled_at: now })
              .where(
                and(
                  eq(SessionLegacyActivityTable.activity_id, run.activityID),
                  eq(SessionLegacyActivityTable.owner_token, run.ownerToken),
                  eq(SessionLegacyActivityTable.state, "active"),
                ),
              )
              .returning({ activityID: SessionLegacyActivityTable.activity_id })
              .get()
            if (!terminalActivity)
              return yield* Effect.fail(
                new Conflict({ intentID: run.runID, reason: "activity cancellation terminal CAS lost" }),
              )
            yield* settleMonitoringObjectiveInTransaction(tx, run.activityID, "interrupted", "user_cancelled", now)
            yield* tx
              .insert(SessionLegacyActivityTerminalTable)
              .values({
                activity_id: run.activityID,
                session_id: run.sessionID,
                mutation_epoch: run.mutationEpoch,
                state: "interrupted",
                reason_code: "user_cancelled",
                source: "cancel",
                operation_id: `${run.runID}:terminal`,
                run_id: run.runID,
                membership_ordinal: membershipOrdinal,
                owner_token: run.ownerToken,
                created_at: now,
              })
              .run()
            return {
              kind: "terminal_committed" as const,
              invalidation: { activityID: run.activityID, sessionID: run.sessionID },
            } satisfies FinalizeResult
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die))
      .pipe(Effect.catchTag("SqlError", Effect.die))
  },
)

const cancelPendingActivitySteers = Effect.fn("SessionPromptIntent.cancelPendingActivitySteers")(function* (
  tx: Transaction,
  run: RunIdentity,
  now: number,
) {
  const rows = yield* tx
    .select({ id: SessionSteerTable.id })
    .from(SessionSteerTable)
    .innerJoin(
      SessionActivityAdmissionTable,
      eq(SessionActivityAdmissionTable.admitted_message_id, SessionSteerTable.id),
    )
    .innerJoin(
      SessionLegacyActivityAdmissionTable,
      eq(SessionLegacyActivityAdmissionTable.admission_id, SessionActivityAdmissionTable.admission_id),
    )
    .where(
      and(
        eq(SessionSteerTable.session_id, run.sessionID),
        eq(SessionSteerTable.mutation_epoch, run.mutationEpoch),
        eq(SessionSteerTable.delivery, "steer"),
        eq(SessionLegacyActivityAdmissionTable.activity_id, run.activityID),
        isNull(SessionSteerTable.consumed_seq),
        isNull(SessionSteerTable.superseded_at),
      ),
    )
    .all()
  if (rows.length === 0) return
  const ids = rows.map((row) => row.id)
  yield* tx
    .update(SessionIntentTable)
    .set({ execution_state: "canceled", execution_claim_id: null, execution_claimed_at: null })
    .where(
      and(
        eq(SessionIntentTable.session_id, run.sessionID),
        eq(SessionIntentTable.mutation_epoch, run.mutationEpoch),
        eq(SessionIntentTable.execution_mode, "run_now"),
        eq(SessionIntentTable.execution_state, "pending"),
        inArray(SessionIntentTable.admitted_message_id, ids),
      ),
    )
    .run()
  yield* tx
    .update(SessionSteerTable)
    .set({ superseded_at: now })
    .where(
      and(
        eq(SessionSteerTable.session_id, run.sessionID),
        eq(SessionSteerTable.mutation_epoch, run.mutationEpoch),
        isNull(SessionSteerTable.consumed_seq),
        isNull(SessionSteerTable.superseded_at),
        inArray(SessionSteerTable.id, ids),
      ),
    )
    .run()
})

function terminalRunState(state: ActivityTerminalState) {
  return state === "settled"
    ? ("completed" as const)
    : state === "failed"
      ? ("failed" as const)
      : state === "interrupted"
        ? ("interrupted" as const)
        : ("recovery_required" as const)
}

function terminalDecisionForProgress(
  decision: ActivityTerminalDecision,
  progressState: typeof SessionActivityProgressTable.$inferSelect.state,
): ActivityTerminalDecision {
  if (progressState === "recovery_required" && decision.state !== "recovery_required")
    return { ...decision, state: "recovery_required", reasonCode: "provider_outcome_indeterminate" }
  if (progressState === "interrupted" && decision.state !== "recovery_required" && decision.state !== "interrupted")
    return { ...decision, state: "interrupted", reasonCode: "provider_aborted" }
  return decision
}

export const recoverActiveActivities = Effect.fn("SessionPromptIntent.recoverActiveActivities")(function* (
  ownerToken = SessionActivityOwner.processOwnerToken,
  optionsOrRecover?:
    | {
        readonly includeCurrentOwner?: boolean
        readonly sessionID?: SessionID
        readonly source?: "restart_recovery" | "same_process_recovery"
        readonly recoverActivity?: (input: {
          readonly activityID: string
          readonly expectedVersion: number
          readonly terminalReason: string
        }) => Effect.Effect<boolean>
      }
    | ((input: {
        readonly activityID: string
        readonly expectedVersion: number
        readonly terminalReason: string
      }) => Effect.Effect<boolean>),
) {
  const { db } = yield* Database.Service
  const options = typeof optionsOrRecover === "function" ? undefined : optionsOrRecover
  const recoverActivity = typeof optionsOrRecover === "function" ? optionsOrRecover : optionsOrRecover?.recoverActivity
  const source = options?.source ?? "restart_recovery"
  const active = yield* db
    .select({
      activityID: SessionLegacyActivityTable.activity_id,
      sessionID: SessionLegacyActivityTable.session_id,
    })
    .from(SessionLegacyActivityTable)
    .where(
      and(
        eq(SessionLegacyActivityTable.state, "active"),
        options?.includeCurrentOwner ? undefined : sql`${SessionLegacyActivityTable.owner_token} != ${ownerToken}`,
        options?.sessionID ? eq(SessionLegacyActivityTable.session_id, options.sessionID) : undefined,
      ),
    )
    .all()
    .pipe(Effect.orDie)
  return yield* Effect.forEach(active, (activity) =>
    Effect.gen(function* () {
      const recoveryReason = "process restarted after activity owner loss"
      const objective = yield* db
        .select({ version: SessionActivityObjectiveTable.version, state: SessionActivityObjectiveTable.state })
        .from(SessionActivityObjectiveTable)
        .where(
          and(
            eq(SessionActivityObjectiveTable.activity_kind, "legacy"),
            eq(SessionActivityObjectiveTable.activity_id, activity.activityID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const permissionRecovered =
        objective && ["active", "needs_human"].includes(objective.state) && recoverActivity
          ? yield* recoverActivity({
              activityID: activity.activityID,
              expectedVersion: objective.version,
              terminalReason: recoveryReason,
            })
          : false
      if (objective && ["active", "needs_human"].includes(objective.state) && recoverActivity && !permissionRecovered)
        return undefined
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select({
                  activityID: SessionLegacyActivityTable.activity_id,
                  sessionID: SessionLegacyActivityTable.session_id,
                  ownerToken: SessionLegacyActivityTable.owner_token,
                  state: SessionLegacyActivityTable.state,
                  mutationEpoch: SessionIntentTable.mutation_epoch,
                  executionMode: SessionIntentTable.execution_mode,
                  executionState: SessionIntentTable.execution_state,
                })
                .from(SessionLegacyActivityTable)
                .innerJoin(
                  SessionActivityAdmissionTable,
                  eq(SessionActivityAdmissionTable.admission_id, SessionLegacyActivityTable.trigger_admission_id),
                )
                .innerJoin(
                  SessionIntentTable,
                  eq(SessionIntentTable.intent_id, SessionActivityAdmissionTable.legacy_intent_id),
                )
                .where(eq(SessionLegacyActivityTable.activity_id, activity.activityID))
                .get()
              if (
                !current ||
                (permissionRecovered ? current.state !== "recovery_required" : current.state !== "active")
              )
                return undefined
              const run = yield* tx
                .select()
                .from(SessionLegacyActivityRunTable)
                .where(eq(SessionLegacyActivityRunTable.activity_id, activity.activityID))
                .orderBy(sql`${SessionLegacyActivityRunTable.generation} DESC`)
                .get()
              if (!run && current.executionMode === "run_now" && current.executionState === "pending") return undefined
              const latest = yield* tx
                .select()
                .from(SessionActivityProgressTable)
                .where(eq(SessionActivityProgressTable.activity_id, activity.activityID))
                .orderBy(sql`${SessionActivityProgressTable.revision} DESC`)
                .get()
              const receipt = latest
                ? yield* tx
                    .select()
                    .from(SessionToolRequestReceiptTable)
                    .where(eq(SessionToolRequestReceiptTable.receipt_id, latest.provider_receipt_id))
                    .get()
                : yield* tx
                    .select({
                      receiptID: SessionToolRequestReceiptTable.receipt_id,
                      providerState: SessionToolRequestReceiptTable.provider_state,
                      requestErrorCode: SessionToolRequestReceiptTable.request_error_code,
                    })
                    .from(SessionToolRequestReceiptTable)
                    .innerJoin(
                      SessionActivityAdmissionTable,
                      eq(
                        SessionActivityAdmissionTable.admitted_message_id,
                        SessionToolRequestReceiptTable.user_message_id,
                      ),
                    )
                    .innerJoin(
                      SessionLegacyActivityAdmissionTable,
                      eq(SessionLegacyActivityAdmissionTable.admission_id, SessionActivityAdmissionTable.admission_id),
                    )
                    .where(eq(SessionLegacyActivityAdmissionTable.activity_id, activity.activityID))
                    .orderBy(sql`${SessionToolRequestReceiptTable.request_ordinal} DESC`)
                    .get()
              const receiptState = receipt
                ? "provider_state" in receipt
                  ? receipt.provider_state
                  : receipt.providerState
                : undefined
              const receiptID = receipt ? ("receipt_id" in receipt ? receipt.receipt_id : receipt.receiptID) : undefined
              const requestErrorCode = receipt
                ? "request_error_code" in receipt
                  ? receipt.request_error_code
                  : receipt.requestErrorCode
                : undefined
              const now = Date.now()
              if (run)
                yield* cancelPendingActivitySteers(
                  tx,
                  {
                    runID: run.run_id,
                    activityID: run.activity_id,
                    sessionID: SessionID.make(run.session_id),
                    mutationEpoch: run.mutation_epoch,
                    generation: run.generation,
                    ownerToken: run.owner_token,
                  },
                  now,
                )
              if (receiptID && ["preparing", "prepared"].includes(receiptState ?? ""))
                yield* tx
                  .update(SessionToolRequestReceiptTable)
                  .set({ provider_state: "failed", terminal_at: now, request_error_code: "pre_dispatch_owner_lost" })
                  .where(
                    and(
                      eq(SessionToolRequestReceiptTable.receipt_id, receiptID),
                      inArray(SessionToolRequestReceiptTable.provider_state, ["preparing", "prepared"] as const),
                    ),
                  )
                  .run()
              if (receiptID && ["dispatching", "streaming"].includes(receiptState ?? ""))
                yield* tx
                  .update(SessionToolRequestReceiptTable)
                  .set({
                    provider_state: "indeterminate_after_crash",
                    terminal_at: now,
                    request_error_code: "provider_outcome_indeterminate",
                  })
                  .where(
                    and(
                      eq(SessionToolRequestReceiptTable.receipt_id, receiptID),
                      inArray(SessionToolRequestReceiptTable.provider_state, ["dispatching", "streaming"] as const),
                    ),
                  )
                  .run()
              if (latest?.state === "provisional" && !receiptID)
                yield* tx
                  .update(SessionActivityProgressTable)
                  .set({
                    state: "recovery_required",
                    finish_observed: "provider_receipt_missing",
                    settled_at: now,
                  })
                  .where(
                    and(
                      eq(SessionActivityProgressTable.activity_id, activity.activityID),
                      eq(SessionActivityProgressTable.revision, latest.revision),
                      eq(SessionActivityProgressTable.state, "provisional"),
                    ),
                  )
                  .run()
              const settled =
                latest && receiptID
                  ? yield* settleProgressInTransaction(
                      tx,
                      {
                        activityID: activity.activityID,
                        assistantMessageID: MessageID.make(latest.assistant_message_id),
                      },
                      false,
                    )
                  : undefined
              const preDispatch =
                !receiptID ||
                ["preparing", "prepared"].includes(receiptState ?? "") ||
                requestErrorCode === "pre_dispatch_owner_lost" ||
                requestErrorCode === "provider_not_dispatched_before_process_restart"
              const terminalState = permissionRecovered
                ? ("recovery_required" as const)
                : !run
                  ? ("recovery_required" as const)
                  : preDispatch
                    ? ("failed" as const)
                    : ("recovery_required" as const)
              const reasonCode = permissionRecovered
                ? recoveryReason
                : !run
                  ? "legacy_run_identity_missing"
                  : preDispatch
                    ? "pre_dispatch_owner_lost"
                    : ["dispatching", "streaming", "indeterminate_after_crash"].includes(receiptState ?? "")
                      ? "provider_outcome_indeterminate"
                      : "host_terminal_decision_missing"
              const terminalRun = run && ["running", "finalizing"].includes(run.state)
              if (terminalRun)
                yield* tx
                  .update(SessionLegacyActivityRunTable)
                  .set({ state: terminalRunState(terminalState), terminal_at: now, terminal_reason: reasonCode })
                  .where(
                    and(
                      eq(SessionLegacyActivityRunTable.run_id, run.run_id),
                      inArray(SessionLegacyActivityRunTable.state, ["running", "finalizing"] as const),
                    ),
                  )
                  .run()
              const updated = permissionRecovered
                ? { activityID: activity.activityID }
                : yield* tx
                    .update(SessionLegacyActivityTable)
                    .set({ state: terminalState, terminal_reason: reasonCode, settled_at: now })
                    .where(
                      and(
                        eq(SessionLegacyActivityTable.activity_id, activity.activityID),
                        eq(SessionLegacyActivityTable.owner_token, current.ownerToken),
                        eq(SessionLegacyActivityTable.state, "active"),
                      ),
                    )
                    .returning({ activityID: SessionLegacyActivityTable.activity_id })
                    .get()
              if (!updated)
                return yield* Effect.die(new Error(`legacy activity recovery CAS lost: ${activity.activityID}`))
              if (!permissionRecovered)
                yield* settleMonitoringObjectiveInTransaction(
                  tx,
                  activity.activityID,
                  "recovery_required",
                  reasonCode,
                  now,
                )
              const membership = yield* tx
                .select({ ordinal: max(SessionLegacyActivityAdmissionTable.ordinal) })
                .from(SessionLegacyActivityAdmissionTable)
                .where(eq(SessionLegacyActivityAdmissionTable.activity_id, activity.activityID))
                .get()
              const terminalProgress = settled?.row ?? latest
              const terminalRunID =
                run && terminalRunState(terminalState) === run.state ? run.run_id : terminalRun ? run.run_id : null
              yield* tx
                .insert(SessionLegacyActivityTerminalTable)
                .values({
                  activity_id: activity.activityID,
                  session_id: current.sessionID,
                  mutation_epoch: current.mutationEpoch,
                  state: terminalState,
                  reason_code: reasonCode,
                  source,
                  operation_id: `legacy-activity-recovery:v1:${source}:${activity.activityID}`,
                  run_id: terminalRunID,
                  assistant_message_id: terminalProgress?.assistant_message_id ?? null,
                  progress_revision: terminalProgress?.revision ?? null,
                  membership_ordinal: terminalProgress?.input_membership_ordinal ?? membership?.ordinal ?? 0,
                  owner_token: current.ownerToken,
                  created_at: now,
                })
                .run()
              return {
                activityID: activity.activityID,
                sessionID: SessionID.make(current.sessionID),
                ...(terminalProgress
                  ? { assistantMessageID: MessageID.make(terminalProgress.assistant_message_id) }
                  : {}),
              } satisfies ProjectionInvalidation
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    }),
  ).pipe(Effect.map((activities) => activities.filter((activity) => activity !== undefined)))
})

export const interruptActivity = Effect.fn("SessionPromptIntent.interruptActivity")(function* (activityID: string) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const now = Date.now()
          const terminalReason = "aborted_before_provider_settlement"
          const updated = yield* tx
            .update(SessionLegacyActivityTable)
            .set({
              state: "interrupted",
              terminal_reason: terminalReason,
              settled_at: now,
            })
            .where(
              and(
                eq(SessionLegacyActivityTable.activity_id, activityID),
                eq(SessionLegacyActivityTable.state, "active"),
              ),
            )
            .returning({ sessionID: SessionLegacyActivityTable.session_id })
            .get()
          if (!updated) return
          yield* settleMonitoringObjectiveInTransaction(tx, activityID, "interrupted", terminalReason, now)
          const latest = yield* tx
            .select({ assistantMessageID: SessionActivityProgressTable.assistant_message_id })
            .from(SessionActivityProgressTable)
            .where(eq(SessionActivityProgressTable.activity_id, activityID))
            .orderBy(sql`${SessionActivityProgressTable.revision} DESC`)
            .get()
          return {
            activityID,
            sessionID: SessionID.make(updated.sessionID),
            ...(latest ? { assistantMessageID: MessageID.make(latest.assistantMessageID) } : {}),
          } satisfies ProjectionInvalidation
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export const retireDisabledSteerActivity = Effect.fn("SessionPromptIntent.retireDisabledSteerActivity")(function* (
  sessionID: SessionID,
) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const now = Date.now()
          const terminalReason = "steering_disabled_before_absorption"
          const activity = yield* tx
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
          if (!activity) return
          const updated = yield* tx
            .update(SessionLegacyActivityTable)
            .set({
              state: "interrupted",
              terminal_reason: terminalReason,
              settled_at: now,
            })
            .where(
              and(
                eq(SessionLegacyActivityTable.activity_id, activity.activityID),
                eq(SessionLegacyActivityTable.state, "active"),
              ),
            )
            .returning({ activityID: SessionLegacyActivityTable.activity_id })
            .get()
          if (!updated) return
          yield* settleMonitoringObjectiveInTransaction(tx, activity.activityID, "interrupted", terminalReason, now)
          const latest = yield* tx
            .select({ assistantMessageID: SessionActivityProgressTable.assistant_message_id })
            .from(SessionActivityProgressTable)
            .where(eq(SessionActivityProgressTable.activity_id, activity.activityID))
            .orderBy(sql`${SessionActivityProgressTable.revision} DESC`)
            .get()
          return {
            activityID: activity.activityID,
            sessionID,
            ...(latest ? { assistantMessageID: MessageID.make(latest.assistantMessageID) } : {}),
          } satisfies ProjectionInvalidation
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
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
