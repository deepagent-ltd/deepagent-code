export * as KernelReaderSchema from "./kernel-reader.schema"

import { Schema } from "effect"

export const RECORD_LIMIT = 100_000
export const BYTE_LIMIT = 268_435_456
export const PAGE_LIMIT = 32
export const bytes = (value: string) => new TextEncoder().encode(value).byteLength
export const compareDecimal = (a: string, b: string) => a.length === b.length ? a === b ? 0 : a < b ? -1 : 1 : a.length - b.length
export const validDecimal = (value: string) => /^(0|[1-9][0-9]{0,18})$/.test(value) && (value.length < 19 || value <= "9223372036854775807")
export const Decimal = Schema.String.check(Schema.makeFilter(validDecimal))
export const Positive = Decimal.check(Schema.makeFilter((value) => value !== "0"))
export const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
export const Time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const text = (limit: number) => Schema.String.check(Schema.makeFilter((value) => bytes(value) > 0 && bytes(value) <= limit && !value.includes("\0") && new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value))
export const Binding = Schema.Struct({
  version: Schema.Literal(1),
  instanceID: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)),
  workspaceID: text(4096),
  realm: text(4096),
  appkey: text(2048),
  orgID: Decimal,
  userID: text(2048),
  scopeKey: Hash,
  readerVersion: Schema.optional(Schema.Literal(2)),
})
export type Binding = typeof Binding.Type
export const Visible = Schema.Struct({
  version: Schema.Literal(1),
  visibility: Schema.Literal("visible"),
  projectionKey: Hash,
  revision: Positive,
  cursor: Decimal,
  liveUnread: Decimal,
  storedUnread: Decimal,
  admittedOrdinal: Decimal,
  readOrdinal: Decimal,
  nextExpiryAt: Time,
  latestMessageId: Schema.Union([Schema.Literal(""), text(512)]),
  latestSequence: Schema.Union([Schema.Literal(""), Positive]),
  latestMessageTime: Time,
  conversationType: Schema.Literals([1, 2]),
  targetId: text(512),
}).check(Schema.makeFilter((value) => compareDecimal(value.readOrdinal, value.admittedOrdinal) <= 0 && compareDecimal(value.liveUnread, value.storedUnread) <= 0 && compareDecimal(value.storedUnread, value.admittedOrdinal) <= 0 && (value.latestMessageId === "" ? value.latestSequence === "" && value.latestMessageTime === 0 : value.latestSequence !== "" && value.latestMessageTime > 0)))
export const Revoked = Schema.Struct({ version: Schema.Literal(1), visibility: Schema.Literal("revoked"), projectionKey: Hash, revision: Positive, cursor: Decimal })
export const Pending = Schema.Struct({ version: Schema.Literal(1), visibility: Schema.Literal("pending"), sourceHash: Hash, conversationType: Schema.Literals([1, 2]), targetId: text(512), name: text(512) })
export const Metadata = Schema.Union([Visible, Revoked, Pending])
export type Metadata = typeof Metadata.Type
export const Continuation = Schema.Struct({
  version: Schema.Literal(1),
  projections: Schema.Array(Schema.Struct({ projectionKey: Hash, serverRevision: Positive, direction: Schema.Literals(["older", "newer"]), anchor: Decimal, phase: Schema.Literals(["pending", "complete"]) })).check(Schema.isMaxLength(PAGE_LIMIT)),
})
export type Continuation = typeof Continuation.Type
const MessageFields = { effectKey: Hash, messageId: text(512), sequence: Positive, deliveryCursor: Positive, messageTime: Time, expiresAt: Time, senderId: text(512), targetId: text(512), conversationType: Schema.Literals([1, 2]), content: Schema.String.check(Schema.makeFilter((value) => bytes(value) <= 65536 && !value.includes("\0") && new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value)), isSend: Schema.Boolean, isRead: Schema.Boolean }
export const MessageV1 = Schema.Struct(MessageFields).check(Schema.makeFilter((value) => value.expiresAt > value.messageTime))
export const MessageType = Schema.Literals(["jg:text", "dac:media.v1"])
export const MessageV2 = Schema.Struct({ ...MessageFields, messageType: MessageType }).check(Schema.makeFilter((value) => value.expiresAt > value.messageTime))
export const Message = Schema.Union([MessageV1, MessageV2])
export type Message = typeof Message.Type
// Retained provenance is an immutable first-seen fact, never a current task grant.
export const FirstSeen = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), origin: Schema.Literal("history") }),
  Schema.Struct({ version: Schema.Literal(1), origin: Schema.Literal("kernel_live"), receiverID: text(2048),
    transportGeneration: Schema.Int.check(Schema.isGreaterThan(0)), receivedAt: Time,
    sourceExpiresAt: Time, observationHash: Hash, sourceHash: Schema.optional(Hash) }).check(Schema.makeFilter((value) => value.sourceExpiresAt > value.receivedAt && value.sourceExpiresAt <= value.receivedAt + 86_400_000)),
])
export type FirstSeen = typeof FirstSeen.Type
export const MessageMetadata = Schema.Struct({ version: Schema.Literal(1), isSend: Schema.Boolean, isRead: Schema.Boolean,
  readerVersion: Schema.optional(Schema.Literal(2)), messageType: Schema.optional(MessageType), firstSeen: Schema.optional(FirstSeen),
}).check(Schema.makeFilter((value) => (value.readerVersion === 2) === (value.messageType !== undefined) &&
  (value.firstSeen?.origin !== "kernel_live" || !value.isSend && (value.messageType === undefined || value.messageType === "jg:text"))))
export type MessageMetadata = typeof MessageMetadata.Type
export const LiveObservation = Schema.Struct({ scopeKey: Hash, projectionKey: Hash, projectionRevision: Positive,
  sourceHash: Hash, receiverID: text(2048), transportGeneration: Schema.Int.check(Schema.isGreaterThan(0)), receivedAt: Time,
  messageID: text(512), sequence: Positive, messageTime: Time, senderID: text(512),
  conversationType: Schema.Literals([1, 2]), conversationID: text(512), wireContent: MessageFields.content,
  originalDestroyTime: Schema.optional(Time),
})
export type LiveObservation = typeof LiveObservation.Type
export const Cut = Schema.Struct({ version: Schema.Literals([1, 2]), scopeKey: Hash, projectionKey: Hash, projectionRevision: Positive, throughOrdinal: Decimal, targetAdmittedOrdinal: Decimal, readOrdinal: Decimal, liveUnread: Decimal, storedUnread: Decimal, serverNow: Time, complete: Schema.Boolean })
export type Cut = typeof Cut.Type
export const ReadActionSummary = Schema.Struct({ actionID: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)), cutID: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)), phase: Schema.Literals(["prepared", "dispatched", "unknown", "confirmed", "cancelled"]), cutIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 31 })), targetAdmitted: Decimal, throughOrdinal: Decimal, targetReached: Schema.Boolean })
export type ReadActionSummary = typeof ReadActionSummary.Type
export const GroupPosition = Schema.Struct({ createdAt: Time, id: text(512) })
export type GroupPosition = typeof GroupPosition.Type
export const GroupPageReader = Schema.Struct({ displayEpoch: Schema.String, proofWindowMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })), validatedServerNow: Schema.optional(Time), nextExpiryAt: Schema.NullOr(Time) })
export const Request = Schema.Struct({ version: Schema.Literals([1, 2]), scopeKey: Hash, projectionKey: Hash, projectionRevision: Positive, throughOrdinal: Schema.optional(Decimal) })
export const CODES = ["reader_required", "reader_upgrade_required", "reader_unavailable", "reader_stale", "reader_unknown", "reader_capacity", "reader_scope_mismatch", "reader_legacy_unverified", "reader_cleanup_required", "reader_mapping_conflict"] as const
export const Code = Schema.Literals(CODES)
export type Code = typeof Code.Type
export class Error extends Schema.TaggedErrorClass<Error>()("KernelReader.Error", { code: Code, operation: Schema.String, wireCode: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))), message: Schema.String }) {}
export const failure = (code: Code, operation: string) => new Error({ code, operation, message: "Remote conversation is currently unavailable" })
export function encode<A>(schema: Schema.Decoder<A>, value: A, budget: number) {
  const output = JSON.stringify(Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" }))
  if (bytes(output) > budget) throw failure("reader_capacity", "encode")
  return output
}
export function decode<A>(schema: Schema.Decoder<A>, value: string, budget: number): A {
  if (bytes(value) > budget) throw failure("reader_capacity", "decode")
  return Schema.decodeUnknownSync(schema)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value), { onExcessProperty: "error" })
}

// These are retained remote object facts. They never authorize a local path or bypass
// the current kernel identity and object-membership check when bytes are requested.
const AttachmentFields = {
  attachmentID: Hash,
  contentRef: Hash,
  filename: text(255).check(Schema.isPattern(/^[^/\\\u0000-\u001f\u007f]+$/)),
  mime: text(127).check(Schema.isPattern(/^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+(?:; charset=utf-8)?$/)),
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 52428800 })),
  sha256: Hash,
  createdAt: Time.check(Schema.isGreaterThan(0)),
  expiresAt: Time.check(Schema.isGreaterThan(0)),
}
const attachmentValid = (value: { attachmentID: string; contentRef: string; createdAt: number; expiresAt: number }) => value.contentRef === value.attachmentID && value.expiresAt === value.createdAt + 86400000
export const MediaAttachment = Schema.Struct(AttachmentFields).check(Schema.makeFilter(attachmentValid))
export const RemoteAttachment = Schema.Struct({ profile: Schema.Literal("kernel_media"), ...AttachmentFields }).check(Schema.makeFilter(attachmentValid))
export type RemoteAttachment = typeof RemoteAttachment.Type
const WireText = Schema.String.check(Schema.makeFilter((value) => new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value))
export const MediaEnvelope = Schema.Struct({ v: Schema.Literal(1), content: WireText, attachments: Schema.Array(MediaAttachment).check(Schema.isMinLength(1), Schema.isMaxLength(4)) })
const TextEnvelope = Schema.Struct({ content: WireText })
export function wireContent(raw: string, messageType: "jg:text" | "dac:media.v1", expiresAt: number) {
  const limit = messageType === "dac:media.v1" ? 16384 : 65536
  const value = strictWireJSON(raw, limit)
  if (messageType === "jg:text") return { content: Schema.decodeUnknownSync(TextEnvelope)(value, { onExcessProperty: "error" }).content }
  const media = Schema.decodeUnknownSync(MediaEnvelope)(value, { onExcessProperty: "error" })
  if (new Set(media.attachments.map((item) => item.attachmentID)).size !== media.attachments.length || Math.min(...media.attachments.map((item) => item.expiresAt)) !== expiresAt)
    throw failure("reader_mapping_conflict", "media-body")
  return { content: media.content, remoteAttachments: media.attachments.map((item) => ({ profile: "kernel_media" as const, ...item })) }
}

/** JSON.parse discards duplicate keys; reject them before decoding the fixed wire envelope. */
function strictWireJSON(raw: string, limit: number) {
  if (bytes(raw) > limit || new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(raw)) !== raw) throw failure("reader_capacity", "wire-body")
  const position = { offset: 0 }
  const space = () => { while (/[\t\n\r ]/.test(raw[position.offset] ?? "x")) position.offset++ }
  const string = () => {
    const token = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(raw.slice(position.offset))
    if (!token) throw failure("reader_mapping_conflict", "wire-json")
    position.offset += token[0].length
    return Schema.decodeUnknownSync(Schema.String)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(token[0]))
  }
  const value = (depth: number): void => {
    if (depth > 4) throw failure("reader_mapping_conflict", "wire-depth")
    space()
    if (raw[position.offset] === '"') { string(); return }
    if (raw[position.offset] === "{" || raw[position.offset] === "[") {
      const object = raw[position.offset++] === "{"
      const close = object ? "}" : "]"
      const seen = new Set<string>()
      space()
      if (raw[position.offset] === close) { position.offset++; return }
      for (;;) {
        space()
        if (object) {
          const key = string()
          if (seen.has(key)) throw failure("reader_mapping_conflict", "wire-duplicate")
          seen.add(key)
          space()
          if (raw[position.offset++] !== ":") throw failure("reader_mapping_conflict", "wire-json")
        }
        value(depth + 1)
        space()
        if (raw[position.offset] === close) { position.offset++; return }
        if (raw[position.offset++] !== ",") throw failure("reader_mapping_conflict", "wire-json")
      }
    }
    const scalar = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(position.offset))
    if (!scalar) throw failure("reader_mapping_conflict", "wire-json")
    position.offset += scalar[0].length
  }
  value(0)
  space()
  if (position.offset !== raw.length) throw failure("reader_mapping_conflict", "wire-json")
  return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(raw)
}
