export * as IMReplyOutbox from "./im-reply-outbox"

import { Cause, Effect, Layer, Option, Ref, Schedule, Duration } from "effect"
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm"
import { IMReplyOutboxTable } from "@deepagent-code/core/im/reply-outbox.sql"
import { ReplyBodyRetirement } from "@deepagent-code/core/im/reply-body-retirement"
import { ReplyParts } from "@deepagent-code/core/im/reply-parts"
import { ReplyBodyRetirementModel } from "@deepagent-code/core/im/reply-body-retirement.model"
export { IMReplyOutboxTable } from "@deepagent-code/core/im/reply-outbox.sql"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionActivityInputTable, SessionActivityTable } from "@deepagent-code/core/context-federation/session-sql"
import type { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { IMDacBindingTable, IMDacCommandTable } from "@deepagent-code/core/im/dac-session.sql"
import { IMDacSession } from "@deepagent-code/core/im/dac-session"
import { IMKernelReaderProjectionTable, IMKernelReaderScopeTable } from "@deepagent-code/core/im/kernel-reader.sql"
import { IMKernelDeliveryTable } from "@deepagent-code/core/im/kernel-delivery.sql"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { createHash } from "node:crypto"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import type { Payload } from "@deepagent-code/core/event"
import { IMRepository, type IMRepositoryInterface } from "@deepagent-code/core/im/repository"
import type { IMMessage } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import type { IMBroadcaster } from "@deepagent-code/core/im/websocket"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { ReplyDeliveryID } from "@deepagent-code/core/im/reply-delivery-id"
import { EventV2Bridge } from "@/event-v2-bridge"
import { IMKernelSync } from "@/im/kernel/sync"
import { IMFacade } from "./facade"
import { Log } from "@deepagent-code/core/util/log"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"

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
  readonly id?: string
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
  return db.transaction((tx) => appendReplyInTransaction(tx, input), {behavior:"immediate"})
}

function appendReplyInTransaction(tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0], input: AppendReplyInput) {
  return Effect.gen(function* () {
    const id = input.id ?? replyOutboxID(input.sessionID, input.replyMessageID)
    const existing = yield* tx.select().from(IMReplyOutboxTable).where(or(eq(IMReplyOutboxTable.id,id),
      and(eq(IMReplyOutboxTable.session_id,input.sessionID),eq(IMReplyOutboxTable.reply_message_id,input.replyMessageID)))).limit(2).all()
    if (existing.length) {
      if (existing.length!==1) return yield* ReplyBodyRetirementModel.invalid()
      const value = yield* ReplyBodyRetirement.read(tx,existing[0]!.id)
      if (value.outbox.id!==id || value.outbox.session_id!==input.sessionID || value.outbox.reply_message_id!==input.replyMessageID ||
        value.outbox.group_id!==input.groupID || value.outbox.agent_id!==input.agentID || value.outbox.trigger_message_id!==(input.triggerMessageID??null) ||
        value.record.origin.replyHash!==ReplyBodyRetirementModel.bodyHash(input.replyText) || value.record.origin.replyBytes!==ReplyBodyRetirementModel.utf8(input.replyText))
        return yield* ReplyBodyRetirementModel.invalid()
      return false
    }
    yield* tx.insert(IMReplyOutboxTable).values({id,delivery_message_id:ReplyDeliveryID.fromOutbox(id),session_id:input.sessionID,
      group_id:input.groupID,agent_id:input.agentID,trigger_message_id:input.triggerMessageID??null,reply_message_id:input.replyMessageID,
      reply_text:input.replyText,status:"pending",attempts:0,available_at:0,time_created:input.now,time_updated:input.now}).run()
    yield* ReplyBodyRetirement.initialize(tx,id)
    return true
  })
}

export interface ClaimedReply {
  readonly id: string
  readonly sessionID: string
  readonly groupID: string
  readonly agentID: string
  readonly replyText: string
  readonly triggerMessageID?: string | null
  readonly replyMessageID?: string
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
export function claimDueReply(
  db: Database.Interface["db"],
  input: { readonly ownerToken: string; readonly now?: number; readonly leaseMs?: number },
) {
  return Effect.gen(function* () {
    const now = input.now ?? Date.now()
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const candidate = yield* tx
          .select()
          .from(IMReplyOutboxTable)
          .where(and(eq(IMReplyOutboxTable.body_state,"live"), sql`EXISTS(SELECT 1 FROM im_reply_body b WHERE b.outbox_id=${IMReplyOutboxTable.id} AND b.origin_kind='dac_session')`,
            sql`NOT EXISTS(SELECT 1 FROM im_reply_outbox previous WHERE instr(${IMReplyOutboxTable.reply_message_id},'_impart_')>0
              AND previous.session_id=${IMReplyOutboxTable.session_id} AND previous.status<>'delivered'
              AND substr(previous.reply_message_id,1,instr(previous.reply_message_id,'_impart_'))=substr(${IMReplyOutboxTable.reply_message_id},1,instr(${IMReplyOutboxTable.reply_message_id},'_impart_'))
              AND previous.reply_message_id<${IMReplyOutboxTable.reply_message_id})`, lte(IMReplyOutboxTable.available_at, now), claimable(now)))
          .orderBy(asc(IMReplyOutboxTable.time_created), asc(IMReplyOutboxTable.reply_message_id), asc(IMReplyOutboxTable.id))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (!candidate) return
        const custody = yield* ReplyBodyRetirement.read(tx,candidate.id)
        if (custody.record.origin.kind==="legacy_unbound") return yield* ReplyBodyRetirementModel.invalid()

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
        yield* ReplyBodyRetirement.refresh(tx,updated.id)

        return {
          id: updated.id,
          sessionID: updated.session_id,
          groupID: updated.group_id,
          agentID: updated.agent_id,
          replyText: updated.reply_text,
          triggerMessageID: updated.trigger_message_id,
          replyMessageID: updated.reply_message_id,
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
export function markDelivered(
  db: Database.Interface["db"],
  input: { readonly item: ClaimedReply; readonly ownerToken: string; readonly now?: number },
) {
  return db.transaction((tx) => Effect.gen(function* () {
    const now = input.now ?? Date.now()
    const before = yield* tx.select().from(IMReplyOutboxTable).where(leaseHeld(input.item.id,input.ownerToken,input.item.attempts)).get()
    if (!before) return false
    yield* ReplyBodyRetirement.read(tx,before.id)
    const updated = yield* tx
      .update(IMReplyOutboxTable)
      .set({ status: "delivered", lease_owner: null, lease_expires_at: null, time_updated: now, time_delivered: now })
      .where(leaseHeld(input.item.id, input.ownerToken, input.item.attempts))
      .returning({ id: IMReplyOutboxTable.id })
      .get()
      .pipe(Effect.orDie)
    if (updated) yield* ReplyBodyRetirement.refresh(tx,input.item.id)
    return updated !== undefined
  }), {behavior:"immediate"})
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
  return db.transaction((tx) => Effect.gen(function* () {
    const now = input.now ?? Date.now()
    const dead = input.item.attempts >= IM_REPLY_MAX_ATTEMPTS
    const before = yield* tx.select().from(IMReplyOutboxTable).where(leaseHeld(input.item.id,input.ownerToken,input.item.attempts)).get()
    if (!before) return undefined
    yield* ReplyBodyRetirement.read(tx,before.id)
    const updated = yield* tx
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
    if (updated) yield* ReplyBodyRetirement.refresh(tx,input.item.id)
    if (updated?.status === "dead")
      log.error("im reply delivery dead-lettered", {
        outboxID: input.item.id,
        groupID: input.item.groupID,
        sessionID: input.item.sessionID,
        attempts: input.item.attempts,
        lastError: input.reason,
      })
    return updated?.status
  }), {behavior:"immediate"})
}

// ── Terminal-reply collection ────────────────────────────────────────────────────────────────────

export interface CollectDeps {
  readonly db: Database.Interface["db"]
  readonly v2Session: SessionV2.Interface
  readonly work?: WorkExecutionProfile.Installed
}

/** Collect only an admitted IM input's settled Activity and its explicit final message. The
 * Activity pointer is written by the existing runner at settlement; projected intermediate text,
 * failed/interrupted activities, and old rows without terminal evidence are skipped. */
export function collectSessionReply(deps: CollectDeps, sessionID: string, now?: number) {
  return Effect.gen(function* () {
    const info = yield* deps.v2Session.get(SessionV2.ID.make(sessionID)).pipe(Effect.option)
    if (Option.isNone(info)) return false
    const activities = yield* deps.db.selectDistinct({ activityID: SessionActivityTable.activity_id,
      triggerInputID: SessionActivityTable.trigger_input_id, finalMessageID: SessionActivityTable.final_message_id,
      groupID: IMDacBindingTable.group_id })
      .from(SessionActivityTable)
      .innerJoin(SessionActivityInputTable, eq(SessionActivityInputTable.activity_id, SessionActivityTable.activity_id))
      .innerJoin(IMDacCommandTable, and(eq(IMDacCommandTable.input_id, SessionActivityInputTable.input_id),
        eq(IMDacCommandTable.session_id, SessionActivityTable.session_id), eq(IMDacCommandTable.state, "admitted")))
      .innerJoin(IMDacBindingTable, eq(IMDacBindingTable.id, IMDacCommandTable.binding_id))
      .where(and(eq(SessionActivityTable.session_id, sessionID), eq(SessionActivityTable.state, "settled"))).all().pipe(Effect.orDie)
    const results = yield* Effect.forEach(activities, (activity) => Effect.gen(function* () {
      if (!activity.finalMessageID) return false
      const final = yield* deps.v2Session.message({ sessionID: SessionV2.ID.make(sessionID), messageID: SessionMessage.ID.make(activity.finalMessageID) })
      if (!final || final.type !== "assistant" || final.error) return false
      const text = ReplyParts.text(final)
      if (!text) return false
      const parts = Array.from(ReplyParts.ranges(text), (range) => text.slice(range.start, range.end))
      const appended = yield* deps.db.transaction((tx) => Effect.forEach(parts, (part, index) => appendReplyInTransaction(tx, {
        sessionID, groupID: activity.groupID, agentID: final.agent, triggerMessageID: activity.triggerInputID,
        replyMessageID: parts.length === 1 ? activity.finalMessageID! : `${activity.finalMessageID}_impart_${String(index).padStart(8, "0")}`,
        replyText: part, now: now ?? Date.now(),
      })), { behavior: "immediate" })
      return appended.some(Boolean)
    }))
    return results.some(Boolean)
  })
}

/** Only Sessions owned by admitted personal commands participate in reply collection. */
export function imSessionIDs(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const rows = yield* db
      .selectDistinct({ id: IMDacCommandTable.session_id })
      .from(IMDacCommandTable)
      .where(eq(IMDacCommandTable.state, "admitted"))
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
  // IM-kernel (B1): when present, a delivered reply bound to a kernel conversation is also
  // forwarded to the kernel (best-effort — the sync engine owns ack write-back and pending retry).
  readonly kernelSync?: IMKernelSync.Interface
  readonly v2Session?: SessionV2.Interface
  readonly work?: WorkExecutionProfile.Installed
  readonly authorize?: (binding: typeof IMDacBindingTable.$inferSelect, use: (engine: IMKernelSync.Interface | undefined) => Effect.Effect<IMMessage, unknown>) => Effect.Effect<IMMessage, unknown>
}

/** The delivery side effect: persist the reply as a real agent IM message + broadcast it (the same
 * surfaces the legacy orchestrator wrote), keyed on `metadata.type = "agent_run"`. */
export function deliverReply(deps: DeliveryDeps, item: ClaimedReply) {
  return Effect.gen(function* () {
    const row = yield* deps.db.select({ binding: IMDacBindingTable }).from(IMDacCommandTable)
      .innerJoin(IMDacBindingTable, eq(IMDacBindingTable.id, IMDacCommandTable.binding_id))
      .where(and(eq(IMDacCommandTable.session_id, item.sessionID), eq(IMDacCommandTable.state, "admitted"), eq(IMDacBindingTable.group_id, item.groupID))).get()
    if (!row) return yield* Effect.fail(new Error("Historical IM execution reply delivery is disabled"))
    if (deps.authorize) return yield* deps.authorize(row.binding, (engine) => deliverReplyBody({ ...deps, kernelSync: engine }, item))
    const group = yield* deps.repo.getGroup({ groupID: item.groupID, workspaceID: row.binding.workspace_id ?? row.binding.directory, userID: row.binding.owner_id })
    if (!group || group.kernelConvID) return yield* Effect.fail(new Error("Current IM account delivery is unavailable"))
    return yield* deliverReplyBody(deps, item)
  })
}

function deliverReplyBody(deps: DeliveryDeps, item: ClaimedReply) {
  return Effect.gen(function* () {
    const custody = yield* ReplyBodyRetirement.read(deps.db,item.id)
    if (custody.outbox.session_id!==item.sessionID || custody.outbox.group_id!==item.groupID || custody.outbox.agent_id!==item.agentID ||
      custody.outbox.trigger_message_id!==(item.triggerMessageID??null) || custody.outbox.reply_message_id!==item.replyMessageID ||
      custody.record.origin.replyHash!==ReplyBodyRetirementModel.bodyHash(item.replyText)) return yield* ReplyBodyRetirementModel.invalid()
    if (custody.record.bodyState==="retired") return yield* new ReplyBodyRetirementModel.Error({code:"KERNEL_DELIVERY_RETIRED",message:"The original reply body has expired; it cannot be sent again"})
    if (custody.record.origin.kind==="legacy_unbound") return yield* ReplyBodyRetirementModel.invalid()
    const command = yield* deps.db.select({ binding: IMDacBindingTable }).from(IMDacCommandTable)
      .innerJoin(IMDacBindingTable, eq(IMDacBindingTable.id, IMDacCommandTable.binding_id))
      .where(and(eq(IMDacCommandTable.session_id, item.sessionID), eq(IMDacCommandTable.state, "admitted"), eq(IMDacBindingTable.group_id, item.groupID))).get()
    if (!command || custody.record.origin.kind !== "dac_session")
      return yield* Effect.fail(new Error("Historical IM execution reply delivery is disabled"))
    const create = (deps.kernelSync?.createMessage ?? deps.repo.createMessage)({
      id: ReplyDeliveryID.fromOutbox(item.id),
      groupID: item.groupID,
      senderID: item.agentID,
      senderType: "agent",
      type: "text",
      content: item.replyText,
      mentions: [],
      metadata: { type: "agent_run", sessionID: item.sessionID, status: "success" },
    })
    const message = yield* create
    if (!message.replayed)
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
    if (deps.kernelSync && !message.replayed) {
      // design §6：跨内核回发带 [Agent·<执行者>] 标记——内核只路由文本，sender_type="agent" 与
      // metadata 都到不了对端，文本前缀是唯一跨内核可见的作者标记。本地行保持裸文（本地渲染
      // 已有 senderType/metadata）。outbox 只有 agent 名没有模型名，标记用 agent 名。
      yield* deps.kernelSync.send({
        groupID: item.groupID,
        messageID: message.id,
        content: `[Agent·${item.agentID}] ${item.replyText}`,
      })
    }
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
      const item = yield* claimDueReply(deps.db, {
        ownerToken,
        ...(options?.now !== undefined ? { now: options.now } : {}),
      })
      if (!item) break
      const outcome = yield* deliverReply(deps, item).pipe(
        Effect.flatMap((message) => deps.db.select({ state: IMKernelDeliveryTable.state }).from(IMKernelDeliveryTable)
          .where(eq(IMKernelDeliveryTable.message_id, message.id)).get().pipe(Effect.map((receipt) => !receipt || receipt.state === "acknowledged" ? "ok" as const : "awaiting_ack" as const))),
        Effect.catchCause((cause) => Effect.succeed(Cause.squash(cause))),
      )
      if (outcome === "ok") {
        yield* markDelivered(deps.db, { item, ownerToken, ...(options?.now !== undefined ? { now: options.now } : {}) })
        delivered++
      } else if (outcome === "awaiting_ack") {
        // Queue acceptance is not a transport ACK. Preserve the original
        // delivery identity and let the communication engine reconcile it;
        // no provider rerun and no blind resend of an unknown receipt.
        yield* deps.db.transaction((tx) => Effect.gen(function* () {
          yield* tx.update(IMReplyOutboxTable).set({ status: "pending", attempts: item.attempts - 1,
            available_at: (options?.now ?? Date.now()) + IM_REPLY_RECONCILE_INTERVAL_MS, lease_owner: null, lease_expires_at: null,
            last_error: "awaiting_kernel_ack", time_updated: options?.now ?? Date.now() }).where(leaseHeld(item.id, ownerToken, item.attempts)).run()
          yield* ReplyBodyRetirement.refresh(tx, item.id)
        }), { behavior: "immediate" })
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

/** Read protected metadata in its short output frame, then use the same held
 * reader for delivery. The frame is not a network-send authority or timeout. */
export function authorizeReply<A, E>(deps: { db: Database.Interface["db"]; repo: IMRepositoryInterface;
  facade?: Pick<IMFacade.Interface, "withReader">; kernelSync?: IMKernelSync.Interface },
  binding: typeof IMDacBindingTable.$inferSelect, effect: Effect.Effect<A, E> | ((engine: IMKernelSync.Interface | undefined) => Effect.Effect<A, E>)) {
  return Effect.gen(function* () {
    const context = { workspaceID: binding.workspace_id ?? binding.directory, directory: binding.directory, userID: binding.owner_id }
    // This body-free locator does not require or manufacture a protected Output.
    const locator = yield* deps.repo.getGroupByID(binding.group_id)
    if (!locator || locator.workspaceID !== context.workspaceID) return yield* Effect.fail(new Error("Current IM conversation is unavailable"))
    if (!locator.kernelConvID) {
      const group = yield* deps.repo.getGroup({ groupID: binding.group_id, workspaceID: context.workspaceID, userID: context.userID })
      if (!group) return yield* Effect.fail(new Error("Current IM conversation is unavailable"))
      return yield* typeof effect === "function" ? effect(undefined) : effect
    }
    if (!deps.facade || !deps.kernelSync) return yield* Effect.fail(new Error("Current IM account delivery is unavailable"))
    return yield* deps.facade.withReader(context, (lease) => Effect.gen(function* () {
      yield* lease.reader.withOutput({ workspaceID: context.workspaceID, userID: context.userID, groupIDs: [binding.group_id] }, Effect.gen(function* () {
        const group = yield* deps.repo.getGroup({ groupID: binding.group_id, workspaceID: context.workspaceID, userID: context.userID })
        if (!group) return yield* Effect.fail(new Error("Current IM conversation is unavailable"))
        const current = yield* KernelReader.pageIdentity(lease.reader.runtime, context)
        const row = yield* deps.db.select({ scope: IMKernelReaderScopeTable, projection: IMKernelReaderProjectionTable }).from(IMKernelReaderProjectionTable)
          .innerJoin(IMKernelReaderScopeTable, eq(IMKernelReaderScopeTable.reader_key, IMKernelReaderProjectionTable.reader_key))
          .where(and(eq(IMKernelReaderProjectionTable.reader_key, current.readerKey), eq(IMKernelReaderProjectionTable.local_group_id, binding.group_id),
            or(eq(IMKernelReaderProjectionTable.visibility, "visible"), eq(IMKernelReaderProjectionTable.visibility, "pending")))).get()
        if (!row) return yield* Effect.fail(new Error("Current IM conversation is unavailable"))
        const account = yield* Effect.try({ try: () => KernelReaderSchema.decode(KernelReaderSchema.Binding, row.scope.binding, 8192), catch: () => new Error("Current IM account delivery is unavailable") })
        if (account.instanceID !== binding.executor_id || createHash("sha256").update(JSON.stringify([account.realm, account.appkey, account.orgID, account.userID])).digest("hex") !== binding.account_key ||
          JSON.stringify([row.projection.conversation_type, row.projection.target_id]) !== binding.conversation_key)
          return yield* Effect.fail(new Error("Current IM account delivery is unavailable"))
      }))
      yield* lease.assertCurrent
      const result = yield* typeof effect === "function" ? effect(lease.engine) : effect
      yield* lease.assertCurrent
      return result
    }))
  })
}

/** A daemon has no HTTP placement context. Retain only the already registered
 * original Instance; a durable binding never authorizes booting a directory. */
export function authorizeRegisteredReply<A, E>(deps: Parameters<typeof authorizeReply>[0] & {
  instanceStore: Pick<InstanceStore.Interface, "peek">
}, binding: typeof IMDacBindingTable.$inferSelect,
  effect: Effect.Effect<A, E> | ((engine: IMKernelSync.Interface | undefined) => Effect.Effect<A, E>)) {
  return Effect.gen(function* () {
    const instance = yield* deps.instanceStore.peek(binding.directory)
    if (!instance || instance.directory !== binding.directory || instance.project.id !== binding.project_id) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease")
    const result = yield* authorizeReply(deps, binding, effect).pipe(
      Effect.provideService(InstanceRef, instance),
      Effect.provideService(WorkspaceRef, binding.workspace_id === null ? undefined : WorkspaceV2.ID.make(binding.workspace_id)),
    )
    if ((yield* deps.instanceStore.peek(binding.directory)) !== instance) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease")
    return result
  })
}

// ── The daemon ───────────────────────────────────────────────────────────────────────────────────

/** How often the reconcile backstop runs (collect + drain), independent of settle signals. */
export const IM_REPLY_RECONCILE_INTERVAL_MS = 5_000

const isIMSessionSettle = (event: Payload): string | undefined => {
  if (event.type !== SessionEvent.Execution.Succeeded.type && event.type !== SessionEvent.Execution.Failed.type)
    return undefined
  const sessionID = (event.data as { readonly sessionID?: unknown }).sessionID
  return typeof sessionID === "string" && sessionID.startsWith("ses_im_")
    ? sessionID
    : undefined
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
    // IM 门面（B2）：内核引擎的唯一所有者。引擎在 claim/retry 后热启动，故不能在此固化
    // kernelSync 快照——每个 drain pass 前从 facade.engine 现读（缺席 ⇒ 该 pass 纯本地投递）。
    const facade = Option.getOrUndefined(yield* Effect.serviceOption(IMFacade.Service))
    const instanceStore = yield* InstanceStore.Service
    const deps = { db, v2Session }
    const drainWithCurrentEngine = Effect.gen(function* () {
      const kernelSync = facade ? Option.getOrUndefined(yield* Ref.get(facade.engine)) : undefined
      const authorize = <A>(binding: typeof IMDacBindingTable.$inferSelect, effect: Effect.Effect<A, unknown> | ((engine: IMKernelSync.Interface | undefined) => Effect.Effect<A, unknown>)) =>
        authorizeRegisteredReply({ db, repo, facade, kernelSync, instanceStore }, binding, effect)
      const pending = yield* db.selectDistinct({ binding: IMDacBindingTable }).from(IMDacCommandTable)
        .innerJoin(IMDacBindingTable, eq(IMDacBindingTable.id, IMDacCommandTable.binding_id))
        .where(eq(IMDacCommandTable.state, "pending")).limit(32).all()
      const bridge = IMDacSession.make(db, v2Session)
      yield* Effect.forEach(pending, (row) => authorize(row.binding, bridge.reconcile({ ownerID: row.binding.owner_id, accountKey: row.binding.account_key,
        executorID: row.binding.executor_id, conversationKey: row.binding.conversation_key, groupID: row.binding.group_id, projectID: row.binding.project_id,
        directory: row.binding.directory, workspaceID: row.binding.workspace_id })).pipe(Effect.ignore), { discard: true, concurrency: 1 })
      const delivery: DeliveryDeps = { db, repo, broadcaster, v2Session, authorize, ...(kernelSync ? { kernelSync } : {}) }
      return yield* drainPass(delivery)
    })
    // The listener callback runs with R = never (EventV2.Listener), so the drain fiber is forked
    // into THIS layer's scope explicitly — post-commit collect+drain never delays the publisher.
    const scope = yield* Effect.scope

    if (events) {
      yield* events.listen((event) => {
        const sessionID = isIMSessionSettle(event)
        if (!sessionID) return Effect.void
        return collectSessionReply(deps, sessionID).pipe(
          Effect.andThen(drainWithCurrentEngine),
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("im reply settle drain failed", { sessionID, cause: Cause.pretty(cause) })),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        )
      })
    }

    yield* reconcileReplies(deps).pipe(
      Effect.andThen(drainWithCurrentEngine),
      Effect.catchCause((cause) =>
        Effect.sync(() => log.error("im reply reconcile pass failed", { cause: Cause.pretty(cause) })),
      ),
      Effect.repeat(Schedule.spaced(Duration.millis(IM_REPLY_RECONCILE_INTERVAL_MS))),
      Effect.forkScoped,
    )
  }),
)
