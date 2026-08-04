/**
 * TaskDelivery — background task notification delivery.
 *
 * Design: subagent-control-plane-design.zh-CN.md §3.7
 *
 * Three durable phases per outbox item:
 *   1. reserve_parent_turn — claim the outbox item
 *   2. admit_parent_input  — write stable parent synthetic user message
 *   3. drive_parent_loop   — run parent SessionPrompt.loop and record response receipt
 *
 * Invariants:
 *   - correlation_id is the stable idempotency key per run
 *   - outbox ack must not precede assistant response receipt
 *   - response_started_at after commit: if process dies, enters response_recovery_required
 *   - never re-calls provider after response receipt exists
 */

import { Cause, Data, Effect, Schedule } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import {
  TaskNotificationOutboxTable,
  MessageTable,
  PartTable,
} from "@deepagent-code/core/session/sql"
import { Hash } from "@deepagent-code/core/util/hash"
import { and, eq, isNull, lte, or } from "drizzle-orm"
import { Identifier } from "@/id/id"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionPrompt } from "./prompt"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutboxItem = {
  readonly id: string
  readonly runID: string
  readonly correlationID: string
  readonly parentSessionID: SessionID
  readonly directory: string
  readonly payload: { readonly agent: string; readonly text: string; variant?: string }
  readonly payloadHash: string
}

// ---------------------------------------------------------------------------
// claimOutboxItem — lease an outbox item for delivery
// ---------------------------------------------------------------------------

export function claimOutboxItem(input: {
  readonly ownerToken: string
  readonly directory: string
  readonly leaseMs?: number
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const leaseUntil = now + (input.leaseMs ?? 30_000)

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
                or(
                  eq(TaskNotificationOutboxTable.status, "pending"),
                  and(
                    eq(TaskNotificationOutboxTable.status, "admitting"),
                    or(
                      isNull(TaskNotificationOutboxTable.lease_expires_at),
                      lte(TaskNotificationOutboxTable.lease_expires_at, now),
                    ),
                  ),
                ),
              ),
            )
            .limit(1)
            .get()
            .pipe(Effect.orDie)

          if (!candidate) return undefined

          // Skip items already with response recovery needed
          if (candidate.status === "response_recovery_required") return undefined

          const updated = yield* tx
            .update(TaskNotificationOutboxTable)
            .set({
              status: "admitting",
              lease_owner: input.ownerToken,
              lease_expires_at: leaseUntil,
              attempts: (candidate.attempts ?? 0) + 1,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskNotificationOutboxTable.id, candidate.id),
                or(
                  eq(TaskNotificationOutboxTable.status, "pending"),
                  and(
                    eq(TaskNotificationOutboxTable.status, "admitting"),
                    or(
                      isNull(TaskNotificationOutboxTable.lease_expires_at),
                      lte(TaskNotificationOutboxTable.lease_expires_at, now),
                    ),
                  ),
                ),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)

          if (!updated) return undefined

          return {
            id: updated.id,
            runID: updated.run_id,
            correlationID: updated.correlation_id ?? updated.id,
            parentSessionID: SessionID.make(updated.parent_session_id),
            directory: updated.directory,
            payload: updated.payload as OutboxItem["payload"],
            payloadHash: updated.payload_hash ?? Hash.sha256(JSON.stringify(updated.payload)),
          } satisfies OutboxItem
        }),
      { behavior: "immediate" },
    )
  })
}

// ---------------------------------------------------------------------------
// admitParentInput — write stable synthetic parent user message
// ---------------------------------------------------------------------------

export function admitParentInput(input: {
  readonly item: OutboxItem
  readonly ownerToken: string
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    // Check if already admitted (exact replay)
    const existing = yield* db
      .select({ parent_input_message_id: TaskNotificationOutboxTable.parent_input_message_id })
      .from(TaskNotificationOutboxTable)
      .where(eq(TaskNotificationOutboxTable.id, input.item.id))
      .get()
      .pipe(Effect.orDie)

    if (existing?.parent_input_message_id) {
      return MessageID.make(existing.parent_input_message_id)
    }

    const messageID = MessageID.ascending()
    const partID = PartID.ascending()
    const notificationText = input.item.payload.text

    // Write synthetic parent input message
    // C-4 (P1-2): read the UPDATE result to detect owner loss; on 0 rows → return undefined
    let ownerLost = false
    yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          yield* tx
            .insert(MessageTable)
            .values({
              id: messageID,
              session_id: input.item.parentSessionID as any,
              time_created: now,
              time_updated: now,
              data: {
                role: "user",
                providerID: "task_notification",
                // C-4 (P1-2): metadata is already an object — do NOT JSON.stringify here.
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
              } as any,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)

          yield* tx
            .insert(PartTable)
            .values({
              id: partID,
              message_id: messageID,
              session_id: input.item.parentSessionID as any,
              time_created: now,
              time_updated: now,
              data: { type: "text", text: notificationText, synthetic: true } as any,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)

          // C-4 (P1-2): check affected rows to detect stale owner
          const outboxUpdated = yield* tx
            .update(TaskNotificationOutboxTable)
            .set({
              status: "admitted",
              parent_input_message_id: messageID,
              time_admitted: now,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskNotificationOutboxTable.id, input.item.id),
                eq(TaskNotificationOutboxTable.lease_owner, input.ownerToken),
              ),
            )
            .returning({ id: TaskNotificationOutboxTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!outboxUpdated) ownerLost = true
        }),
    ).pipe(
      Effect.catchCause(() =>
        Effect.sync(() => { ownerLost = true }),
      ),
    )

    if (ownerLost) {
      yield* Effect.logWarning("admitParentInput: owner lease lost or transaction failed", {
        id: input.item.id,
      })
      return undefined as MessageID | undefined
    }

    return messageID as MessageID | undefined
  })
}

// ---------------------------------------------------------------------------
// acknowledgeDelivery — mark outbox item as delivered after response receipt
// ---------------------------------------------------------------------------

export function acknowledgeDelivery(input: {
  readonly id: string
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
        time_delivered: now,
        time_updated: now,
      })
      .where(
        and(
          eq(TaskNotificationOutboxTable.id, input.id),
          eq(TaskNotificationOutboxTable.lease_owner, input.ownerToken),
        ),
      )
      .returning({ id: TaskNotificationOutboxTable.id })
      .get()
      .pipe(Effect.orDie)

    return updated !== undefined
  })
}

// ---------------------------------------------------------------------------
// deliverOne — full delivery lifecycle for one outbox item
// Design §3.7
// ---------------------------------------------------------------------------

export function deliverOne(input: {
  readonly item: OutboxItem
  readonly ownerToken: string
}): Effect.Effect<boolean, never, Database.Service | SessionPrompt.Service> {
  return Effect.gen(function* () {
    const sessionPrompt = yield* SessionPrompt.Service
    const now = Date.now()

    // Phase 2: admit parent input message
    const parentInputID = yield* admitParentInput({
      item: input.item,
      ownerToken: input.ownerToken,
      now,
    }).pipe(Effect.orElseSucceed(() => undefined as MessageID | undefined))

    if (!parentInputID) return false

    // Mark response started (before calling provider)
    yield* (yield* Database.Service).db
      .update(TaskNotificationOutboxTable)
      .set({
        status: "processing",
        response_started_at: Date.now(),
        time_updated: Date.now(),
      })
      .where(
        and(
          eq(TaskNotificationOutboxTable.id, input.item.id),
          eq(TaskNotificationOutboxTable.lease_owner, input.ownerToken),
        ),
      )
      .run()
      .pipe(Effect.orDie)

    // Phase 3: drive parent loop and record response
    const loopResult = yield* sessionPrompt
      .loop({ sessionID: input.item.parentSessionID })
      .pipe(
        Effect.map((msg) => ({ ok: true as const, responseID: msg.info.id })),
        Effect.catchCause((cause) =>
          Effect.logWarning("TaskDelivery: parent loop failed", {
            outboxID: input.item.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ ok: false as const, responseID: undefined })),
        ),
      )

    if (!loopResult.ok) {
      // Mark response_recovery_required — do NOT retry automatically
      yield* (yield* Database.Service).db
        .update(TaskNotificationOutboxTable)
        .set({ status: "response_recovery_required", time_updated: Date.now() })
        .where(eq(TaskNotificationOutboxTable.id, input.item.id))
        .run()
        .pipe(Effect.orDie)
      return false
    }

    // Phase 3 complete: acknowledge delivery
    yield* acknowledgeDelivery({
      id: input.item.id,
      ownerToken: input.ownerToken,
      responseMessageID: loopResult.responseID,
    })

    return true
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("TaskDelivery: deliverOne error", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(false),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// startDeliveryLoop — daemon that drains the notification outbox
// ---------------------------------------------------------------------------

export function startDeliveryLoop(input: {
  readonly ownerToken: string
  readonly directory: string
  readonly intervalMs?: number
}) {
  const tick = Effect.gen(function* () {
    const item = yield* claimOutboxItem({
      ownerToken: input.ownerToken,
      directory: input.directory,
    }).pipe(Effect.orElseSucceed(() => undefined as OutboxItem | undefined))

    if (item) {
      yield* deliverOne({ item, ownerToken: input.ownerToken }).pipe(Effect.ignore)
    }
  })

  return Effect.repeat(tick, Schedule.fixed(input.intervalMs ?? 1_000)).pipe(Effect.asVoid)
}

export * as TaskDelivery from "./task-delivery"
