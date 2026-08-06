/**
 * Durable background-task notification delivery.
 *
 * The caller owns the parent SessionRunState reservation and injects the dedicated runLoop
 * callback. This module owns only the durable outbox/input/receipt protocol.
 */

import { Cause, Data, Effect, Schedule } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import {
  MessageTable,
  PartTable,
  SessionTable,
  TaskNotificationOutboxTable,
} from "@deepagent-code/core/session/sql"
import { Hash } from "@deepagent-code/core/util/hash"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm"
import { MessageID, PartID, SessionID } from "@/session/schema"

export type OutboxItem = {
  readonly id: string
  readonly runID: string
  readonly correlationID: string
  readonly messageID: MessageID
  readonly parentSessionID: SessionID
  readonly directory: string
  readonly payload: { readonly agent: string; readonly text: string; readonly variant?: string }
  readonly payloadHash: string
  readonly attempts: number
  readonly timeCreated: number
}

export class DeliveryConflictError extends Data.TaggedError("TaskDelivery.Conflict")<{
  readonly id: string
  readonly reason: string
  readonly fatal: boolean
}> {}

export function claimOutboxItem(input: {
  readonly ownerToken: string
  readonly directory: string
  readonly leaseMs?: number
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const expired = or(
      isNull(TaskNotificationOutboxTable.lease_expires_at),
      lte(TaskNotificationOutboxTable.lease_expires_at, now),
    )
    const claimable = or(
      eq(TaskNotificationOutboxTable.status, "pending"),
      and(inArray(TaskNotificationOutboxTable.status, ["admitting", "admitted"]), expired),
    )

    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const candidate = yield* tx
            .select()
            .from(TaskNotificationOutboxTable)
            .where(
              and(
                eq(TaskNotificationOutboxTable.directory, input.directory),
                lte(TaskNotificationOutboxTable.available_at, now),
                claimable,
              ),
            )
            .orderBy(asc(TaskNotificationOutboxTable.time_created), asc(TaskNotificationOutboxTable.id))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!candidate) return

          const updated = yield* tx
            .update(TaskNotificationOutboxTable)
            .set({
              status: "admitting",
              lease_owner: input.ownerToken,
              lease_expires_at: now + (input.leaseMs ?? 30_000),
              attempts: candidate.attempts + 1,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskNotificationOutboxTable.id, candidate.id),
                eq(TaskNotificationOutboxTable.attempts, candidate.attempts),
                claimable,
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!updated) return

          return {
            id: updated.id,
            runID: updated.run_id,
            correlationID: updated.correlation_id ?? updated.id,
            messageID: MessageID.make(updated.message_id),
            parentSessionID: SessionID.make(updated.parent_session_id),
            directory: updated.directory,
            payload: updated.payload,
            payloadHash: updated.payload_hash ?? Hash.sha256(JSON.stringify(updated.payload)),
            attempts: updated.attempts,
            timeCreated: updated.time_created,
          } satisfies OutboxItem
        }),
      { behavior: "immediate" },
    )
  })
}

export function releaseOutboxClaim(input: {
  readonly item: OutboxItem
  readonly ownerToken: string
  readonly delayMs?: number
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const updated = yield* db
      .update(TaskNotificationOutboxTable)
      .set({
        status: "pending",
        available_at: now + (input.delayMs ?? 1_000),
        lease_owner: null,
        lease_expires_at: null,
        time_updated: now,
      })
      .where(
        and(
          eq(TaskNotificationOutboxTable.id, input.item.id),
          eq(TaskNotificationOutboxTable.status, "admitting"),
          eq(TaskNotificationOutboxTable.lease_owner, input.ownerToken),
          eq(TaskNotificationOutboxTable.attempts, input.item.attempts),
          isNull(TaskNotificationOutboxTable.response_started_at),
        ),
      )
      .returning({ id: TaskNotificationOutboxTable.id })
      .get()
      .pipe(Effect.orDie)
    return updated !== undefined
  })
}

export function admitParentInput(input: {
  readonly item: OutboxItem
  readonly ownerToken: string
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const outbox = yield* tx
            .select()
            .from(TaskNotificationOutboxTable)
            .where(
              and(
                eq(TaskNotificationOutboxTable.id, input.item.id),
                eq(TaskNotificationOutboxTable.status, "admitting"),
                eq(TaskNotificationOutboxTable.lease_owner, input.ownerToken),
                eq(TaskNotificationOutboxTable.attempts, input.item.attempts),
                gt(TaskNotificationOutboxTable.lease_expires_at, now),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!outbox) {
            return yield* Effect.fail(
              new DeliveryConflictError({ id: input.item.id, reason: "input admission fence lost", fatal: false }),
            )
          }

          const parent = yield* tx
            .select({ agent: SessionTable.agent, model: SessionTable.model })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.item.parentSessionID))
            .get()
            .pipe(Effect.orDie)
          if (!parent) {
            return yield* Effect.fail(
              new DeliveryConflictError({ id: input.item.id, reason: "parent session is missing", fatal: true }),
            )
          }

          const history = parent.model
            ? []
            : yield* tx
                .select({ data: MessageTable.data })
                .from(MessageTable)
                .where(eq(MessageTable.session_id, input.item.parentSessionID))
                .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
                .all()
                .pipe(Effect.orDie)
          const model = parent.model
            ? { providerID: parent.model.providerID, modelID: parent.model.id, variant: parent.model.variant }
            : history.map((row) => modelFromMessage(row.data)).find((item) => item !== undefined)
          if (!model) {
            return yield* Effect.fail(
              new DeliveryConflictError({
                id: input.item.id,
                reason: "parent session model is unavailable",
                fatal: true,
              }),
            )
          }

          const messageData = {
            role: "user" as const,
            time: { created: input.item.timeCreated },
            agent: parent.agent ?? input.item.payload.agent,
            model: {
              providerID: ProviderV2.ID.make(model.providerID),
              modelID: ModelV2.ID.make(model.modelID),
              ...(input.item.payload.variant ?? model.variant
                ? { variant: input.item.payload.variant ?? model.variant }
                : {}),
            },
            metadata: {
              deepagent: {
                task_notification: {
                  run_id: input.item.runID,
                  outbox_id: input.item.id,
                  correlation_id: input.item.correlationID,
                  payload_hash: input.item.payloadHash,
                },
              },
            },
          } satisfies Omit<SessionV1.User, "id" | "sessionID">
          const partID = PartID.ascending(`prt_task_notify_${Hash.sha256(input.item.messageID).slice(0, 24)}`)
          const partData = {
            type: "text" as const,
            text: input.item.payload.text,
            synthetic: true,
          } satisfies Omit<SessionV1.TextPart, "id" | "messageID" | "sessionID">
          const existingMessage = yield* tx
            .select()
            .from(MessageTable)
            .where(eq(MessageTable.id, input.item.messageID))
            .get()
            .pipe(Effect.orDie)
          const existingPart = yield* tx
            .select()
            .from(PartTable)
            .where(eq(PartTable.id, partID))
            .get()
            .pipe(Effect.orDie)
          const exactMessage =
            existingMessage?.session_id === input.item.parentSessionID &&
            existingMessage.time_created === input.item.timeCreated &&
            JSON.stringify(existingMessage.data) === JSON.stringify(messageData)
          const exactPart =
            existingPart?.message_id === input.item.messageID &&
            existingPart.session_id === input.item.parentSessionID &&
            existingPart.time_created === input.item.timeCreated &&
            JSON.stringify(existingPart.data) === JSON.stringify(partData)
          if ((existingMessage && !exactMessage) || (existingPart && !exactPart) || Boolean(existingMessage) !== Boolean(existingPart)) {
            return yield* Effect.fail(
              new DeliveryConflictError({
                id: input.item.id,
                reason: "stable parent input IDs contain a conflicting envelope",
                fatal: true,
              }),
            )
          }

          if (!existingMessage) {
            yield* tx
              .insert(MessageTable)
              .values({
                id: input.item.messageID,
                session_id: input.item.parentSessionID,
                time_created: input.item.timeCreated,
                time_updated: input.item.timeCreated,
                data: messageData,
              })
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .insert(PartTable)
              .values({
                id: partID,
                message_id: input.item.messageID,
                session_id: input.item.parentSessionID,
                time_created: input.item.timeCreated,
                time_updated: input.item.timeCreated,
                data: partData,
              })
              .run()
              .pipe(Effect.orDie)
          }

          const updated = yield* tx
            .update(TaskNotificationOutboxTable)
            .set({
              status: "admitted",
              parent_input_message_id: input.item.messageID,
              time_admitted: outbox.time_admitted ?? now,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskNotificationOutboxTable.id, input.item.id),
                eq(TaskNotificationOutboxTable.status, "admitting"),
                eq(TaskNotificationOutboxTable.lease_owner, input.ownerToken),
                eq(TaskNotificationOutboxTable.attempts, input.item.attempts),
                gt(TaskNotificationOutboxTable.lease_expires_at, now),
              ),
            )
            .returning({ id: TaskNotificationOutboxTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!updated) {
            return yield* Effect.fail(
              new DeliveryConflictError({
                id: input.item.id,
                reason: "owner lost while committing parent input",
                fatal: false,
              }),
            )
          }
          return input.item.messageID
        }),
      { behavior: "immediate" },
    )
  })
}

export function findResponseReceipt(input: { readonly parentSessionID: SessionID; readonly parentInputID: MessageID }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ id: MessageTable.id, data: MessageTable.data })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, input.parentSessionID))
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .all()
      .pipe(Effect.orDie)
    const receipt = rows.find(
      (row) => isTerminalAssistantReceipt(row.data, input.parentInputID),
    )
    return receipt ? MessageID.make(receipt.id) : undefined
  })
}

export function acknowledgeDelivery(input: {
  readonly item: OutboxItem
  readonly ownerToken: string
  readonly responseMessageID: MessageID
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const updated = yield* db
      .update(TaskNotificationOutboxTable)
      .set({
        status: "delivered",
        response_message_id: input.responseMessageID,
        lease_owner: null,
        lease_expires_at: null,
        last_error: null,
        time_delivered: now,
        time_updated: now,
      })
      .where(
        and(
          eq(TaskNotificationOutboxTable.id, input.item.id),
          inArray(TaskNotificationOutboxTable.status, ["admitted", "processing"]),
          eq(TaskNotificationOutboxTable.lease_owner, input.ownerToken),
          eq(TaskNotificationOutboxTable.attempts, input.item.attempts),
          eq(TaskNotificationOutboxTable.parent_input_message_id, input.item.messageID),
          gt(TaskNotificationOutboxTable.lease_expires_at, now),
        ),
      )
      .returning({ id: TaskNotificationOutboxTable.id })
      .get()
      .pipe(Effect.orDie)
    return updated !== undefined
  })
}

export function renewProcessingLease(input: {
  readonly item: OutboxItem
  readonly ownerToken: string
  readonly leaseMs?: number
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const updated = yield* db
      .update(TaskNotificationOutboxTable)
      .set({
        lease_expires_at: now + (input.leaseMs ?? 30_000),
        time_updated: now,
      })
      .where(
        and(
          eq(TaskNotificationOutboxTable.id, input.item.id),
          eq(TaskNotificationOutboxTable.status, "processing"),
          eq(TaskNotificationOutboxTable.lease_owner, input.ownerToken),
          eq(TaskNotificationOutboxTable.attempts, input.item.attempts),
          gt(TaskNotificationOutboxTable.lease_expires_at, now),
        ),
      )
      .returning({ id: TaskNotificationOutboxTable.id })
      .get()
      .pipe(Effect.orDie)
    if (updated) return
    return yield* Effect.fail(
      new DeliveryConflictError({
        id: input.item.id,
        reason: "processing lease fence lost",
        fatal: false,
      }),
    )
  })
}

function markResponseRecovery(input: {
  readonly item: OutboxItem
  readonly ownerToken: string
  readonly error: string
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(TaskNotificationOutboxTable)
      .set({
        status: "response_recovery_required",
        last_error: input.error.slice(0, 4_000),
        lease_owner: null,
        lease_expires_at: null,
        time_updated: Date.now(),
      })
      .where(
        and(
          eq(TaskNotificationOutboxTable.id, input.item.id),
          eq(TaskNotificationOutboxTable.status, "processing"),
          eq(TaskNotificationOutboxTable.lease_owner, input.ownerToken),
          eq(TaskNotificationOutboxTable.attempts, input.item.attempts),
        ),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

function markInputConflict(input: {
  readonly item: OutboxItem
  readonly ownerToken: string
  readonly error: string
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(TaskNotificationOutboxTable)
      .set({
        status: "dead",
        last_error: input.error.slice(0, 4_000),
        lease_owner: null,
        lease_expires_at: null,
        time_updated: Date.now(),
      })
      .where(
        and(
          eq(TaskNotificationOutboxTable.id, input.item.id),
          inArray(TaskNotificationOutboxTable.status, ["admitting", "admitted"]),
          eq(TaskNotificationOutboxTable.lease_owner, input.ownerToken),
          eq(TaskNotificationOutboxTable.attempts, input.item.attempts),
          isNull(TaskNotificationOutboxTable.response_started_at),
        ),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

export function deliverOne(input: {
  readonly item: OutboxItem
  readonly ownerToken: string
  readonly driveParentLoop: () => Effect.Effect<SessionV1.WithParts, unknown, never>
  readonly leaseMs?: number
}) {
  return Effect.gen(function* () {
    const parentInputID = yield* admitParentInput({ item: input.item, ownerToken: input.ownerToken })
    const existingReceipt = yield* findResponseReceipt({
      parentSessionID: input.item.parentSessionID,
      parentInputID,
    })
    if (existingReceipt) {
      return yield* acknowledgeDelivery({
        item: input.item,
        ownerToken: input.ownerToken,
        responseMessageID: existingReceipt,
      })
    }

    const now = Date.now()
    const started = yield* (yield* Database.Service).db
      .update(TaskNotificationOutboxTable)
      .set({ status: "processing", response_started_at: now, time_updated: now })
      .where(
        and(
          eq(TaskNotificationOutboxTable.id, input.item.id),
          eq(TaskNotificationOutboxTable.status, "admitted"),
          eq(TaskNotificationOutboxTable.lease_owner, input.ownerToken),
          eq(TaskNotificationOutboxTable.attempts, input.item.attempts),
          gt(TaskNotificationOutboxTable.lease_expires_at, now),
          isNull(TaskNotificationOutboxTable.response_started_at),
        ),
      )
      .returning({ id: TaskNotificationOutboxTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!started) return false

    const leaseMs = input.leaseMs ?? 30_000
    const parentLoop = input.driveParentLoop().pipe(
      Effect.map((response) => ({ ok: true as const, response })),
    )
    const heartbeat = renewProcessingLease({
      item: input.item,
      ownerToken: input.ownerToken,
      leaseMs,
    }).pipe(
      Effect.repeat(Schedule.fixed(Math.max(10, Math.floor(leaseMs / 3)))),
      Effect.flatMap(() => Effect.never),
    )
    const responseResult = yield* Effect.raceFirst(parentLoop, heartbeat).pipe(
      Effect.catchCause((cause) => Effect.succeed({ ok: false as const, error: Cause.pretty(cause) })),
    )
    if (!responseResult.ok) {
      yield* markResponseRecovery({
        item: input.item,
        ownerToken: input.ownerToken,
        error: responseResult.error,
      })
      return false
    }
    const response = responseResult.response
    const persistedReceipt = yield* findResponseReceipt({
      parentSessionID: input.item.parentSessionID,
      parentInputID,
    })
    const validReceipt =
      response.info.role === "assistant" &&
      response.info.sessionID === input.item.parentSessionID &&
      response.info.parentID === parentInputID &&
      (response.info.time.completed !== undefined || response.info.error !== undefined) &&
      persistedReceipt === response.info.id
    if (!validReceipt) {
      yield* markResponseRecovery({
        item: input.item,
        ownerToken: input.ownerToken,
        error: "parent loop did not persist the exact terminal receipt for the admitted notification",
      })
      return false
    }
    return yield* acknowledgeDelivery({
      item: input.item,
      ownerToken: input.ownerToken,
      responseMessageID: response.info.id,
    })
  }).pipe(
    Effect.catchTag("TaskDelivery.Conflict", (error) =>
      error.fatal
        ? markInputConflict({
            item: input.item,
            ownerToken: input.ownerToken,
            error: error.reason,
          }).pipe(
            Effect.andThen(
              Effect.logError("TaskDelivery: input conflict", { id: error.id, reason: error.reason }),
            ),
            Effect.as(false),
          )
        : Effect.logWarning("TaskDelivery: claim lost before provider start", {
            id: error.id,
            reason: error.reason,
          }).pipe(Effect.as(false)),
    ),
    Effect.catchCause((cause) =>
      Effect.logError("TaskDelivery: delivery defect", {
        id: input.item.id,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(false)),
    ),
  )
}

export function reconcileExpiredProcessing(input: { readonly directory: string; readonly now?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const rows = yield* db
      .select()
      .from(TaskNotificationOutboxTable)
      .where(
        and(
          eq(TaskNotificationOutboxTable.directory, input.directory),
          eq(TaskNotificationOutboxTable.status, "processing"),
          or(isNull(TaskNotificationOutboxTable.lease_expires_at), lte(TaskNotificationOutboxTable.lease_expires_at, now)),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    return yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const receipt = row.parent_input_message_id
            ? yield* findResponseReceipt({
                parentSessionID: SessionID.make(row.parent_session_id),
                parentInputID: MessageID.make(row.parent_input_message_id),
              })
            : undefined
          yield* db
            .update(TaskNotificationOutboxTable)
            .set({
              status: receipt ? "delivered" : "response_recovery_required",
              response_message_id: receipt ?? null,
              lease_owner: null,
              lease_expires_at: null,
              ...(receipt ? { time_delivered: now } : { last_error: "response receipt is ambiguous after owner loss" }),
              time_updated: now,
            })
            .where(
              and(
                eq(TaskNotificationOutboxTable.id, row.id),
                eq(TaskNotificationOutboxTable.status, "processing"),
                eq(TaskNotificationOutboxTable.attempts, row.attempts),
                or(
                  isNull(TaskNotificationOutboxTable.lease_expires_at),
                  lte(TaskNotificationOutboxTable.lease_expires_at, now),
                ),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        }),
      { discard: true },
    )
  })
}

export function startDeliveryLoop(input: {
  readonly ownerToken: string
  readonly directory: string
  readonly deliver: (item: OutboxItem) => Effect.Effect<boolean, never, Database.Service>
  readonly intervalMs?: number
}) {
  const tick = reconcileExpiredProcessing({ directory: input.directory }).pipe(
    Effect.andThen(
      claimOutboxItem({ ownerToken: input.ownerToken, directory: input.directory }).pipe(
        Effect.flatMap((item) => (item ? input.deliver(item) : Effect.void)),
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logError("TaskDelivery: worker tick failed", { cause: Cause.pretty(cause) }),
    ),
  )
  return Effect.repeat(tick, Schedule.fixed(input.intervalMs ?? 1_000)).pipe(Effect.asVoid)
}

function modelFromMessage(data: unknown) {
  if (!data || typeof data !== "object" || !("role" in data) || data.role !== "user" || !("model" in data)) return
  if (!data.model || typeof data.model !== "object") return
  if (!("providerID" in data.model) || typeof data.model.providerID !== "string") return
  if (!("modelID" in data.model) || typeof data.model.modelID !== "string") return
  return {
    providerID: data.model.providerID,
    modelID: data.model.modelID,
    ...("variant" in data.model && typeof data.model.variant === "string" ? { variant: data.model.variant } : {}),
  }
}

function isTerminalAssistantReceipt(data: unknown, parentInputID: MessageID) {
  if (!data || typeof data !== "object") return false
  if (!("role" in data) || data.role !== "assistant") return false
  if (!("parentID" in data) || data.parentID !== parentInputID) return false
  if ("error" in data && data.error !== undefined) return true
  if (!("time" in data) || !data.time || typeof data.time !== "object") return false
  return "completed" in data.time && data.time.completed !== undefined
}

export * as TaskDelivery from "./task-delivery"
