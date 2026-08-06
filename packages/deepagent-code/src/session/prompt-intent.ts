import { Database } from "@deepagent-code/core/database/database"
import {
  MessageTable,
  PartTable,
  SessionIntentTable,
  SessionSteerTable,
  SessionTable,
} from "@deepagent-code/core/session/sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { and, eq, sql } from "drizzle-orm"
import { Data, Effect, Types } from "effect"
import { randomUUID } from "node:crypto"
import { MessageID, SessionID } from "./schema"
import { SessionMutationEpoch } from "./mutation-epoch"

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
          return fromRow(admitted)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
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
