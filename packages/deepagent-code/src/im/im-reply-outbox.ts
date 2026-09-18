export * as IMReplyOutbox from "./im-reply-outbox"

import { Cause, Effect, Layer, Option, Schedule, Duration } from "effect"
import { and, asc, eq, isNull, like, lte, or } from "drizzle-orm"
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import type { Payload } from "@deepagent-code/core/event"
import { IMRepository, type IMRepositoryInterface } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import type { IMBroadcaster } from "@deepagent-code/core/im/websocket"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { EventV2Bridge } from "@/event-v2-bridge"
import { IMAgentExecution } from "./im-agent-execution"
import * as Log from "@deepagent-code/core/util/log"

// V2 IM durable-only migration — the REPLY half of the slice. The terminal assistant reply of a
// settled IM session must reach the IM conversation DURABLY: the legacy path (promptOrSteer result →
// synchronous createMessage + broadcast) could lose the reply on a crash between the agent turn and
// the write, and the v4 bus path's normal-priority `tryPublish` could shed it under backpressure.
// This module owns the at-least-once chain:
//
//   settled session (session.execution.succeeded, or the periodic reconcile for downtime)
//     → collectSessionReply: read the terminal assistant message, APPEND an `im_reply_outbox` row
//       (idempotent on (session_id, reply_message_id) — a steer-coalesced activity has exactly one
//       terminal assistant message, so re-collection after a crash is a no-op)
//     → drainPass: claim (lease + attempts CAS, mirroring task_notification_outbox), deliver via
//       IMRepository.createMessage + WebSocket broadcast, then delivered | pending+backoff | dead.
//
// NOTHING is dropped silently: every failure increments `attempts` with `last_error` and backs off
// (`replyBackoffMs`); after `IM_REPLY_MAX_ATTEMPTS` the row settles `dead` with the terminal error
// logged — visible in the table, never vanished.

const log = Log.create({ service: "im-reply-outbox" })

/** The drizzle edge over the migration-created table (migration: 20260918120000_im_reply_outbox). */
export const IMReplyOutboxTable = sqliteTable(
  "im_reply_outbox",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    group_id: text().notNull(),
    agent_id: text().notNull(),
    trigger_message_id: text(),
    reply_message_id: text().notNull(),
    reply_text: text().notNull(),
    status: text().$type<ReplyStatus>().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    available_at: integer().notNull().default(0),
    lease_owner: text(),
    lease_expires_at: integer(),
    last_error: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_delivered: integer(),
  },
  (table) => [
    index("im_reply_outbox_due_idx").on(table.status, table.available_at, table.lease_expires_at),
    uniqueIndex("im_reply_outbox_session_reply_idx").on(table.session_id, table.reply_message_id),
  ],
)

export type ReplyStatus = "pending" | "delivering" | "delivered" | "dead"

/** Terminal attempt cap before the row settles `dead` (logged; admin-visible, never vanished). */
export const IM_REPLY_MAX_ATTEMPTS = 8

/** Exponential delivery backoff: 1s, 2s, 4s … capped at 60s. */
export const IM_REPLY_BACKOFF_BASE_MS = 1_000
export const IM_REPLY_BACKOFF_CAP_MS = 60_000
export const replyBackoffMs = (attempts: number): number =>
  Math.min(IM_REPLY_BACKOFF_CAP_MS, IM_REPLY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))

/** Delivery claim lease: a crashed deliverer's row is reclaimable once this lapses. */
export const IM_REPLY_LEASE_MS = 30_000

export interface AppendReplyInput {
  readonly sessionID: string
  readonly groupID: string
  readonly agentID: string
  /** The session input message id that seeded the settled activity (traceability). */
  readonly triggerMessageID?: string
  readonly replyMessageID: string
  readonly replyText: string
  readonly now: number
}

/** Deterministic outbox row id — the (session, reply) identity, hashed into an id-shaped string. */
export const replyOutboxID = (sessionID: string, replyMessageID: string) =>
  `imo_${contentDigest(`${sessionID}:${replyMessageID}`).slice(0, 24)}`

/**
 * Append one reply row. Idempotent: the UNIQUE (session_id, reply_message_id) index + ON CONFLICT DO
 * NOTHING make a re-collection of the same terminal assistant message a no-op. Returns whether the
 * row was newly appended.
 */
export function appendReply(db: Database.Interface["db"], input: AppendReplyInput) {
  return Effect.gen(function* () {
    const row = yield* db
      .insert(IMReplyOutboxTable)
      .values({
        id: replyOutboxID(input.sessionID, input.replyMessageID),
        session_id: input.sessionID,
        group_id: input.groupID,
        agent_id: input.agentID,
        trigger_message_id: input.triggerMessageID ?? null,
        reply_message_id: input.replyMessageID,
        reply_text: input.replyText,
        status: "pending",
        attempts: 0,
        available_at: 0,
        time_created: input.now,
        time_updated: input.now,
      })
      .onConflictDoNothing({ target: [IMReplyOutboxTable.session_id, IMReplyOutboxTable.reply_message_id] })
      .returning({ id: IMReplyOutboxTable.id })
      .get()
      .pipe(Effect.orDie)
    return row !== undefined
  })
}

export interface ClaimedReply {
  readonly id: string
  readonly sessionID: string
  readonly groupID: string
  readonly agentID: string
  readonly replyText: string
  readonly attempts: number
}

const claimable = (now: number) =>
  or(
    eq(IMReplyOutboxTable.status, "pending"),
    and(
      eq(IMReplyOutboxTable.status, "delivering"),
      or(isNull(IMReplyOutboxTable.lease_expires_at), lte(IMReplyOutboxTable.lease_expires_at, now)),
    ),
  )

/**
 * Claim the oldest due row (FIFO by creation). The claim is a CAS on (status, attempts) under a
 * lease — `delivering` rows whose lease lapsed are reclaimed (crash recovery), a live lease is not.
 * Returns undefined when nothing is due.
 */
export function claimDueReply(db: Database.Interface["db"], input: { readonly ownerToken: string; readonly now?: number; readonly leaseMs?: number }) {
  return Effect.gen(function* () {
    const now = input.now ?? Date.now()
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const candidate = yield* tx
          .select()
          .from(IMReplyOutboxTable)
          .where(and(lte(IMReplyOutboxTable.available_at, now), claimable(now)))
          .orderBy(asc(IMReplyOutboxTable.time_created), asc(IMReplyOutboxTable.id))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (!candidate) return

        const updated = yield* tx
          .update(IMReplyOutboxTable)
          .set({
            status: "delivering",
            lease_owner: input.ownerToken,
            lease_expires_at: now + (input.leaseMs ?? IM_REPLY_LEASE_MS),
            attempts: candidate.attempts + 1,
            time_updated: now,
          })
          .where(
            and(
              eq(IMReplyOutboxTable.id, candidate.id),
              eq(IMReplyOutboxTable.status, candidate.status),
              eq(IMReplyOutboxTable.attempts, candidate.attempts),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!updated) return

        return {
          id: updated.id,
          sessionID: updated.session_id,
          groupID: updated.group_id,
          agentID: updated.agent_id,
          replyText: updated.reply_text,
          attempts: updated.attempts,
        } satisfies ClaimedReply
      }),
    )
  })
}

const leaseHeld = (id: string, ownerToken: string, attempts: number) =>
  and(
    eq(IMReplyOutboxTable.id, id),
    eq(IMReplyOutboxTable.status, "delivering"),
    eq(IMReplyOutboxTable.lease_owner, ownerToken),
    eq(IMReplyOutboxTable.attempts, attempts),
  )

/** Settle a claimed row as delivered. CAS-fenced: a lost lease is a no-op (returns false). */
export function markDelivered(db: Database.Interface["db"], input: { readonly item: ClaimedReply; readonly ownerToken: string; readonly now?: number }) {
  return Effect.gen(function* () {
    const now = input.now ?? Date.now()
    const updated = yield* db
      .update(IMReplyOutboxTable)
      .set({ status: "delivered", lease_owner: null, lease_expires_at: null, time_updated: now, time_delivered: now })
      .where(leaseHeld(input.item.id, input.ownerToken, input.item.attempts))
      .returning({ id: IMReplyOutboxTable.id })
      .get()
      .pipe(Effect.orDie)
    return updated !== undefined
  })
}

/**
 * Record a failed delivery attempt: back off (`replyBackoffMs` keyed on the incremented attempt
 * count) and re-queue, or settle `dead` at the cap. CAS-fenced on the lease; returns the row's
 * resulting status ("pending" | "dead") or undefined when the fence was lost.
 */
export function failReplyAttempt(
  db: Database.Interface["db"],
  input: { readonly item: ClaimedReply; readonly ownerToken: string; readonly reason: string; readonly now?: number },
) {
  return Effect.gen(function* () {
    const now = input.now ?? Date.now()
    const dead = input.item.attempts >= IM_REPLY_MAX_ATTEMPTS
    const updated = yield* db
      .update(IMReplyOutboxTable)
      .set({
        status: dead ? "dead" : "pending",
        available_at: now + replyBackoffMs(input.item.attempts),
        lease_owner: null,
        lease_expires_at: null,
        last_error: input.reason,
        time_updated: now,
      })
      .where(leaseHeld(input.item.id, input.ownerToken, input.item.attempts))
      .returning({ status: IMReplyOutboxTable.status })
      .get()
      .pipe(Effect.orDie)
    if (updated?.status === "dead")
      log.error("im reply delivery dead-lettered", {
        outboxID: input.item.id,
        groupID: input.item.groupID,
        sessionID: input.item.sessionID,
        attempts: input.item.attempts,
        lastError: input.reason,
      })
    return updated?.status
  })
}

// ── Terminal-reply collection ────────────────────────────────────────────────────────────────────

/** The joined text parts of an assistant message, or undefined when it has none (tool-only turn). */
const assistantText = (message: SessionMessage.Message): string | undefined => {
  if (message.type !== "assistant") return undefined
  const text = message.content
    .filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text.length > 0 ? text : undefined
}

export interface CollectDeps {
  readonly db: Database.Interface["db"]
  readonly v2Session: SessionV2.Interface
}

/**
 * Collect the terminal assistant reply of one IM session into the outbox. Reads the session's IM
 * metadata binding (group + agent — non-IM sessions are skipped), the newest assistant message with
 * text (the terminal reply of the settled activity), and the newest user input older than it (the
 * activity's trigger). Appending is idempotent per (session, assistant message), so this is safe to
 * re-run on every settle signal AND on every reconcile pass.
 */
export function collectSessionReply(deps: CollectDeps, sessionID: string, now?: number) {
  return Effect.gen(function* () {
    const info = yield* deps.v2Session.get(SessionV2.ID.make(sessionID)).pipe(Effect.option)
    if (Option.isNone(info)) return false
    const meta = IMAgentExecution.imSessionMetadata(info.value)
    if (!meta) return false

    // Newest-first: the first assistant IS the terminal reply; the first user message after it is
    // the trigger input that seeded the activity.
    const messages = yield* deps.v2Session
      .messages({ sessionID: SessionV2.ID.make(sessionID), order: "desc", limit: 50 })
      .pipe(Effect.orElseSucceed(() => [] as const))
    const terminal = messages.findIndex((message) => assistantText(message) !== undefined)
    if (terminal < 0) return false
    const trigger = messages
      .slice(terminal + 1)
      .find((message) => message.type === "user")

    return yield* appendReply(deps.db, {
      sessionID,
      groupID: meta.groupID,
      agentID: meta.agent,
      ...(trigger ? { triggerMessageID: trigger.id } : {}),
      replyMessageID: messages[terminal]!.id,
      replyText: assistantText(messages[terminal]!)!,
      now: now ?? Date.now(),
    })
  })
}

/** All IM sessions (the stable `ses_im_` identity lane) known to the durable session table. The
 * LIKE `_` wildcard may over-match a handful of non-IM ids; `imSessionMetadata` fail-closes those. */
export function imSessionIDs(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(like(SessionTable.id, "ses_im_%"))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => row.id)
  })
}

/** One reconcile pass: collect every IM session's pending terminal reply. The durability backstop
 * for settle signals missed while the process was down or between listener wiring. */
export function reconcileReplies(deps: CollectDeps, now?: number) {
  return Effect.gen(function* () {
    const ids = yield* imSessionIDs(deps.db)
    for (const id of ids) yield* collectSessionReply(deps, id, now).pipe(Effect.ignore)
  })
}

// ── Delivery ─────────────────────────────────────────────────────────────────────────────────────

export interface DeliveryDeps {
  readonly db: Database.Interface["db"]
  readonly repo: IMRepositoryInterface
  readonly broadcaster: IMBroadcaster
}

/** The delivery side effect: persist the reply as a real agent IM message + broadcast it (the same
 * surfaces the legacy orchestrator wrote), keyed on `metadata.type = "agent_run"`. */
export function deliverReply(deps: DeliveryDeps, item: ClaimedReply) {
  return Effect.gen(function* () {
    const message = yield* deps.repo.createMessage({
      groupID: item.groupID,
      senderID: item.agentID,
      senderType: "agent",
      type: "text",
      content: item.replyText,
      mentions: [],
      metadata: { type: "agent_run", sessionID: item.sessionID, status: "success" },
    })
    deps.broadcaster.broadcast(item.groupID, {
      type: "message_created",
      data: {
        id: message.id,
        groupID: message.groupID,
        senderID: message.senderID,
        senderType: message.senderType,
        messageType: message.type,
        content: message.content,
        mentions: message.mentions,
        metadata: message.metadata,
        replyToID: message.replyToID,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    })
    return message
  })
}

/**
 * Drain due outbox rows to termination: claim → deliver → settle. A delivery failure backs off and
 * the row stays pending (or dead-letters at the cap) — the pass never drops a reply. Loop bounded by
 * `maxClaims` so one pass cannot spin forever on a pathological re-queue race.
 */
export function drainPass(deps: DeliveryDeps, options?: { readonly now?: number; readonly maxClaims?: number }) {
  return Effect.gen(function* () {
    const ownerToken = `im-reply-outbox:${process.pid}:${Math.random().toString(36).slice(2)}`
    let delivered = 0
    for (let i = 0; i < (options?.maxClaims ?? 32); i++) {
      const item = yield* claimDueReply(deps.db, { ownerToken, ...(options?.now !== undefined ? { now: options.now } : {}) })
      if (!item) break
      const outcome = yield* deliverReply(deps, item).pipe(
        Effect.as("ok" as const),
        Effect.catchCause((cause) => Effect.succeed(Cause.squash(cause))),
      )
      if (outcome === "ok") {
        yield* markDelivered(deps.db, { item, ownerToken, ...(options?.now !== undefined ? { now: options.now } : {}) })
        delivered++
      } else {
        yield* failReplyAttempt(deps.db, {
          item,
          ownerToken,
          reason: outcome instanceof Error ? outcome.message : String(outcome),
          ...(options?.now !== undefined ? { now: options.now } : {}),
        })
      }
    }
    return delivered
  })
}

// ── The daemon ───────────────────────────────────────────────────────────────────────────────────

/** How often the reconcile backstop runs (collect + drain), independent of settle signals. */
export const IM_REPLY_RECONCILE_INTERVAL_MS = 5_000

const isIMSessionSettle = (event: Payload): string | undefined => {
  if (event.type !== SessionEvent.Execution.Succeeded.type) return undefined
  const sessionID = (event.data as { readonly sessionID?: unknown }).sessionID
  return typeof sessionID === "string" && sessionID.startsWith("ses_im_") ? sessionID : undefined
}

/**
 * The production daemon: a post-commit EventV2 listener collects + drains on every IM session
 * settle (low latency), and a periodic reconcile pass covers settles missed while the process was
 * down (durability). Merged into the server's IM runtime layer; scoped fibers stop with the layer.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const v2Session = yield* SessionV2.Service
    const repo = yield* IMRepository
    const broadcaster = yield* IMBroadcasterService
    const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service))
    const deps = { db, v2Session }
    const delivery = { db, repo, broadcaster }
    // The listener callback runs with R = never (EventV2.Listener), so the drain fiber is forked
    // into THIS layer's scope explicitly — post-commit collect+drain never delays the publisher.
    const scope = yield* Effect.scope

    if (events) {
      yield* events.listen((event) => {
        const sessionID = isIMSessionSettle(event)
        if (!sessionID) return Effect.void
        return collectSessionReply(deps, sessionID)
          .pipe(
            Effect.andThen(drainPass(delivery)),
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("im reply settle drain failed", { sessionID, cause: Cause.pretty(cause) })),
            ),
            Effect.forkIn(scope),
            Effect.asVoid,
          )
      })
    }

    yield* reconcileReplies(deps)
      .pipe(
        Effect.andThen(drainPass(delivery)),
        Effect.catchCause((cause) => Effect.sync(() => log.error("im reply reconcile pass failed", { cause: Cause.pretty(cause) }))),
        Effect.repeat(Schedule.spaced(Duration.millis(IM_REPLY_RECONCILE_INTERVAL_MS))),
        Effect.forkScoped,
      )
  }),
)
