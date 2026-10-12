export * as ReplyBodyRetirementModel from "./reply-body-retirement.model"

import { createHash } from "node:crypto"
import { Schema } from "effect"
import { CanonicalJson } from "../util/canonical-json"
import { KernelDeliverySchema } from "./kernel-delivery.schema"
import { ReplyDeliveryID } from "./reply-delivery-id"

export const RECORD_LIMIT = 100_000
export const BYTE_LIMIT = 268_435_456
export const SUMMARY_BYTES = 65_536
export const PAGE_LIMIT = 32
export const METER_BYTES = 76
export const hash = (value: unknown) => createHash("sha256").update(CanonicalJson.stringify(value)).digest("hex")
export const bodyHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
export const utf8 = (value: string) => Buffer.byteLength(value, "utf8")
export const OriginKind = Schema.Literals(["mention", "work_result", "status_notice", "dac_session", "legacy_unbound"])
export const Custody = Schema.Literals(["unbound", "local", "kernel", "legacy_unbound"])
const UUID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const Bytes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: BYTE_LIMIT }))

export const Origin = Schema.Struct({
  outboxID: Schema.String,
  deliveryMessageID: Schema.String,
  sessionID: Schema.String,
  groupID: Schema.String,
  agentID: Schema.String,
  triggerMessageID: Schema.NullOr(Schema.String),
  replyMessageID: Schema.String,
  createdAt: KernelDeliverySchema.Time,
  replyHash: KernelDeliverySchema.Hash,
  replyBytes: Bytes,
  kind: OriginKind,
  basisHash: KernelDeliverySchema.Hash,
}).check(Schema.makeFilter((value) => value.deliveryMessageID === ReplyDeliveryID.fromOutbox(value.outboxID)))
export type Origin = typeof Origin.Type
export const MessageIdentity = Schema.Struct({
  messageID: Schema.String,
  headerHash: KernelDeliverySchema.Hash,
  messageHash: KernelDeliverySchema.Hash,
  requestHash: KernelDeliverySchema.Hash,
  createdAt: KernelDeliverySchema.Time,
})
export type MessageIdentity = typeof MessageIdentity.Type
// Text v1 Binding contains only original identity, never the communication body.
export const TransportIdentity = Schema.Struct({
  binding: KernelDeliverySchema.TextBinding,
  bindingHash: KernelDeliverySchema.Hash,
  wireHash: KernelDeliverySchema.Hash,
  wireBytes: Bytes.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(65536)),
}).check(
  Schema.makeFilter(
    (value) =>
      value.bindingHash === hash(value.binding) &&
      value.binding.expiresAt === value.binding.createdAt + 259_200_000 &&
      value.binding.wireID === `dac_${hash(["im-kernel-wire-v1", value.binding.source, value.binding.messageID])}`,
  ),
)
export type TransportIdentity = typeof TransportIdentity.Type
export const Record = Schema.Struct({
  version: Schema.Literal(1),
  custodyID: UUID,
  origin: Origin,
  originHash: KernelDeliverySchema.Hash,
  message: Schema.NullOr(MessageIdentity),
  transport: Schema.NullOr(TransportIdentity),
  custody: Custody,
  bodyState: Schema.Literals(["live", "retired"]),
  retiredAt: Schema.NullOr(KernelDeliverySchema.Time),
}).check(
  Schema.makeFilter(
    (value) =>
      value.originHash === originHash(value.origin) &&
      (value.message === null || value.message.messageID === value.origin.deliveryMessageID) &&
      (value.transport === null ||
        (value.message !== null &&
          value.transport.binding.messageID === value.message.messageID &&
          value.transport.binding.groupID === value.origin.groupID &&
          value.transport.binding.messageHash === value.message.messageHash)) &&
      (value.custody === "kernel"
        ? value.message !== null && value.transport !== null
        : value.custody === "local"
          ? value.message !== null && value.transport === null
          : value.message === null && value.transport === null) &&
      (value.custody !== "legacy_unbound" || value.origin.kind === "legacy_unbound") &&
      (value.bodyState === "live"
        ? value.retiredAt === null
        : value.custody === "kernel" &&
          value.transport !== null &&
          value.retiredAt === value.transport.binding.expiresAt),
  ),
)
export type Record = typeof Record.Type
export class Error extends Schema.TaggedErrorClass<Error>()("ReplyBodyRetirement.Error", {
  code: Schema.Literals(["IM_REPLY_BODY_INVALID", "IM_REPLY_BODY_CAPACITY", "KERNEL_DELIVERY_RETIRED"]),
  message: Schema.String,
}) {}
export const invalid = () =>
  new Error({ code: "IM_REPLY_BODY_INVALID", message: "Original reply body custody is unavailable" })
export const capacity = () =>
  new Error({ code: "IM_REPLY_BODY_CAPACITY", message: "Reply body custody capacity is exhausted" })
export const originHash = (origin: Origin) => hash(["deepagent.im.reply-body.origin.v1", origin])
export const recordHash = (record: Record) => hash(["deepagent.im.reply-body.record.v1", record])
export const messageIdentityHash = (message: MessageIdentity | null) =>
  message === null ? null : hash(["deepagent.im.reply-body.message.v1", message])
export const transportIdentityHash = (transport: TransportIdentity | null) =>
  transport === null ? null : hash(["deepagent.im.reply-body.transport.v1", transport])

/** Immutable identity excludes every field legitimately changed by ACK or body
 * retirement. The original full messageHash is captured once, never recomputed
 * from an empty caption. Parsed metadata identity and raw SQL fact bytes have
 * deliberately different purposes. */
export const messageHeaderHash = (value: {
  id: string
  group_id: string
  sender_id: string
  sender_type: string
  type: string
  mentions: unknown
  metadata: unknown
  reply_to_id: string | null
  client_request_id: string | null
  created_at: number
}) =>
  hash([
    value.id,
    value.group_id,
    value.sender_id,
    value.sender_type,
    value.type,
    value.mentions,
    value.metadata,
    value.reply_to_id,
    value.client_request_id,
    value.created_at,
  ])
export const messageHash = (value: {
  id: string
  group_id: string
  sender_id: string
  sender_type: string
  type: string
  content: string
  mentions: unknown
  metadata: unknown
  reply_to_id: string | null
  created_at: number
}) =>
  hash([
    value.id,
    value.group_id,
    value.sender_id,
    value.sender_type,
    value.type,
    value.content,
    value.mentions,
    value.metadata,
    value.reply_to_id,
    value.created_at,
  ])
export const requestHash = (value: {
  group_id: string
  sender_id: string
  sender_type: string
  type: string
  content: string
  mentions: unknown
  metadata: unknown
  reply_to_id: string | null
}) =>
  hash([
    value.group_id,
    value.sender_id,
    value.sender_type,
    value.type,
    value.content,
    value.mentions,
    value.metadata,
    value.reply_to_id,
  ])
export type RawRow = Readonly<{ [key: string]: string | number | null }>
/** Supply full actual raw SQL rows, including Message mutable fields and actual
 * JSON bytes. A ledger hash cannot authorize anything or hide a missing copy. */
export const factsHash = (outbox: RawRow, message: RawRow | null, receipt: RawRow | null) =>
  hash(["deepagent.im.reply-body.facts.v1", outbox, message, receipt])
export function accounting(rows: readonly RawRow[]) {
  const total = rows.reduce(
    (sum, row) =>
      sum +
      Object.values(row).reduce<number>((bytes, value) => {
        if (value === null) return bytes
        if (typeof value === "string") return bytes + utf8(value)
        if (!Number.isSafeInteger(value)) throw invalid()
        return bytes + 8
      }, 0),
    0,
  )
  if (!Number.isSafeInteger(total) || total > BYTE_LIMIT) throw capacity()
  return total
}
export function validate(value: unknown) {
  const record = Schema.decodeUnknownSync(Record)(value, { onExcessProperty: "error" })
  if (utf8(CanonicalJson.stringify(record)) > SUMMARY_BYTES) throw capacity()
  return record
}
export const encode = (record: Record) => {
  const value = validate(record)
  return { record: CanonicalJson.stringify(value), recordHash: recordHash(value) }
}
export function decode(record: string, digest: string) {
  if (utf8(record) > SUMMARY_BYTES) throw capacity()
  const value = validate(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(record))
  if (record !== CanonicalJson.stringify(value) || digest !== recordHash(value)) throw invalid()
  return value
}
export function requireLive(record: Record) {
  const value = validate(record)
  if (value.bodyState === "retired")
    throw new Error({
      code: "KERNEL_DELIVERY_RETIRED",
      message: "The original reply body has expired; it cannot be sent again",
    })
}
export function bind(record: Record, message: MessageIdentity, transport: TransportIdentity | null) {
  requireLive(record)
  if (
    record.custody === "legacy_unbound" ||
    (record.message !== null && messageIdentityHash(record.message) !== messageIdentityHash(message)) ||
    (record.transport !== null && transportIdentityHash(record.transport) !== transportIdentityHash(transport))
  )
    throw invalid()
  return validate({ ...record, message, transport, custody: transport === null ? "local" : "kernel" })
}
/** Pure eligibility only. Production supplies its actual private SDK clock and
 * double current fences; an arbitrary caller timestamp is never authority. */
export function retire(record: Record, status: string, transportState: string, serverNow: number) {
  const value = validate(record)
  Schema.decodeUnknownSync(KernelDeliverySchema.Time)(serverNow)
  if (value.bodyState === "retired") return value
  if (
    value.origin.kind === "legacy_unbound" ||
    value.transport === null ||
    status !== "delivered" ||
    transportState !== "acknowledged" ||
    serverNow < value.transport.binding.expiresAt
  )
    return undefined
  return validate({ ...value, bodyState: "retired", retiredAt: value.transport.binding.expiresAt })
}
export const exactOrigin = (
  record: Record,
  value: {
    id: string
    session_id: string
    group_id: string
    agent_id: string
    trigger_message_id: string | null
    reply_message_id: string
    delivery_message_id: string | null
    time_created: number
  },
) =>
  record.origin.outboxID === value.id &&
  record.origin.sessionID === value.session_id &&
  record.origin.groupID === value.group_id &&
  record.origin.agentID === value.agent_id &&
  record.origin.triggerMessageID === value.trigger_message_id &&
  record.origin.replyMessageID === value.reply_message_id &&
  record.origin.deliveryMessageID === value.delivery_message_id &&
  record.origin.createdAt === value.time_created
