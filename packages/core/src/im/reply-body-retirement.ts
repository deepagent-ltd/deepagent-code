export * as ReplyBodyRetirement from "./reply-body-retirement"

import { and, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { KernelReaderSchema } from "./kernel-reader.schema"
import { KernelDeliverySchema } from "./kernel-delivery.schema"
import { IMKernelDeliveryTable } from "./kernel-delivery.sql"
import { IMKernelMediaBodyTable } from "./kernel-media-retirement.sql"
import { IMReplyOutboxTable } from "./reply-outbox.sql"
import { IMReplyBodyMeterTable, IMReplyBodyTable } from "./reply-body-retirement.sql"
import { ReplyBodyRetirementModel } from "./reply-body-retirement.model"
import { GroupTable, MessageTable } from "./sql"
import { ReplyDeliveryID } from "./reply-delivery-id"

type Db = Database.Interface["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Db | Tx
type Outbox = typeof IMReplyOutboxTable.$inferSelect
type Ledger = typeof IMReplyBodyTable.$inferSelect
type Message = typeof MessageTable.$inferSelect
type Receipt = typeof IMKernelDeliveryTable.$inferSelect
const invalid = ReplyBodyRetirementModel.invalid
const bounded = <A>(body: () => A) =>
  Effect.try({ try: body, catch: (error) => (error instanceof ReplyBodyRetirementModel.Error ? error : invalid()) })

const outboxStrings = [
  "id",
  "session_id",
  "group_id",
  "agent_id",
  "trigger_message_id",
  "reply_message_id",
  "delivery_message_id",
  "reply_text",
  "body_state",
  "status",
  "lease_owner",
  "last_error",
]
const outboxIntegers = [
  "attempts",
  "available_at",
  "lease_expires_at",
  "time_created",
  "time_updated",
  "time_delivered",
]
const messageStrings = [
  "id",
  "group_id",
  "sender_id",
  "sender_type",
  "type",
  "content",
  "mentions",
  "metadata",
  "reply_to_id",
  "event_id",
  "delivery_status",
  "kernel_msg_id",
  "client_request_id",
]
const messageIntegers = ["created_at", "updated_at", "deleted_at"]
const receiptStrings = [
  "message_id",
  "binding",
  "body_state",
  "binding_hash",
  "wire_id",
  "state",
  "dispatch_owner",
  "kernel_message_id",
  "reason",
]
const receiptIntegers = ["created_at", "dispatched_at", "acknowledged_at", "updated_at"]
const ledgerStrings = [
  "outbox_id",
  "origin_kind",
  "custody_state",
  "body_state",
  "group_ref",
  "local_message_id",
  "receipt_message_id",
  "origin_identity_hash",
  "message_identity_hash",
  "transport_identity_hash",
  "record",
  "record_hash",
  "mutable_facts_hash",
]
const ledgerIntegers = [
  "meter_id",
  "version",
  "original_expires_at",
  "retired_at",
  "local_revision",
  "accounted_records",
  "accounted_bytes",
  "created_at",
  "updated_at",
]
const bytes = (alias: string, strings: readonly string[], integers: readonly string[]) =>
  sql.raw(
    [
      ...strings.map((field) => `coalesce(length(CAST(${alias}."${field}" AS BLOB)),0)`),
      ...integers.map((field) => `CASE WHEN ${alias}."${field}" IS NULL THEN 0 ELSE 8 END`),
    ].join("+"),
  )
export const copiesBytes = sql`${bytes("o", outboxStrings, outboxIntegers)}+${bytes("m", messageStrings, messageIntegers)}+${bytes("d", receiptStrings, receiptIntegers)}`
export const legacyCopiesBytes = sql`${bytes(
  "o",
  outboxStrings.filter((key) => key !== "body_state"),
  outboxIntegers,
)}+4+${bytes("m", messageStrings, messageIntegers)}+${bytes("d", receiptStrings, receiptIntegers)}`
export const joinedBytes = sql`${bytes("im_reply_outbox", outboxStrings, outboxIntegers)}+${bytes("im_messages", messageStrings, messageIntegers)}+${bytes("im_kernel_delivery", receiptStrings, receiptIntegers)}+${bytes("im_reply_body", ledgerStrings, ledgerIntegers)}`

const rawJSON = (alias: string, strings: readonly string[], integers: readonly string[]) =>
  sql.raw(`json_object(${[...strings, ...integers].flatMap((key) => [`'${key}'`, `${alias}."${key}"`]).join(",")})`)
export const outboxJSON = rawJSON("im_reply_outbox", outboxStrings, outboxIntegers)
export const messageJSON = rawJSON("im_messages", messageStrings, messageIntegers)
export const receiptJSON = rawJSON("im_kernel_delivery", receiptStrings, receiptIntegers)
export const decodeRaw = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
)
export const rawFromJSON = (value: string) => decodeRaw(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value))

export const currentMeter = (db: Reader) =>
  Effect.gen(function* () {
    const row = yield* db.select().from(IMReplyBodyMeterTable).where(eq(IMReplyBodyMeterTable.meter_id, 1)).get()
    if (
      !row ||
      row.version !== 1 ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      row.used_records < 1 ||
      row.used_records > ReplyBodyRetirementModel.RECORD_LIMIT ||
      row.used_bytes < 76 ||
      row.used_bytes > ReplyBodyRetirementModel.BYTE_LIMIT ||
      !Number.isSafeInteger(row.used_records) ||
      !Number.isSafeInteger(row.used_bytes) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.custody_id)
    )
      return yield* invalid()
    return row
  })
const actual = (db: Reader, outboxID: string) =>
  Effect.gen(function* () {
    const size = yield* db.get<{ bytes: number }>(sql`SELECT ${copiesBytes} bytes FROM im_reply_outbox o
    LEFT JOIN im_messages m ON m.id=o.delivery_message_id LEFT JOIN im_kernel_delivery d ON d.message_id=o.delivery_message_id WHERE o.id=${outboxID}`)
    if (!size || size.bytes > ReplyBodyRetirementModel.BYTE_LIMIT) return yield* invalid()
    const outbox = yield* db.select().from(IMReplyOutboxTable).where(eq(IMReplyOutboxTable.id, outboxID)).get()
    if (!outbox || !outbox.delivery_message_id || outbox.delivery_message_id !== ReplyDeliveryID.fromOutbox(outbox.id))
      return yield* invalid()
    const message = yield* db
      .select()
      .from(MessageTable)
      .where(sql`${MessageTable.id}=${outbox.delivery_message_id}`)
      .get()
    const receipt = yield* db
      .select()
      .from(IMKernelDeliveryTable)
      .where(eq(IMKernelDeliveryTable.message_id, outbox.delivery_message_id))
      .get()
    const group = yield* db
      .select()
      .from(GroupTable)
      .where(sql`${GroupTable.id}=${outbox.group_id}`)
      .get()
    if (
      (receipt && !message) ||
      (message && !group) ||
      (yield* db
        .select({ id: IMKernelMediaBodyTable.message_id })
        .from(IMKernelMediaBodyTable)
        .where(eq(IMKernelMediaBodyTable.message_id, outbox.delivery_message_id))
        .get())
    )
      return yield* invalid()
    const rawOutbox = yield* db.get<ReplyBodyRetirementModel.RawRow>(
      sql`SELECT * FROM im_reply_outbox WHERE id=${outbox.id}`,
    )
    const rawMessage = message
      ? yield* db.get<ReplyBodyRetirementModel.RawRow>(sql`SELECT * FROM im_messages WHERE id=${message.id}`)
      : null
    const rawReceipt = receipt
      ? yield* db.get<ReplyBodyRetirementModel.RawRow>(
          sql`SELECT * FROM im_kernel_delivery WHERE message_id=${receipt.message_id}`,
        )
      : null
    if (!rawOutbox || (message && !rawMessage) || (receipt && !rawReceipt)) return yield* invalid()
    return {
      outbox,
      message,
      receipt,
      group,
      rawOutbox,
      rawMessage: rawMessage ?? null,
      rawReceipt: rawReceipt ?? null,
      bytes: size.bytes,
    }
  })

/** Origin is captured only once from durable closure records, never from a
 * current group with a reused ID or caller metadata. No row here is a grant. */
const origin = (tx: Tx, row: Outbox) =>
  Effect.gen(function* () {
    const dac = yield* tx.get<{ activity_id: string; trigger_input_id: string; final_message_id: string; binding_id: string }>(sql`
      SELECT a.activity_id,a.trigger_input_id,a.final_message_id,b.id AS binding_id FROM session_activity a
      JOIN session_activity_input ai ON ai.activity_id=a.activity_id
      JOIN im_dac_command c ON c.input_id=ai.input_id AND c.session_id=a.session_id AND c.state='admitted'
      JOIN im_dac_binding b ON b.id=c.binding_id
      WHERE a.session_id=${row.session_id} AND a.trigger_input_id IS ${row.trigger_message_id}
      AND b.group_id=${row.group_id} AND a.state='settled'
      AND (a.final_message_id=${row.reply_message_id} OR ${row.reply_message_id} GLOB a.final_message_id || '_impart_[0-9]*') LIMIT 1`)
    if (dac) return { kind: "dac_session" as const, basisHash: ReplyBodyRetirementModel.hash(["dac_session", dac]) }
    return {
      kind: "legacy_unbound" as const,
      basisHash: ReplyBodyRetirementModel.hash([
        "legacy-unbound",
        row.id,
        row.session_id,
        row.group_id,
        row.agent_id,
        row.trigger_message_id,
        row.reply_message_id,
      ]),
    }
  })
function binding(value: Effect.Success<ReturnType<typeof actual>>, record: ReplyBodyRetirementModel.Record) {
  if (!value.message) return record
  const message = value.message
  if (
    message.id !== record.origin.deliveryMessageID ||
    message.group_id !== record.origin.groupID ||
    message.sender_type !== "agent" ||
    message.sender_id !== record.origin.agentID ||
    message.type !== "text" ||
    message.content !== value.outbox.reply_text ||
    message.deleted_at !== null ||
    ReplyBodyRetirementModel.bodyHash(message.content) !== record.origin.replyHash
  )
    throw invalid()
  const identity = {
    messageID: message.id,
    headerHash: ReplyBodyRetirementModel.messageHeaderHash(message),
    messageHash: ReplyBodyRetirementModel.messageHash(message),
    requestHash: ReplyBodyRetirementModel.requestHash(message),
    createdAt: message.created_at,
  }
  const receipt = value.receipt
  const transport = receipt
    ? Schema.decodeUnknownSync(KernelDeliverySchema.TextBinding)(receipt.binding, { onExcessProperty: "error" })
    : null
  if (
    receipt &&
    (!transport ||
      receipt.body_state !== "live" ||
      receipt.binding_hash !== ReplyBodyRetirementModel.hash(transport) ||
      receipt.wire_id !== transport.wireID ||
      receipt.created_at !== transport.createdAt ||
      transport.createdAt !== message.created_at ||
      transport.messageID !== message.id ||
      transport.groupID !== message.group_id ||
      transport.workspaceID !== value.group?.workspace_id ||
      transport.messageHash !== identity.messageHash ||
      transport.textHash !== ReplyBodyRetirementModel.hash(`[Agent·${message.sender_id}] ${message.content}`))
  )
    throw invalid()
  const wire = JSON.stringify({ content: `[Agent·${message.sender_id}] ${message.content}` })
  // Reuse the original strict text envelope codec. The larger custody budget
  // cannot make an old oversized or invalid-Unicode transport body legitimate.
  if (transport) KernelReaderSchema.wireContent(wire, "jg:text", transport.expiresAt)
  return ReplyBodyRetirementModel.bind(
    record,
    identity,
    transport
      ? {
          binding: transport,
          bindingHash: receipt!.binding_hash,
          wireHash: ReplyBodyRetirementModel.bodyHash(wire),
          wireBytes: ReplyBodyRetirementModel.utf8(wire),
        }
      : null,
  )
}

export const read = (db: Reader, outboxID: string, checkMutable = true) =>
  Effect.gen(function* () {
    const size = yield* db.get<{ bytes: number }>(
      sql`SELECT length(CAST(record AS BLOB)) bytes FROM im_reply_body WHERE outbox_id=${outboxID}`,
    )
    if (!size || size.bytes > ReplyBodyRetirementModel.SUMMARY_BYTES) return yield* invalid()
    const body = yield* db.select().from(IMReplyBodyTable).where(eq(IMReplyBodyTable.outbox_id, outboxID)).get()
    const meter = yield* currentMeter(db)
    const value = yield* actual(db, outboxID)
    if (!body) return yield* invalid()
    return yield* bounded(() => validateStored(value, body, meter, checkMutable))
  })
export function validateStored(
  value: Effect.Success<ReturnType<typeof actual>>,
  body: Ledger,
  meter: Effect.Success<ReturnType<typeof currentMeter>>,
  checkMutable = true,
) {
  const record = ReplyBodyRetirementModel.decode(body.record, body.record_hash)
  if (
    record.custodyID !== meter.custody_id ||
    !ReplyBodyRetirementModel.exactOrigin(record, value.outbox) ||
    body.origin_kind !== record.origin.kind ||
    body.origin_identity_hash !== record.originHash ||
    body.message_identity_hash !== ReplyBodyRetirementModel.messageIdentityHash(record.message) ||
    body.transport_identity_hash !== ReplyBodyRetirementModel.transportIdentityHash(record.transport) ||
    body.body_state !== record.bodyState ||
    body.custody_state !== record.custody ||
    body.local_message_id !== (value.message?.id ?? null) ||
    body.receipt_message_id !== (value.receipt?.message_id ?? null) ||
    body.group_ref !== (value.group?.id ?? null) ||
    body.original_expires_at !== (record.transport?.binding.expiresAt ?? null) ||
    body.retired_at !== record.retiredAt ||
    body.created_at !== value.outbox.time_created ||
    body.accounted_records !== 2 + Number(!!value.message) + Number(!!value.receipt) ||
    value.outbox.body_state !== record.bodyState ||
    (record.message &&
      (!value.message || ReplyBodyRetirementModel.messageHeaderHash(value.message) !== record.message.headerHash)) ||
    (record.transport &&
      (!value.receipt ||
        value.receipt.binding_hash !== record.transport.bindingHash ||
        value.receipt.wire_id !== record.transport.binding.wireID))
  )
    throw invalid()
  if (record.bodyState === "retired") {
    if (
      !value.message ||
      !value.receipt ||
      !record.transport ||
      value.outbox.reply_text !== "" ||
      value.outbox.status !== "delivered" ||
      value.outbox.time_delivered === null ||
      value.outbox.lease_owner !== null ||
      value.outbox.lease_expires_at !== null ||
      value.message.content !== "" ||
      value.message.deleted_at !== record.retiredAt ||
      value.receipt.binding !== null ||
      value.receipt.body_state !== "retired" ||
      value.receipt.state !== "acknowledged"
    )
      throw invalid()
  }
  if (record.bodyState === "live") {
    if (
      ReplyBodyRetirementModel.bodyHash(value.outbox.reply_text) !== record.origin.replyHash ||
      ReplyBodyRetirementModel.utf8(value.outbox.reply_text) !== record.origin.replyBytes
    )
      throw invalid()
    const captured = value.message
      ? binding(value, { ...record, custody: record.transport ? "kernel" : "local" })
      : record
    if (
      (captured.message &&
        ReplyBodyRetirementModel.messageIdentityHash(captured.message) !== body.message_identity_hash) ||
      (captured.transport &&
        ReplyBodyRetirementModel.transportIdentityHash(captured.transport) !== body.transport_identity_hash)
    )
      throw invalid()
  }
  if (
    checkMutable &&
    (body.mutable_facts_hash !==
      ReplyBodyRetirementModel.factsHash(value.rawOutbox, value.rawMessage, value.rawReceipt) ||
      body.accounted_bytes !== value.bytes + ReplyBodyRetirementModel.accounting([body]) ||
      meter.used_records < 1 + body.accounted_records ||
      meter.used_bytes < 76 + body.accounted_bytes)
  )
    throw invalid()
  return { ...value, body, record, meter }
}

export const initialize = (tx: Tx, outboxID: string) =>
  Effect.gen(function* () {
    const value = yield* actual(tx, outboxID)
    const meter = yield* currentMeter(tx)
    const observedBasis = yield* origin(tx, value.outbox)
    const basis = value.group
      ? observedBasis
      : {
          kind: "legacy_unbound" as const,
          basisHash: ReplyBodyRetirementModel.hash(["missing-original-group", observedBasis]),
        }
    const originalOrigin = {
      outboxID: value.outbox.id,
      deliveryMessageID: ReplyDeliveryID.fromOutbox(value.outbox.id),
      sessionID: value.outbox.session_id,
      groupID: value.outbox.group_id,
      agentID: value.outbox.agent_id,
      triggerMessageID: value.outbox.trigger_message_id,
      replyMessageID: value.outbox.reply_message_id,
      createdAt: value.outbox.time_created,
      replyHash: ReplyBodyRetirementModel.bodyHash(value.outbox.reply_text),
      replyBytes: ReplyBodyRetirementModel.utf8(value.outbox.reply_text),
      ...basis,
    }
    const initial = yield* bounded(() =>
      ReplyBodyRetirementModel.validate({
        version: 1,
        custodyID: meter.custody_id,
        origin: originalOrigin,
        originHash: ReplyBodyRetirementModel.originHash(originalOrigin),
        message: null,
        transport: null,
        custody: value.group ? "unbound" : "legacy_unbound",
        bodyState: "live",
        retiredAt: null,
      }),
    )
    const record = value.message ? yield* bounded(() => binding(value, initial)) : initial
    const encoded = yield* bounded(() => ReplyBodyRetirementModel.encode(record))
    const body = {
      outbox_id: outboxID,
      meter_id: 1,
      version: 1,
      origin_kind: record.origin.kind,
      custody_state: record.custody,
      body_state: record.bodyState,
      group_ref: value.group?.id ?? null,
      local_message_id: value.message?.id ?? null,
      receipt_message_id: value.receipt?.message_id ?? null,
      original_expires_at: record.transport?.binding.expiresAt ?? null,
      retired_at: null,
      origin_identity_hash: record.originHash,
      message_identity_hash: ReplyBodyRetirementModel.messageIdentityHash(record.message),
      transport_identity_hash: ReplyBodyRetirementModel.transportIdentityHash(record.transport),
      record: encoded.record,
      record_hash: encoded.recordHash,
      mutable_facts_hash: ReplyBodyRetirementModel.factsHash(value.rawOutbox, value.rawMessage, value.rawReceipt),
      local_revision: 1,
      accounted_records: 2 + Number(!!value.message) + Number(!!value.receipt),
      accounted_bytes: 0,
      created_at: value.outbox.time_created,
      updated_at: value.outbox.time_updated,
    }
    const total = value.bytes + (yield* bounded(() => ReplyBodyRetirementModel.accounting([body])))
    yield* reserve(tx, meter, body.accounted_records, total)
    yield* tx
      .insert(IMReplyBodyTable)
      .values({ ...body, accounted_bytes: total })
      .run()
    yield* read(tx, outboxID)
  })

export const refresh = (tx: Tx, outboxID: string) =>
  Effect.gen(function* () {
    const original = yield* read(tx, outboxID, false)
    if (original.record.bodyState !== "live") return yield* invalid()
    yield* rewrite(tx, original, original.record)
  })
export const bindMessage = (tx: Tx, messageID: string) =>
  Effect.gen(function* () {
    const owner = yield* tx
      .select({ id: IMReplyOutboxTable.id })
      .from(IMReplyOutboxTable)
      .where(eq(IMReplyOutboxTable.delivery_message_id, messageID))
      .get()
    if (!owner) return
    const body = yield* tx.select().from(IMReplyBodyTable).where(eq(IMReplyBodyTable.outbox_id, owner.id)).get()
    if (!body) return yield* invalid()
    const record = yield* bounded(() => ReplyBodyRetirementModel.decode(body.record, body.record_hash))
    yield* bounded(() => ReplyBodyRetirementModel.requireLive(record))
    const meter = yield* currentMeter(tx)
    const value = yield* actual(tx, owner.id)
    if (!ReplyBodyRetirementModel.exactOrigin(record, value.outbox) || record.origin.kind === "legacy_unbound")
      return yield* invalid()
    const bound = yield* bounded(() => binding(value, record))
    yield* rewrite(tx, { ...value, body, record, meter }, bound)
  })
export const forMessage = (db: Reader, messageID: string, checkMutable = true) =>
  Effect.gen(function* () {
    const owner = yield* db
      .select({ id: IMReplyOutboxTable.id })
      .from(IMReplyOutboxTable)
      .where(eq(IMReplyOutboxTable.delivery_message_id, messageID))
      .get()
    const orphan = yield* db
      .select({ id: IMReplyBodyTable.outbox_id })
      .from(IMReplyBodyTable)
      .where(eq(IMReplyBodyTable.local_message_id, messageID))
      .get()
    if (!owner) {
      if (orphan) return yield* invalid()
      return undefined
    }
    return yield* read(db, owner.id, checkMutable)
  })
export const refreshMessage = (tx: Tx, messageID: string) =>
  Effect.gen(function* () {
    const owner = yield* tx
      .select({ id: IMReplyOutboxTable.id })
      .from(IMReplyOutboxTable)
      .where(eq(IMReplyOutboxTable.delivery_message_id, messageID))
      .get()
    if (owner) yield* refresh(tx, owner.id)
  })
export const preflight = (db: Reader, messageID: string) =>
  Effect.gen(function* () {
    const value = yield* forMessage(db, messageID)
    if (!value) return
    yield* bounded(() => ReplyBodyRetirementModel.requireLive(value.record))
    if (value.record.origin.kind === "legacy_unbound") return yield* invalid()
  })
export const exactCollected = (
  db: Reader,
  input: {
    sessionID: string
    replyMessageID?: string
    id?: string
    groupID?: string
    agentID?: string
    triggerMessageID?: string
  },
) =>
  Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(IMReplyOutboxTable)
      .where(
        input.id
          ? eq(IMReplyOutboxTable.id, input.id)
          : and(
              eq(IMReplyOutboxTable.session_id, input.sessionID),
              eq(IMReplyOutboxTable.reply_message_id, input.replyMessageID!),
            ),
      )
      .get()
    if (!row) return false
    const value = yield* read(db, row.id)
    if (
      row.session_id !== input.sessionID ||
      (input.replyMessageID !== undefined && row.reply_message_id !== input.replyMessageID) ||
      (input.groupID !== undefined && row.group_id !== input.groupID) ||
      (input.agentID !== undefined && row.agent_id !== input.agentID) ||
      (input.triggerMessageID !== undefined && row.trigger_message_id !== input.triggerMessageID)
    )
      return yield* invalid()
    return value.record.bodyState === "retired"
  })
export const retire = (tx: Tx, outboxID: string, serverNow: number) =>
  Effect.gen(function* () {
    const original = yield* read(tx, outboxID)
    const record = yield* bounded(() =>
      ReplyBodyRetirementModel.retire(
        original.record,
        original.outbox.status,
        original.receipt?.state ?? "",
        serverNow,
      ),
    )
    if (!record || original.record.bodyState === "retired") return false
    if (!original.message || !original.receipt || record.retiredAt === null) return yield* invalid()
    const message = yield* tx
      .update(MessageTable)
      .set({ content: "", deleted_at: record.retiredAt, updated_at: Math.max(Date.now(), original.message.updated_at) })
      .where(
        and(
          eq(MessageTable.id, original.message.id),
          eq(MessageTable.content, original.message.content),
          isNullRaw("deleted_at"),
          eq(MessageTable.updated_at, original.message.updated_at),
        ),
      )
      .returning()
      .get()
    const outbox = yield* tx
      .update(IMReplyOutboxTable)
      .set({ reply_text: "", body_state: "retired" })
      .where(
        and(
          eq(IMReplyOutboxTable.id, outboxID),
          eq(IMReplyOutboxTable.status, "delivered"),
          eq(IMReplyOutboxTable.body_state, "live"),
          eq(IMReplyOutboxTable.reply_text, original.outbox.reply_text),
          eq(IMReplyOutboxTable.time_updated, original.outbox.time_updated),
        ),
      )
      .returning()
      .get()
    const receipt = yield* tx
      .update(IMKernelDeliveryTable)
      .set({ binding: null, body_state: "retired" })
      .where(
        and(
          eq(IMKernelDeliveryTable.message_id, original.receipt.message_id),
          eq(IMKernelDeliveryTable.state, "acknowledged"),
          eq(IMKernelDeliveryTable.body_state, "live"),
          eq(IMKernelDeliveryTable.binding_hash, original.receipt.binding_hash),
          eq(IMKernelDeliveryTable.updated_at, original.receipt.updated_at),
        ),
      )
      .returning()
      .get()
    if (!message || !outbox || !receipt) return yield* invalid()
    const actualAfter = yield* actual(tx, outboxID)
    yield* rewrite(tx, { ...actualAfter, body: original.body, record: original.record, meter: original.meter }, record)
    yield* read(tx, outboxID)
    return true
  })
const isNullRaw = (field: string) => sql.raw(`"im_messages"."${field}" IS NULL`)
function rewrite(tx: Tx, original: Effect.Success<ReturnType<typeof read>>, record: ReplyBodyRetirementModel.Record) {
  return Effect.gen(function* () {
    const encoded = yield* bounded(() => ReplyBodyRetirementModel.encode(record))
    const update = {
      ...original.body,
      custody_state: record.custody,
      body_state: record.bodyState,
      local_message_id: original.message?.id ?? null,
      receipt_message_id: original.receipt?.message_id ?? null,
      original_expires_at: record.transport?.binding.expiresAt ?? null,
      retired_at: record.retiredAt,
      message_identity_hash: ReplyBodyRetirementModel.messageIdentityHash(record.message),
      transport_identity_hash: ReplyBodyRetirementModel.transportIdentityHash(record.transport),
      record: encoded.record,
      record_hash: encoded.recordHash,
      mutable_facts_hash: ReplyBodyRetirementModel.factsHash(
        original.rawOutbox,
        original.rawMessage,
        original.rawReceipt,
      ),
      local_revision: original.body.local_revision + 1,
      accounted_records: 2 + Number(!!original.message) + Number(!!original.receipt),
      accounted_bytes: 0,
      updated_at: Date.now(),
    }
    const total = original.bytes + (yield* bounded(() => ReplyBodyRetirementModel.accounting([update])))
    yield* reserve(
      tx,
      original.meter,
      update.accounted_records - original.body.accounted_records,
      total - original.body.accounted_bytes,
    )
    const changed = yield* tx
      .update(IMReplyBodyTable)
      .set({ ...update, accounted_bytes: total })
      .where(
        and(
          eq(IMReplyBodyTable.outbox_id, original.body.outbox_id),
          eq(IMReplyBodyTable.local_revision, original.body.local_revision),
        ),
      )
      .returning()
      .get()
    if (!changed) return yield* invalid()
  })
}
function reserve(tx: Tx, meter: Effect.Success<ReturnType<typeof currentMeter>>, records: number, bytes: number) {
  return Effect.gen(function* () {
    if (
      !Number.isSafeInteger(records) ||
      !Number.isSafeInteger(bytes) ||
      meter.revision >= Number.MAX_SAFE_INTEGER ||
      meter.used_records + records < 1 ||
      meter.used_records + records > ReplyBodyRetirementModel.RECORD_LIMIT ||
      meter.used_bytes + bytes < 76 ||
      meter.used_bytes + bytes > ReplyBodyRetirementModel.BYTE_LIMIT
    )
      return yield* ReplyBodyRetirementModel.capacity()
    const changed = yield* tx
      .update(IMReplyBodyMeterTable)
      .set({
        revision: meter.revision + 1,
        used_records: meter.used_records + records,
        used_bytes: meter.used_bytes + bytes,
      })
      .where(
        and(
          eq(IMReplyBodyMeterTable.meter_id, 1),
          eq(IMReplyBodyMeterTable.revision, meter.revision),
          eq(IMReplyBodyMeterTable.used_records, meter.used_records),
          eq(IMReplyBodyMeterTable.used_bytes, meter.used_bytes),
        ),
      )
      .returning()
      .get()
    if (!changed) return yield* invalid()
  })
}
