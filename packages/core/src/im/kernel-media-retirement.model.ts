export * as KernelMediaRetirementModel from "./kernel-media-retirement.model"

import { createHash } from "node:crypto"
import { Schema } from "effect"
import { CanonicalJson } from "../util/canonical-json"
import { KernelDeliverySchema } from "./kernel-delivery.schema"
import { KernelReaderSchema } from "./kernel-reader.schema"

export const RECORD_LIMIT = 100_000
export const BYTE_LIMIT = 268_435_456
export const SUMMARY_BYTES = 65_536
export const PAGE_LIMIT = 32
export const OWNED_RECORDS = 3
const UUID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: BYTE_LIMIT }))
export const hash = (value: unknown) => createHash("sha256").update(CanonicalJson.stringify(value)).digest("hex")

/** The original raw receipt remains the owner of these facts. A body summary
 * stores their digest, not another copy of a potentially sensitive reason. */
export const Transport = Schema.Struct({
  state: KernelDeliverySchema.State,
  dispatchOwner: Schema.NullOr(KernelDeliverySchema.Text),
  kernelMessageID: Schema.NullOr(KernelDeliverySchema.Text),
  reason: Schema.NullOr(Schema.String),
  createdAt: KernelDeliverySchema.Time,
  dispatchedAt: Schema.NullOr(KernelDeliverySchema.Time),
  acknowledgedAt: Schema.NullOr(KernelDeliverySchema.Time),
  updatedAt: KernelDeliverySchema.Time,
}).check(Schema.makeFilter((value) => value.updatedAt >= value.createdAt &&
  (value.dispatchedAt === null || value.dispatchedAt >= value.createdAt && value.dispatchedAt <= value.updatedAt) &&
  (value.state === "prepared" ? value.dispatchOwner === null && value.dispatchedAt === null : value.dispatchOwner !== null && value.dispatchedAt !== null) &&
  (value.state === "acknowledged" ? value.kernelMessageID !== null && value.acknowledgedAt !== null && value.dispatchedAt !== null &&
    value.acknowledgedAt >= value.dispatchedAt && value.acknowledgedAt <= value.updatedAt : value.kernelMessageID === null && value.acknowledgedAt === null)))
export type Transport = typeof Transport.Type

/** Order is the original media order. These are identity digests and object
 * dates; filename, MIME, contentRef, local path and caption are never retained. */
export const ManifestItem = Schema.Struct({
  attachmentID: KernelDeliverySchema.Hash,
  descriptorHash: KernelDeliverySchema.Hash,
  localAttachmentID: KernelDeliverySchema.Text,
  localIdentityHash: KernelDeliverySchema.Hash,
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 52_428_800 })),
  createdAt: KernelDeliverySchema.Time.check(Schema.isGreaterThan(0)),
  expiresAt: KernelDeliverySchema.Time.check(Schema.isGreaterThan(0)),
}).check(Schema.makeFilter((value) => value.expiresAt === value.createdAt + 86_400_000))

export const Identity = Schema.Struct({
  originalBindingVersion: Schema.Literal(2),
  custodyID: UUID,
  messageID: KernelDeliverySchema.Text,
  groupID: KernelDeliverySchema.Text,
  workspaceID: KernelDeliverySchema.Text,
  source: KernelDeliverySchema.Source,
  sourceHash: KernelDeliverySchema.Hash,
  conversationType: Schema.Literals([1, 2]),
  conversationID: KernelDeliverySchema.Text,
  wireID: KernelDeliverySchema.Text,
  bindingHash: KernelDeliverySchema.Hash,
  messageHash: KernelDeliverySchema.Hash,
  messageHeaderHash: KernelDeliverySchema.Hash,
  textHash: KernelDeliverySchema.Hash,
  wireHash: KernelDeliverySchema.Hash,
  requestHash: KernelDeliverySchema.Hash,
  clientRequestIDHash: Schema.NullOr(KernelDeliverySchema.Hash),
  originalBindingBytes: Count.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(KernelDeliverySchema.BINDING_BYTES)),
  originalCaptionBytes: Count.check(Schema.isLessThanOrEqualTo(65_536)),
  originalWireBytes: Count.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(16_384)),
  createdAt: KernelDeliverySchema.Time,
  expiresAt: KernelDeliverySchema.Time,
  remoteManifestHash: KernelDeliverySchema.Hash,
  localManifestHash: KernelDeliverySchema.Hash,
  manifestOrderHash: KernelDeliverySchema.Hash,
  manifest: Schema.Array(ManifestItem).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
}).check(Schema.makeFilter((value) => value.sourceHash === hash(value.source) &&
  value.wireID === `dac_${hash(["im-kernel-wire-media-v2", value.source, value.messageID])}` &&
  value.expiresAt > value.createdAt && value.expiresAt === Math.min(...value.manifest.map((item) => item.expiresAt)) &&
  new Set(value.manifest.map((item) => item.attachmentID)).size === value.manifest.length &&
  new Set(value.manifest.map((item) => item.localAttachmentID)).size === value.manifest.length &&
  value.localManifestHash === hash(value.manifest.map((item) => ({
    localAttachmentID: item.localAttachmentID, attachmentID: item.attachmentID, identityHash: item.localIdentityHash,
  }))) && value.manifestOrderHash === hash(value.manifest)))
export type Identity = typeof Identity.Type

export const Record = Schema.Struct({
  version: Schema.Literal(1),
  identity: Identity,
  identityHash: KernelDeliverySchema.Hash,
  transportHash: KernelDeliverySchema.Hash,
  bodyState: Schema.Literals(["live", "retired"]),
  retiredAt: Schema.NullOr(KernelDeliverySchema.Time),
}).check(Schema.makeFilter((value) => value.identityHash === identityHash(value.identity) &&
  (value.bodyState === "live" ? value.retiredAt === null : value.retiredAt !== null && value.retiredAt >= value.identity.expiresAt)))
export type Record = typeof Record.Type

export class Error extends Schema.TaggedErrorClass<Error>()("KernelMediaRetirement.Error", {
  code: Schema.Literals(["KERNEL_MEDIA_BODY_INVALID", "KERNEL_MEDIA_BODY_CAPACITY", "KERNEL_DELIVERY_RETIRED"]),
  message: Schema.String,
}) {}
const invalid = () => new Error({ code: "KERNEL_MEDIA_BODY_INVALID", message: "Original media body custody is unavailable" })
const capacity = () => new Error({ code: "KERNEL_MEDIA_BODY_CAPACITY", message: "Media body custody capacity is exhausted" })
export const identityHash = (identity: Identity) => hash(["deepagent.im.kernel-media-body.identity.v1", identity])
export const recordHash = (record: Record) => hash(["deepagent.im.kernel-media-body.record.v1", record])
export function transportHash(transport: Transport) {
  const value = Schema.decodeUnknownSync(Transport)(transport, { onExcessProperty: "error" })
  return hash(["deepagent.im.kernel-media-body.transport.v1", value])
}

/** Pure capture, not a grant. The caller must first verify the actual live
 * receipt, canonical Message and current database owner inside its transaction.
 * messageHash/requestHash/captionBytes come from that original Message; this
 * codec never reconstructs a Message or reads an attachment. */
export function capture(input: {
  custodyID: string
  binding: KernelDeliverySchema.MediaBinding
  bindingHash: string
  bindingBytes: number
  messageHash: string
  messageHeaderHash: string
  requestHash: string
  clientRequestIDHash: string | null
  captionBytes: number
  transport: Transport
}) {
  const binding = Schema.decodeUnknownSync(KernelDeliverySchema.MediaBinding)(input.binding, { onExcessProperty: "error" })
  KernelReaderSchema.wireContent(binding.wireContent, binding.messageType, binding.expiresAt)
  const envelope = Schema.decodeUnknownSync(KernelReaderSchema.MediaEnvelope)(
    Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(binding.wireContent), { onExcessProperty: "error" },
  )
  if (input.bindingHash !== hash(binding) || binding.messageHash !== input.messageHash ||
    KernelReaderSchema.bytes(JSON.stringify(binding)) > KernelDeliverySchema.MEDIA_BINDING_BYTES ||
    binding.textHash !== hash(envelope.content) || binding.wireHash !== createHash("sha256").update(binding.wireContent, "utf8").digest("hex") ||
    binding.wireContent !== mediaWire(envelope.content, binding.attachments) ||
    hash(envelope.attachments) !== hash(binding.attachments) || binding.localAttachments.length !== binding.attachments.length ||
    binding.localAttachments.some((item, index) => item.attachmentID !== binding.attachments[index]?.attachmentID) ||
    input.transport.createdAt !== binding.createdAt) throw invalid()
  const manifest = binding.attachments.map((item, index) => ({
    attachmentID: item.attachmentID, descriptorHash: hash(item),
    localAttachmentID: binding.localAttachments[index]!.localAttachmentID,
    localIdentityHash: binding.localAttachments[index]!.identityHash,
    sizeBytes: item.sizeBytes, createdAt: item.createdAt, expiresAt: item.expiresAt,
  }))
  const identity = Schema.decodeUnknownSync(Identity)({
    originalBindingVersion: 2, custodyID: input.custodyID, messageID: binding.messageID, groupID: binding.groupID,
    workspaceID: binding.workspaceID, source: binding.source, sourceHash: hash(binding.source),
    conversationType: binding.conversationType, conversationID: binding.conversationID, wireID: binding.wireID,
    bindingHash: input.bindingHash, messageHash: binding.messageHash, messageHeaderHash: input.messageHeaderHash, textHash: binding.textHash, wireHash: binding.wireHash,
    requestHash: input.requestHash, clientRequestIDHash: input.clientRequestIDHash,
    originalBindingBytes: input.bindingBytes, originalCaptionBytes: input.captionBytes, originalWireBytes: KernelReaderSchema.bytes(binding.wireContent),
    createdAt: binding.createdAt, expiresAt: binding.expiresAt, remoteManifestHash: hash(binding.attachments),
    localManifestHash: hash(binding.localAttachments), manifestOrderHash: hash(manifest), manifest,
  }, { onExcessProperty: "error" })
  return validate({ version: 1, identity, identityHash: identityHash(identity), transportHash: transportHash(input.transport), bodyState: "live", retiredAt: null })
}

/** These digests describe the original repository retry payload. Sorting or
 * deduplicating mentions remains the repository's admission responsibility. */
export const requestHash = (input: {
  groupID: string; senderID: string; senderType: string; type: string; content: string;
  mentions: readonly string[] | null; metadata: unknown; replyToID: string | null;
}) => hash([input.groupID, input.senderID, input.senderType, input.type, input.content, input.mentions, input.metadata, input.replyToID])
export const clientRequestIDHash = (value: string | null) => value === null ? null : hash(value)

type OriginalMessage = {
  id: string; group_id: string; sender_id: string; sender_type: string; type: string; content: string;
  mentions: readonly string[] | null; metadata: unknown; reply_to_id: string | null; created_at: number;
  client_request_id: string | null;
}
export const messageHash = (message: OriginalMessage) => hash([message.id, message.group_id, message.sender_id,
  message.sender_type, message.type, message.content, message.mentions, message.metadata, message.reply_to_id, message.created_at])
/** Retired caption is deliberately absent. All other original retry fields must
 * still belong to the original canonical Message after its body is cleared. */
export const messageHeaderHash = (message: OriginalMessage) => hash([message.id, message.group_id, message.sender_id,
  message.sender_type, message.type, message.mentions, message.metadata, message.reply_to_id, message.created_at, message.client_request_id])
export const wireText = (message: { sender_type: string; sender_id: string; content: string }) =>
  message.sender_type === "agent" ? `[Agent·${message.sender_id}] ${message.content}` : message.content
/** The original live v2 renderer is shared by both codecs; historical capture
 * does not invent a new canonical wire encoding or recompute an old receipt. */
export const mediaWire = (content: string, attachments: KernelDeliverySchema.MediaBinding["attachments"]) => JSON.stringify({ v: 1, content,
  attachments: attachments.map((item) => ({ attachmentID: item.attachmentID, contentRef: item.contentRef,
    filename: item.filename, mime: item.mime, sizeBytes: item.sizeBytes, sha256: item.sha256,
    createdAt: item.createdAt, expiresAt: item.expiresAt })) })

export function encode(record: Record) {
  const value = validate(record)
  return { record: CanonicalJson.stringify(value), recordHash: recordHash(value) }
}

/** Storage must supply the original raw receipt and persistent DB custody.
 * A valid self hash alone grants neither historical disclosure nor execution. */
export function decode(input: {
  record: string; recordHash: string; identityHash: string; custodyID: string; messageID: string; bindingHash: string; wireID: string;
  bodyState: "live" | "retired"; bindingPresent: boolean; retiredAt: number | null;
  transport: Transport;
}) {
  if (KernelReaderSchema.bytes(input.record) > SUMMARY_BYTES) throw capacity()
  const value = validate(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(input.record))
  // Our ledger has one canonical encoding. This also rejects duplicate keys
  // before they can be silently collapsed into a different historical record.
  if (input.record !== CanonicalJson.stringify(value) || input.recordHash !== recordHash(value) || input.identityHash !== value.identityHash ||
    input.custodyID !== value.identity.custodyID || input.messageID !== value.identity.messageID ||
    input.bindingHash !== value.identity.bindingHash || input.wireID !== value.identity.wireID ||
    input.bodyState !== value.bodyState || input.bindingPresent !== (value.bodyState === "live") || input.retiredAt !== value.retiredAt ||
    input.transport.createdAt !== value.identity.createdAt || transportHash(input.transport) !== value.transportHash ||
    value.bodyState === "retired" && input.transport.state !== "acknowledged") throw invalid()
  return value
}

export function requireLive(record: Record) {
  const value = validate(record)
  if (value.bodyState === "retired") throw new Error({ code: "KERNEL_DELIVERY_RETIRED", message: "The original media body has expired; it cannot be uploaded or sent again" })
}

export function eligibility(record: Record, transport: Transport, serverNow: number) {
  const value = validate(record)
  if (transportHash(transport) !== value.transportHash || transport.createdAt !== value.identity.createdAt) throw invalid()
  Schema.decodeUnknownSync(KernelDeliverySchema.Time)(serverNow)
  if (value.bodyState === "retired") {
    if (transport.state !== "acknowledged") throw invalid()
    return "retired" as const
  }
  if (serverNow < value.identity.expiresAt) return "not_expired" as const
  if (transport.state !== "acknowledged") return "deferred" as const
  return "ready" as const
}

/** Expiry changes only the body lifecycle. The caller atomically clears the
 * real caption/binding, checks current custody and releases its measured delta. */
export function retire(record: Record, transport: Transport, serverNow: number) {
  const status = eligibility(record, transport, serverNow)
  if (status === "retired") return record
  if (status !== "ready") return undefined
  return validate({ ...record, bodyState: "retired", retiredAt: serverNow })
}

/** Original transport writes refresh this digest in the same SQL transaction.
 * A retired receipt is immutable and cannot acquire a new dispatch owner. */
export function refreshTransport(record: Record, transport: Transport) {
  requireLive(record)
  if (transport.createdAt !== record.identity.createdAt) throw invalid()
  return validate({ ...record, transportHash: transportHash(transport) })
}

/** An identity comparison only. Authorized historical adapters may return a
 * no-op; this never produces a live Binding, file locator or send permission. */
export function exactHistorical(record: Record, input: {
  custodyID: string; messageID: string; groupID: string; workspaceID: string; sourceHash: string;
  requestHash: string; clientRequestIDHash: string | null;
}) {
  const value = validate(record)
  return value.bodyState === "retired" && value.identity.custodyID === input.custodyID &&
    value.identity.messageID === input.messageID && value.identity.groupID === input.groupID &&
    value.identity.workspaceID === input.workspaceID && value.identity.sourceHash === input.sourceHash &&
    value.identity.requestHash === input.requestHash && value.identity.clientRequestIDHash === input.clientRequestIDHash
}

/** Logical SQL accounting: strings are actual persisted UTF-8, each non-null
 * integer is eight bytes, NULL is zero. Supply raw JSON text, never parsed JSON.
 * SQLite pages, attachments, WAL and backups are separate resource domains. */
export function accounting(rows: readonly Readonly<{ [key: string]: string | number | null }>[]) {
  const bytes = rows.reduce((sum, row) => sum + Object.values(row).reduce<number>((total, value) => {
    if (value === null) return total
    if (typeof value === "string") return total + KernelReaderSchema.bytes(value)
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid()
    return total + 8
  }, 0), 0)
  if (!Number.isSafeInteger(bytes) || bytes > BYTE_LIMIT) throw capacity()
  return bytes
}

export function meter(input: { usedRecords: number; usedBytes: number; deltaRecords: number; deltaBytes: number }) {
  if (!Object.values(input).every(Number.isSafeInteger) || input.usedRecords < 0 || input.usedRecords > RECORD_LIMIT ||
    input.usedBytes < 0 || input.usedBytes > BYTE_LIMIT) throw invalid()
  const usedRecords = input.usedRecords + input.deltaRecords
  const usedBytes = input.usedBytes + input.deltaBytes
  if (!Number.isSafeInteger(usedRecords) || !Number.isSafeInteger(usedBytes) || usedRecords < 0 || usedRecords > RECORD_LIMIT ||
    usedBytes < 0 || usedBytes > BYTE_LIMIT) throw capacity()
  return { usedRecords, usedBytes }
}

function validate(input: unknown) {
  const value = Schema.decodeUnknownSync(Record)(input, { onExcessProperty: "error" })
  if (KernelReaderSchema.bytes(CanonicalJson.stringify(value)) > SUMMARY_BYTES) throw capacity()
  return value
}
