export * as KernelMediaRetirement from "./kernel-media-retirement"

import { and, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { KernelDeliverySchema } from "./kernel-delivery.schema"
import { IMKernelDeliveryTable } from "./kernel-delivery.sql"
import { KernelMediaRetirementModel } from "./kernel-media-retirement.model"
import { IMKernelMediaBodyTable, IMKernelMediaMeterTable } from "./kernel-media-retirement.sql"
import { GroupTable, MessageTable } from "./sql"

type Db = Database.Interface["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Db | Tx
type Receipt = typeof IMKernelDeliveryTable.$inferSelect
type Ledger = typeof IMKernelMediaBodyTable.$inferSelect
type Message = typeof MessageTable.$inferSelect

const failure = () => new KernelMediaRetirementModel.Error({ code: "KERNEL_MEDIA_BODY_INVALID", message: "Original media body custody is unavailable" })
const bounded = <A>(body: () => A) => Effect.try({ try: body, catch: (error) => error instanceof KernelMediaRetirementModel.Error ? error : failure() })

export const transport = (row: Receipt): KernelMediaRetirementModel.Transport => ({
  state: row.state, dispatchOwner: row.dispatch_owner, kernelMessageID: row.kernel_message_id, reason: row.reason,
  createdAt: row.created_at, dispatchedAt: row.dispatched_at, acknowledgedAt: row.acknowledged_at, updatedAt: row.updated_at,
})

/** Exact SQL column inventory. JSON stays its actual stored text: parsed JSON
 * would lose legacy whitespace/escapes and could silently undercharge a copy. */
const receiptStrings = ["message_id", "binding", "body_state", "binding_hash", "wire_id", "state", "dispatch_owner", "kernel_message_id", "reason"]
const receiptIntegers = ["created_at", "dispatched_at", "acknowledged_at", "updated_at"]
const messageStrings = ["id", "group_id", "sender_id", "sender_type", "type", "content", "mentions", "metadata", "reply_to_id", "event_id", "delivery_status", "kernel_msg_id", "client_request_id"]
const messageIntegers = ["created_at", "updated_at", "deleted_at"]
const bodyStrings = ["message_id", "workspace_id", "group_id", "source_hash", "body_state", "record", "record_hash", "identity_hash"]
const bodyIntegers = ["meter_id", "version", "expires_at", "local_revision", "retired_at", "accounted_records", "accounted_bytes"]
const bytes = (alias: string, strings: readonly string[], integers: readonly string[]) => sql.raw([
  ...strings.map((column) => `coalesce(length(CAST(${alias}."${column}" AS BLOB)),0)`),
  ...integers.map((column) => `CASE WHEN ${alias}."${column}" IS NULL THEN 0 ELSE 8 END`),
].join("+"))
export const receiptMessageBytes = sql`${bytes("d", receiptStrings, receiptIntegers)}+${bytes("m", messageStrings, messageIntegers)}`
/** Old table has no body_state yet; its new live value is exactly four bytes. */
export const legacyReceiptMessageBytes = sql`${bytes("d", receiptStrings.filter((field) => field !== "body_state"), receiptIntegers)}+4+${bytes("m", messageStrings, messageIntegers)}`
export const ledgerBytes = bytes("b", bodyStrings, bodyIntegers)
export const joinedBytes = sql`${bytes("im_kernel_delivery", receiptStrings, receiptIntegers)}+${bytes("im_messages", messageStrings, messageIntegers)}+${bytes("im_kernel_media_body", bodyStrings, bodyIntegers)}`
export const METER_BYTES = 76

const copies = (db: Reader, messageID: string, withLedger = false) => db.get<{ bytes: number; bindingBytes: number }>(sql`
  SELECT ${receiptMessageBytes}${withLedger ? sql`+${ledgerBytes}` : sql``} bytes,
    coalesce(length(CAST(d.binding AS BLOB)),0) bindingBytes
  FROM im_kernel_delivery d JOIN im_messages m ON m.id=d.message_id
  ${withLedger ? sql`JOIN im_kernel_media_body b ON b.message_id=d.message_id` : sql``}
  WHERE d.message_id=${messageID}`)

export const currentMeter = (db: Reader) => Effect.gen(function* () {
  const row = yield* db.select().from(IMKernelMediaMeterTable).where(eq(IMKernelMediaMeterTable.meter_id, 1)).get()
  if (!row || row.version !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
    !Number.isSafeInteger(row.used_records) || row.used_records < 1 || row.used_records > KernelMediaRetirementModel.RECORD_LIMIT ||
    !Number.isSafeInteger(row.used_bytes) || row.used_bytes < METER_BYTES || row.used_bytes > KernelMediaRetirementModel.BYTE_LIMIT ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.custody_id)) return yield* failure()
  return row
})

/** Never a permission source. Storage validates both halves of custody, even
 * for cold historical reads; a missing half is corruption, never a new send. */
export const read = (db: Reader, receipt: Receipt, checkAccounting = true) => Effect.gen(function* () {
  const count = yield* db.get<{ bytes: number }>(sql`SELECT length(CAST(record AS BLOB)) bytes FROM im_kernel_media_body WHERE message_id=${receipt.message_id}`)
  if (count && count.bytes > KernelMediaRetirementModel.SUMMARY_BYTES) return yield* failure()
  const body = yield* db.select().from(IMKernelMediaBodyTable).where(eq(IMKernelMediaBodyTable.message_id, receipt.message_id)).get()
  if (!body) {
    if (receipt.body_state !== "live" || receipt.binding?.version === 2) return yield* failure()
    return undefined
  }
  const meter = yield* currentMeter(db)
  const message = yield* db.select().from(MessageTable).where(sql`${MessageTable.id}=${receipt.message_id}`).get()
  const group = message && (yield* db.select().from(GroupTable).where(eq(GroupTable.id, message.group_id)).get())
  const measured = checkAccounting ? yield* copies(db, receipt.message_id, true) : undefined
  if (!message || !group) return yield* failure()
  return yield* bounded(() => validateStored({ receipt, body, meter, message, group, bytes: checkAccounting ? measured?.bytes ?? null : undefined }))
})

/** The status page supplies one joined SELECT, including actual BLOB lengths.
 * This validation is a storage oracle, never a source of current permissions. */
export function validateStored(input: { receipt: Receipt; body: Ledger | null; meter: typeof IMKernelMediaMeterTable.$inferSelect | null;
  message: Message; group: typeof GroupTable.$inferSelect; bytes?: number | null }) {
  const body = input.body
  if (!body) {
    if (input.receipt.body_state !== "live" || input.receipt.binding?.version === 2) throw failure()
    return undefined
  }
  const meter = input.meter
  if (!meter || meter.meter_id !== 1 || meter.version !== 1 || !Number.isSafeInteger(meter.used_records) || meter.used_records < 4 ||
    meter.used_records > KernelMediaRetirementModel.RECORD_LIMIT || !Number.isSafeInteger(meter.used_bytes) ||
    meter.used_bytes < METER_BYTES || meter.used_bytes > KernelMediaRetirementModel.BYTE_LIMIT ||
    !Number.isSafeInteger(meter.revision) || meter.revision < 1 || typeof body.record !== "string") throw failure()
  const record = KernelMediaRetirementModel.decode({ record: body.record, recordHash: body.record_hash, identityHash: body.identity_hash,
    custodyID: meter.custody_id, messageID: input.receipt.message_id, bindingHash: input.receipt.binding_hash, wireID: input.receipt.wire_id,
    bodyState: input.receipt.body_state, bindingPresent: input.receipt.binding !== null, retiredAt: body.retired_at, transport: transport(input.receipt) })
  const message = input.message
  if (body.meter_id !== 1 || body.version !== 1 || body.accounted_records !== KernelMediaRetirementModel.OWNED_RECORDS ||
    !Number.isSafeInteger(body.local_revision) || body.local_revision < 1 || body.local_revision > Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(body.accounted_bytes) || body.accounted_bytes < 1 || body.accounted_bytes > KernelMediaRetirementModel.BYTE_LIMIT ||
    body.body_state !== record.bodyState || body.group_id !== record.identity.groupID || body.workspace_id !== record.identity.workspaceID ||
    body.source_hash !== record.identity.sourceHash || body.expires_at !== record.identity.expiresAt ||
    message.group_id !== body.group_id || input.group.workspace_id !== body.workspace_id || message.type !== "file" ||
    KernelMediaRetirementModel.messageHeaderHash(message) !== record.identity.messageHeaderHash ||
    record.bodyState === "retired" && (message.content !== "" || message.deleted_at !== record.identity.expiresAt) ||
    record.bodyState === "live" && (input.receipt.binding?.version !== 2 || message.deleted_at !== null ||
      KernelMediaRetirementModel.hash(input.receipt.binding) !== record.identity.bindingHash ||
      KernelMediaRetirementModel.messageHash(message) !== record.identity.messageHash ||
      KernelMediaRetirementModel.hash(input.receipt.binding.source) !== record.identity.sourceHash) ||
    input.bytes !== undefined && (input.bytes !== body.accounted_bytes || meter.used_records < 1 + body.accounted_records ||
      meter.used_bytes < METER_BYTES + body.accounted_bytes)) throw failure()
  return { body, record, meter, message }
}

/** Same transaction as the actual insert. Every v2 record prepays its future
 * historical summary; retirement cannot discard obligations to find capacity. */
export const initialize = (tx: Tx, receipt: Receipt, message: Message) => Effect.gen(function* () {
  if (receipt.binding?.version !== 2 || receipt.body_state !== "live") return yield* failure()
  const meter = yield* currentMeter(tx)
  const measured = yield* copies(tx, receipt.message_id)
  if (!measured || measured.bytes > KernelMediaRetirementModel.BYTE_LIMIT) return yield* failure()
  const captured = yield* capture(receipt, message, meter.custody_id, measured.bindingBytes)
  const encoded = yield* bounded(() => KernelMediaRetirementModel.encode(captured))
  const body = { message_id: receipt.message_id, meter_id: 1, version: 1, workspace_id: captured.identity.workspaceID,
    group_id: captured.identity.groupID, source_hash: captured.identity.sourceHash, expires_at: captured.identity.expiresAt,
    body_state: "live" as const, local_revision: 1, retired_at: null, record: encoded.record,
    record_hash: encoded.recordHash, identity_hash: captured.identityHash, accounted_records: KernelMediaRetirementModel.OWNED_RECORDS,
    accounted_bytes: 0 }
  const accounted = yield* bounded(() => KernelMediaRetirementModel.accounting([bodyRow(body)]))
  const total = measured.bytes + accounted
  yield* reserve(tx, meter, body.accounted_records, total)
  yield* tx.insert(IMKernelMediaBodyTable).values({ ...body, accounted_bytes: total }).run()
  const checked = yield* read(tx, receipt)
  if (!checked) return yield* failure()
})

/** Only the four original receipt writers call this after their raw update.
 * The original ledger is compared against the original row, and all immutable
 * body identity is recaptured from actual SQL before changing its facts digest. */
export const refresh = (tx: Tx, before: Receipt) => Effect.gen(function* () {
  if (before.binding?.version !== 2) return
  const original = yield* read(tx, before, false)
  const after = yield* tx.select().from(IMKernelDeliveryTable).where(eq(IMKernelDeliveryTable.message_id, before.message_id)).get()
  if (!original || !after || original.record.bodyState !== "live" || after.body_state !== "live" ||
    after.binding_hash !== before.binding_hash || after.wire_id !== before.wire_id) return yield* failure()
  const measured = yield* copies(tx, before.message_id)
  if (!measured) return yield* failure()
  const captured = yield* capture(after, original.message, original.meter.custody_id, measured.bindingBytes)
  if (captured.identityHash !== original.record.identityHash) return yield* failure()
  yield* rewrite(tx, original, captured, measured.bytes)
})

/** Caller has proved actual current SDK clock, scope, source and membership.
 * Its final fence must run after this write before committing the whole batch. */
export const retire = (tx: Tx, before: Receipt, serverNow: number) => Effect.gen(function* () {
  const original = yield* read(tx, before)
  if (!original) return yield* failure()
  const retired = yield* bounded(() => KernelMediaRetirementModel.retire(original.record, transport(before), serverNow))
  if (!retired || retired === original.record) return false
  const cleared = yield* tx.update(MessageTable).set({ content: "", deleted_at: original.record.identity.expiresAt,
    updated_at: Math.max(original.message.updated_at, Date.now()) }).where(and(eq(MessageTable.id, original.message.id),
    eq(MessageTable.content, original.message.content), eq(MessageTable.updated_at, original.message.updated_at),
    sql`${MessageTable.deleted_at} IS NULL`)).returning().get()
  if (!cleared) return yield* failure()
  const receipt = yield* tx.update(IMKernelDeliveryTable).set({ binding: null, body_state: "retired" }).where(and(
    eq(IMKernelDeliveryTable.message_id, before.message_id), eq(IMKernelDeliveryTable.body_state, "live"),
    eq(IMKernelDeliveryTable.binding_hash, before.binding_hash), eq(IMKernelDeliveryTable.state, "acknowledged"),
    eq(IMKernelDeliveryTable.updated_at, before.updated_at))).returning().get()
  if (!receipt) return yield* failure()
  const measured = yield* copies(tx, before.message_id)
  if (!measured) return yield* failure()
  yield* rewrite(tx, original, retired, measured.bytes)
  const checked = yield* read(tx, receipt)
  if (!checked || checked.record.bodyState !== "retired") return yield* failure()
  return true
})

/** A missing receipt is not missing when a ledger still owns that message ID. */
export const assertMissing = (db: Reader, messageID: string) => Effect.gen(function* () {
  if (yield* db.select({ id: IMKernelMediaBodyTable.message_id }).from(IMKernelMediaBodyTable)
    .where(eq(IMKernelMediaBodyTable.message_id, messageID)).get()) return yield* failure()
})

function capture(receipt: Receipt, message: Message, custodyID: string, bindingBytes: number) {
  return bounded(() => {
    const binding = Schema.decodeUnknownSync(KernelDeliverySchema.MediaBinding)(receipt.binding, { onExcessProperty: "error" })
    if (receipt.body_state !== "live" || receipt.message_id !== message.id || receipt.wire_id !== binding.wireID ||
      message.group_id !== binding.groupID || message.type !== "file" || !["user", "agent"].includes(message.sender_type) ||
      message.deleted_at !== null || binding.textHash !== KernelMediaRetirementModel.hash(KernelMediaRetirementModel.wireText(message))) throw failure()
    return KernelMediaRetirementModel.capture({ custodyID, binding, bindingHash: receipt.binding_hash, bindingBytes,
      messageHash: KernelMediaRetirementModel.messageHash(message), messageHeaderHash: KernelMediaRetirementModel.messageHeaderHash(message),
      requestHash: KernelMediaRetirementModel.requestHash({ groupID: message.group_id, senderID: message.sender_id,
        senderType: message.sender_type, type: message.type, content: message.content, mentions: message.mentions,
        metadata: message.metadata, replyToID: message.reply_to_id }), clientRequestIDHash: KernelMediaRetirementModel.clientRequestIDHash(message.client_request_id),
      captionBytes: new TextEncoder().encode(message.content).byteLength, transport: transport(receipt) })
  })
}

function bodyRow(body: Ledger | Omit<Ledger, "accounted_bytes"> & { accounted_bytes: number }) {
  return Object.fromEntries([...bodyStrings, ...bodyIntegers].map((field) => [field, body[field as keyof Ledger]]))
}

function rewrite(tx: Tx, original: NonNullable<Effect.Success<ReturnType<typeof read>>>, record: KernelMediaRetirementModel.Record, otherBytes: number) {
  return Effect.gen(function* () {
    if (original.body.local_revision >= Number.MAX_SAFE_INTEGER) return yield* failure()
    const encoded = yield* bounded(() => KernelMediaRetirementModel.encode(record))
    const update = { ...original.body, body_state: record.bodyState, retired_at: record.retiredAt, local_revision: original.body.local_revision + 1,
      record: encoded.record, record_hash: encoded.recordHash, accounted_bytes: 0 }
    update.accounted_bytes = otherBytes + (yield* bounded(() => KernelMediaRetirementModel.accounting([bodyRow(update)])))
    yield* reserve(tx, original.meter, 0, update.accounted_bytes - original.body.accounted_bytes)
    const changed = yield* tx.update(IMKernelMediaBodyTable).set(update).where(and(
      eq(IMKernelMediaBodyTable.message_id, original.body.message_id), eq(IMKernelMediaBodyTable.local_revision, original.body.local_revision),
      eq(IMKernelMediaBodyTable.record_hash, original.body.record_hash), eq(IMKernelMediaBodyTable.identity_hash, original.body.identity_hash),
      eq(IMKernelMediaBodyTable.accounted_bytes, original.body.accounted_bytes))).returning().get()
    if (!changed) return yield* failure()
  })
}

function reserve(tx: Tx, meter: typeof IMKernelMediaMeterTable.$inferSelect, deltaRecords: number, deltaBytes: number) {
  return Effect.gen(function* () {
    if (meter.revision >= Number.MAX_SAFE_INTEGER) return yield* failure()
    const next = yield* bounded(() => KernelMediaRetirementModel.meter({ usedRecords: meter.used_records, usedBytes: meter.used_bytes, deltaRecords, deltaBytes }))
    if (next.usedRecords < 1 || next.usedBytes < METER_BYTES) return yield* failure()
    const changed = yield* tx.update(IMKernelMediaMeterTable).set({ revision: meter.revision + 1, used_records: next.usedRecords, used_bytes: next.usedBytes })
      .where(and(eq(IMKernelMediaMeterTable.meter_id, 1), eq(IMKernelMediaMeterTable.custody_id, meter.custody_id),
        eq(IMKernelMediaMeterTable.revision, meter.revision), eq(IMKernelMediaMeterTable.used_records, meter.used_records),
        eq(IMKernelMediaMeterTable.used_bytes, meter.used_bytes))).returning().get()
    if (!changed) return yield* failure()
  })
}
