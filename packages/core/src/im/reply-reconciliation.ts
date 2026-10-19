export * as ReplyReconciliation from "./reply-reconciliation"

import { createHash } from "node:crypto"
import { and, asc, eq, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { SessionActivityTable } from "../context-federation/session-sql"
import { contentDigest } from "../contract/digest"
import type { IMDacSession } from "./dac-session"
import { IMDacSessionSchema } from "./dac-session.schema"
import { KernelDelivery } from "./kernel-delivery"
import { KernelDeliverySchema } from "./kernel-delivery.schema"
import { IMKernelDeliveryTable } from "./kernel-delivery.sql"
import { IMReplyOutboxTable } from "./reply-outbox.sql"
import { ReplyBodyRetirement } from "./reply-body-retirement"
import { ReplyBodyRetirementModel } from "./reply-body-retirement.model"
import { ReplyDeliveryID } from "./reply-delivery-id"
import { ReplyParts } from "./reply-parts"
import { MessageTable } from "./sql"

type Db = Database.Interface["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Db | Tx
export interface Transport {
  readonly source: KernelDeliverySchema.Source
  readonly current: Effect.Effect<void, unknown>
  readonly protect: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, unknown>
  readonly query: (
    request: IMDacSessionSchema.ReplyReceiptQuery,
  ) => Effect.Effect<IMDacSessionSchema.ReplyReceipt, unknown>
}
const fail = () => new IMDacSessionSchema.Error({ code: "reply_unavailable" })
const digest = KernelDelivery.hash
const stable = (source: KernelDeliverySchema.Source) => [source.realm, source.appkey, source.orgID, source.senderID]
const confirmed = (value: Effect.Success<ReturnType<typeof ReplyBodyRetirement.read>>) =>
  value.receipt?.state === "acknowledged" && !!value.receipt.kernel_message_id && value.outbox.status === "delivered"
const active = (value: Effect.Success<ReturnType<typeof ReplyBodyRetirement.read>>) =>
  value.outbox.lease_owner !== null || value.outbox.lease_expires_at !== null

/** Original collector identity only. This function never creates or reconstructs a reply. */
export function run(input: {
  db: Db
  sessions: Pick<SessionV2.Interface, "message">
  scope: IMDacSession.Scope
  command: () => Effect.Effect<IMDacSessionSchema.CommandResponse, IMDacSessionSchema.Error>
  request: IMDacSessionSchema.ReplyReconcileRequest
  transport: Transport
}) {
  const rangeCounts = new Map<string, number>()
  const collection = () =>
    Effect.gen(function* () {
      const command = yield* input.command()
      if (
        command.state !== "admitted" ||
        !command.activityID ||
        !command.finalMessageID ||
        command.groupID !== input.scope.groupID
      )
        return yield* fail()
      const activity = yield* input.db
        .select()
        .from(SessionActivityTable)
        .where(
          and(
            eq(SessionActivityTable.activity_id, command.activityID),
            eq(SessionActivityTable.session_id, command.sessionID),
          ),
        )
        .get()
      if (activity?.state !== "settled" || activity.final_message_id !== command.finalMessageID) return yield* fail()
      const final = yield* input.sessions.message({
        sessionID: SessionV2.ID.make(command.sessionID),
        messageID: SessionMessage.ID.make(command.finalMessageID),
      })
      if (!final || final.type !== "assistant" || final.error) return yield* fail()
      const text = ReplyParts.text(final)
      if (!text) return yield* fail()
      // Count the actual collector ranges, without manufacturing a wire body or row.
      const finalHash = digest(final)
      const count = rangeCounts.get(finalHash) ?? Array.from(ReplyParts.ranges(text)).length
      rangeCounts.set(finalHash, count)
      if (
        !count ||
        count * 2 + 1 > ReplyBodyRetirementModel.RECORD_LIMIT ||
        Buffer.byteLength(text) > ReplyBodyRetirementModel.BYTE_LIMIT
      )
        return yield* fail()
      const prefix = `${command.finalMessageID}_impart_`
      const rows = yield* input.db
        .select({
          id: IMReplyOutboxTable.id,
          reply: IMReplyOutboxTable.reply_message_id,
          delivery: IMReplyOutboxTable.delivery_message_id,
        })
        .from(IMReplyOutboxTable)
        .where(
          and(
            eq(IMReplyOutboxTable.session_id, command.sessionID),
            eq(IMReplyOutboxTable.group_id, input.scope.groupID),
            or(
              eq(IMReplyOutboxTable.reply_message_id, command.finalMessageID),
              sql`substr(${IMReplyOutboxTable.reply_message_id},1,${prefix.length})=${prefix}`,
            ),
          ),
        )
        .orderBy(asc(IMReplyOutboxTable.reply_message_id))
        .limit(ReplyBodyRetirementModel.RECORD_LIMIT)
        .all()
      if (rows.length !== count) return yield* fail()
      for (const [index, row] of rows.entries()) {
        const expected = count === 1 ? command.finalMessageID : `${prefix}${String(index).padStart(8, "0")}`
        if (
          row.reply !== expected ||
          row.id !== `imo_${contentDigest(`${command.sessionID}:${expected}`).slice(0, 24)}` ||
          row.delivery !== ReplyDeliveryID.fromOutbox(row.id)
        )
          return yield* fail()
      }
      const basis = {
        commandID: command.commandID,
        bindingID: command.bindingID,
        sessionID: command.sessionID,
        activityID: command.activityID,
        finalMessageID: command.finalMessageID,
        trigger: activity.trigger_input_id,
        finalHash,
        parts: rows,
      }
      return { command, rows, basis, hash: digest(basis) }
    }).pipe(Effect.mapError(() => fail()))
  type Collection = Effect.Success<ReturnType<typeof collection>>
  const inspect = (db: Reader, set: Collection, index: number) =>
    Effect.gen(function* () {
      const row = set.rows[index]
      if (!row) return yield* fail()
      const value = yield* ReplyBodyRetirement.read(db, row.id)
      const origin = value.record.origin
      if (
        origin.kind !== "dac_session" ||
        origin.basisHash !==
          digest([
            "dac_session",
            {
              activity_id: set.basis.activityID,
              trigger_input_id: set.basis.trigger,
              final_message_id: set.basis.finalMessageID,
              binding_id: set.basis.bindingID,
            },
          ]) ||
        origin.sessionID !== set.basis.sessionID ||
        origin.groupID !== input.scope.groupID ||
        origin.replyMessageID !== row.reply ||
        origin.deliveryMessageID !== row.delivery ||
        value.outbox.delivery_message_id !== row.delivery ||
        value.outbox.agent_id !== origin.agentID
      )
        return yield* fail()
      if (value.record.transport) {
        const binding = value.record.transport.binding
        if (
          digest(stable(binding.source)) !== digest(stable(input.transport.source)) ||
          createHash("sha256")
            .update(
              JSON.stringify([
                input.transport.source.realm,
                input.transport.source.appkey,
                // Host account identity comes from the durable reader Binding,
                // whose orgID uses the canonical Decimal string representation.
                String(input.transport.source.orgID),
                input.transport.source.senderID,
              ]),
            )
            .digest("hex") !== input.scope.accountKey ||
          binding.workspaceID !== (input.scope.workspaceID ?? input.scope.directory) ||
          JSON.stringify([binding.conversationType, binding.conversationID]) !== input.scope.conversationKey ||
          !value.group ||
          value.group.deleted_at !== null
        )
          return yield* fail()
      }
      return value
    }).pipe(Effect.mapError(() => fail()))
  const summary = (set: Collection) =>
    Effect.gen(function* () {
      const counts = { confirmed: 0, active: 0 }
      for (const index of set.rows.keys()) {
        const value = yield* inspect(input.db, set, index)
        if (confirmed(value)) counts.confirmed++
        if (active(value)) counts.active++
      }
      return counts
    })
  return Effect.gen(function* () {
    yield* input.transport.current
    const set = yield* input.transport.protect(collection())
    const cursor = input.request.cursor
      ? yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(Schema.Tuple([Schema.String, Schema.Int]))(
              Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(
                Buffer.from(input.request.cursor!, "base64url").toString("utf8"),
              ),
            ),
          catch: fail,
        })
      : ([set.hash, 0] as const)
    if (cursor[0] !== set.hash || cursor[1] < 0 || cursor[1] >= set.rows.length) return yield* fail()
    const end = Math.min(set.rows.length, cursor[1] + ReplyBodyRetirementModel.PAGE_LIMIT)
    const parts: IMDacSessionSchema.ReplyReconcilePart[] = []
    const started = performance.now()
    // Finish each original RPC/CAS before yielding the next explicit page.
    for (let index = cursor[1]; index < end; index++) {
      if (parts.length && performance.now() - started >= 4000) break
      yield* input.transport.current
      const result = yield* input.transport.protect(
        Effect.gen(function* () {
          if ((yield* collection()).hash !== set.hash) return yield* fail()
          const value = yield* inspect(input.db, set, index)
          const base = {
            index,
            outboxID: value.outbox.id,
            replyMessageID: value.outbox.reply_message_id,
            deliveryMessageID: value.outbox.delivery_message_id!,
            remoteState: null,
            kernelMessageID: value.receipt?.kernel_message_id ?? null,
          }
          const terminal: IMDacSessionSchema.ReplyReconcilePart["outcome"] | undefined = confirmed(value)
            ? "already_confirmed"
            : active(value)
              ? "active_delivery"
              : value.record.bodyState !== "live"
                ? "retired"
                : !value.receipt ||
                    !value.record.transport ||
                    value.receipt.state === "prepared" ||
                    !value.receipt.dispatch_owner
                  ? "not_dispatched"
                  : value.record.transport.binding.expiresAt <= Date.now()
                    ? "expired"
                    : undefined
          if (terminal) return { base, terminal }
          const binding = value.record.transport!.binding
          if (!value.message || !KernelDelivery.wireMessage(binding, value.message)) return yield* fail()
          const wire = KernelDelivery.wireText(value.message)
          const request = {
            version: 1 as const,
            channelType: binding.conversationType,
            targetId: binding.conversationID,
            clientUid: binding.wireID,
            expiresAt: binding.expiresAt,
            requestHash: createHash("sha256")
              .update(
                JSON.stringify([
                  "dac.delivery.request.v1",
                  binding.conversationType,
                  binding.conversationID,
                  binding.wireID,
                  "jg:text",
                  wire,
                  10,
                  binding.expiresAt,
                ]).replace(/[<>&\u2028\u2029]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")),
              )
              .digest("hex"),
          }
          return {
            base,
            request,
            facts: ReplyBodyRetirementModel.factsHash(value.rawOutbox, value.rawMessage, value.rawReceipt),
            bodyHash: digest(value.body),
            owner: value.receipt!.dispatch_owner,
            bindingHash: value.receipt!.binding_hash,
          }
        }),
      )
      if (result.terminal) {
        parts.push({ ...result.base, outcome: result.terminal })
        continue
      }
      const received = yield* input.transport.query(result.request!).pipe(Effect.option)
      yield* input.transport.current
      if (received._tag === "None") {
        parts.push({ ...result.base, outcome: "unavailable" })
        continue
      }
      const receipt = Schema.decodeUnknownOption(IMDacSessionSchema.ReplyReceipt)(received.value, {
        onExcessProperty: "error",
      })
      if (receipt._tag === "None") {
        parts.push({ ...result.base, outcome: "unconfirmed" })
        continue
      }
      const remote = receipt.value
      const query = result.request!
      if (
        remote.state !== "confirmed_acceptance" ||
        remote.clientUid !== query.clientUid ||
        remote.requestHash !== query.requestHash ||
        remote.expiresAt !== query.expiresAt ||
        !remote.msgId ||
        remote.msgId.length > 2048 ||
        !Number.isSafeInteger(remote.msgTime) ||
        remote.msgTime <= 0 ||
        !/^[1-9][0-9]{0,18}$/.test(remote.msgSeqNo) ||
        BigInt(remote.msgSeqNo) > 9223372036854775807n
      ) {
        parts.push({ ...result.base, outcome: "unconfirmed", remoteState: remote.state })
        continue
      }
      const settled = yield* input.transport
        .protect(
          Effect.gen(function* () {
            if ((yield* collection()).hash !== set.hash) return yield* fail()
            yield* input.transport.current
            return yield* input.db.transaction(
              (tx) =>
                Effect.gen(function* () {
                  const value = yield* inspect(tx, set, index)
                  if (confirmed(value))
                    return value.receipt!.kernel_message_id === remote.msgId
                      ? ("already_confirmed" as const)
                      : yield* fail()
                  if (active(value)) return "active_delivery" as const
                  if (
                    value.record.bodyState !== "live" ||
                    !value.receipt ||
                    value.receipt.dispatch_owner !== result.owner ||
                    value.receipt.binding_hash !== result.bindingHash ||
                    value.receipt.binding?.version !== 1 ||
                    value.receipt.binding.expiresAt <= Date.now() ||
                    ReplyBodyRetirementModel.factsHash(value.rawOutbox, value.rawMessage, value.rawReceipt) !==
                      result.facts ||
                    digest(value.body) !== result.bodyHash ||
                    !["unknown", "dispatched", "acknowledged"].includes(value.receipt.state) ||
                    (value.receipt.kernel_message_id !== null && value.receipt.kernel_message_id !== remote.msgId)
                  )
                    return yield* fail()
                  yield* input.transport.current
                  const now = Date.now()
                  const changed = yield* tx
                    .update(IMKernelDeliveryTable)
                    .set({
                      state: "acknowledged",
                      kernel_message_id: remote.msgId,
                      acknowledged_at: value.receipt.acknowledged_at ?? now,
                      updated_at: now,
                    })
                    .where(
                      and(
                        eq(IMKernelDeliveryTable.message_id, value.receipt.message_id),
                        eq(IMKernelDeliveryTable.binding_hash, result.bindingHash!),
                        eq(IMKernelDeliveryTable.dispatch_owner, result.owner!),
                        eq(IMKernelDeliveryTable.updated_at, value.receipt.updated_at),
                      ),
                    )
                    .returning()
                    .get()
                  if (!changed) return yield* fail()
                  if (!value.group?.kernel_conv_id?.startsWith("kr1:"))
                    yield* tx
                      .update(MessageTable)
                      .set({ kernel_msg_id: remote.msgId })
                      .where(eq(MessageTable.id, value.message!.id))
                      .run()
                  const updated = yield* tx
                    .update(IMReplyOutboxTable)
                    .set({ status: "delivered", time_delivered: value.outbox.time_delivered ?? now, time_updated: now })
                    .where(
                      and(
                        eq(IMReplyOutboxTable.id, value.outbox.id),
                        eq(IMReplyOutboxTable.time_updated, value.outbox.time_updated),
                        eq(IMReplyOutboxTable.attempts, value.outbox.attempts),
                      ),
                    )
                    .returning()
                    .get()
                  if (!updated) return yield* fail()
                  yield* ReplyBodyRetirement.refresh(tx, value.outbox.id)
                  yield* input.transport.current
                  return "confirmed_acceptance" as const
                }),
              { behavior: "immediate" },
            )
          }),
        )
        .pipe(Effect.option)
      parts.push({
        ...result.base,
        outcome: settled._tag === "Some" ? settled.value : "unconfirmed",
        remoteState: remote.state,
        kernelMessageID:
          settled._tag === "Some" && ["already_confirmed", "confirmed_acceptance"].includes(settled.value)
            ? remote.msgId
            : null,
      })
    }
    yield* input.transport.current
    const total = yield* input.transport.protect(
      Effect.gen(function* () {
        if ((yield* collection()).hash !== set.hash) return yield* fail()
        return yield* summary(set)
      }),
    )
    const command = yield* input.command()
    const nextIndex = cursor[1] + parts.length
    const hasMore = nextIndex < set.rows.length
    return {
      version: 1 as const,
      command,
      state:
        total.confirmed === set.rows.length
          ? ("confirmed_acceptance" as const)
          : total.confirmed
            ? ("partial" as const)
            : ("unconfirmed" as const),
      totalParts: set.rows.length,
      confirmedParts: total.confirmed,
      unconfirmedParts: set.rows.length - total.confirmed,
      activeParts: total.active,
      parts,
      hasMore,
      nextCursor: hasMore ? Buffer.from(JSON.stringify([set.hash, nextIndex])).toString("base64url") : null,
    }
  }).pipe(Effect.mapError(() => fail()))
}
