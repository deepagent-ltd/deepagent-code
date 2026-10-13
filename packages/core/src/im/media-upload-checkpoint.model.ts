export * as MediaUploadCheckpointModel from "./media-upload-checkpoint.model"

import { createHash } from "node:crypto"
import { Schema } from "effect"
import { CanonicalJson } from "../util/canonical-json"
import { AttachmentStorage } from "./attachment-storage"
import { AttachmentPreview } from "./attachment-preview"
import { KernelDeliverySchema } from "./kernel-delivery.schema"
import { KernelReaderSchema } from "./kernel-reader.schema"

export const RECORD_LIMIT = 100_000
export const BYTE_LIMIT = 268_435_456
export const RECORD_BYTES = 65_536
export const ROW_OVERHEAD = 1024
export const METER_BYTES = 92
export const PAGE_LIMIT = 32
export const hash = (value: unknown) => createHash("sha256").update(CanonicalJson.stringify(value)).digest("hex")
export const utf8 = (value: string) => Buffer.byteLength(value, "utf8")
const UUID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
const Positive = KernelDeliverySchema.Time.check(Schema.isGreaterThan(0))
export const Source = KernelDeliverySchema.Source.check(Schema.makeFilter((value) => value.orgID !== null && value.orgID > 0))
export type Source = typeof Source.Type

/** Historical reservation data grants neither current reader nor file authority. */
export const Origin = Schema.Struct({
  custodyID: UUID, readerInstanceID: UUID, readerKey: KernelDeliverySchema.Hash, scopeKey: KernelDeliverySchema.Hash,
  workspaceID: KernelDeliverySchema.Text, userID: KernelDeliverySchema.Text, groupID: KernelDeliverySchema.Text,
  source: Source, attachment: KernelDeliverySchema.LocalAttachment, localExpiresAt: Positive,
}).check(Schema.makeFilter((value) => value.attachment.workspaceID === value.workspaceID && value.attachment.groupID === value.groupID &&
  value.attachment.uploadedBy === value.userID && value.attachment.messageID === null && value.attachment.deletedAt === null &&
  value.localExpiresAt === AttachmentStorage.expiresAt(value.attachment.createdAt)))
export type Origin = typeof Origin.Type
export const BatchItem = Schema.Struct({ attachmentID: KernelDeliverySchema.Text, identityHash: KernelDeliverySchema.Hash })
export const Plan = Schema.Struct({
  messageID: KernelDeliverySchema.Text, clientRequestHash: KernelDeliverySchema.Hash, requestHash: KernelDeliverySchema.Hash,
  source: Source, uploadID: Schema.String.check(Schema.isPattern(/^dac_[0-9a-f]{64}$/)),
  batch: Schema.Array(BatchItem).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
}).check(Schema.makeFilter((value) => value.index < value.batch.length && new Set(value.batch.map((item) => item.attachmentID)).size === value.batch.length))
export type Plan = typeof Plan.Type
export const RemoteIdentity = Schema.Struct({
  objectID: KernelDeliverySchema.Hash, uploadID: Schema.String.check(Schema.isPattern(/^dac_[0-9a-f]{64}$/)),
  filename: KernelReaderSchema.text(255), sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: AttachmentPreview.legacyMaxBytes })),
  sha256: KernelDeliverySchema.Hash, createdAt: Positive, expiresAt: Positive,
}).check(Schema.makeFilter((value) => value.createdAt <= Number.MAX_SAFE_INTEGER - 86_400_000 && value.expiresAt === value.createdAt + 86_400_000))
export type RemoteIdentity = typeof RemoteIdentity.Type
export const RemoteFacts = Schema.Struct({
  state: Schema.Literals(["uploading", "uploaded_unbound", "bound", "unknown", "cancelled", "expired"]),
  receivedBytes: KernelDeliverySchema.Time, receivedChunks: KernelDeliverySchema.Time, progressHash: Schema.NullOr(KernelDeliverySchema.Hash),
})
export const Phase = Schema.Literals(["eligible", "planned", "uploading", "uploaded", "unknown_upload", "attached", "expired", "cancelled"])
const Shape = Schema.Struct({
  version: Schema.Literal(1), checkpointID: KernelDeliverySchema.Hash, origin: Origin, originHash: KernelDeliverySchema.Hash,
  plan: Schema.NullOr(Plan), planHash: Schema.NullOr(KernelDeliverySchema.Hash), remote: Schema.NullOr(RemoteIdentity),
  remoteHash: Schema.NullOr(KernelDeliverySchema.Hash), remoteFacts: Schema.NullOr(RemoteFacts), phase: Phase,
  bodyVerified: Schema.Boolean, beginDispatched: Schema.Boolean, attemptOwner: Schema.NullOr(UUID),
  attemptRevision: KernelDeliverySchema.Time, attemptExpiresAt: Schema.NullOr(KernelDeliverySchema.Time),
  currentSourceHash: Schema.NullOr(KernelDeliverySchema.Hash), messageRef: Schema.NullOr(KernelDeliverySchema.Text),
  receiptRef: Schema.NullOr(KernelDeliverySchema.Text),
  outcome: Schema.Literals(["none", "local_unavailable", "confirmed", "unknown_upload", "denied", "expired", "cancelled"]),
})
export type Record = typeof Shape.Type
export const Record = Shape.check(Schema.makeFilter(coherent))
export class Error extends Schema.TaggedErrorClass<Error>()("MediaUploadCheckpoint.Error", {
  code: Schema.Literals(["IM_MEDIA_UPLOAD_INVALID", "IM_MEDIA_UPLOAD_CAPACITY", "IM_MEDIA_UPLOAD_LEGACY", "IM_MEDIA_UPLOAD_CONFLICT", "IM_MEDIA_UPLOAD_IN_FLIGHT", "IM_MEDIA_UPLOAD_EXPIRED", "IM_MEDIA_UPLOAD_UNKNOWN"]),
  message: Schema.String,
}) {}
export const invalid = () => new Error({ code: "IM_MEDIA_UPLOAD_INVALID", message: "Original upload custody is unavailable" })
export const capacity = () => new Error({ code: "IM_MEDIA_UPLOAD_CAPACITY", message: "Upload continuation capacity is exhausted" })
export const legacy = () => new Error({ code: "IM_MEDIA_UPLOAD_LEGACY", message: "The original file has no durable upload origin; upload the file again" })
export const conflict = () => new Error({ code: "IM_MEDIA_UPLOAD_CONFLICT", message: "The original upload identity does not match this request" })
export const inFlight = () => new Error({ code: "IM_MEDIA_UPLOAD_IN_FLIGHT", message: "The original upload attempt is still in progress" })
export const expired = () => new Error({ code: "IM_MEDIA_UPLOAD_EXPIRED", message: "The original upload has expired" })
export const unknown = () => new Error({ code: "IM_MEDIA_UPLOAD_UNKNOWN", message: "The original upload outcome is not settled" })
export const originHash = (value: Origin) => hash(["deepagent.im.media-upload.origin.v1", value])
export const planHash = (value: Plan | null) => value === null ? null : hash(["deepagent.im.media-upload.plan.v1", value])
export const remoteHash = (value: RemoteIdentity | null) => value === null ? null : hash(["deepagent.im.media-upload.remote.v1", value])
export const checkpointID = (value: Origin) => hash(["deepagent.im.media-upload.checkpoint.v1", value.custodyID, value.workspaceID, value.userID, value.attachment.id])
export const attachmentHash = (value: typeof KernelDeliverySchema.LocalAttachment.Type) => hash([
  value.id, value.workspaceID, value.projectID, value.groupID, value.uploadedBy, value.storagePath,
  value.filename, value.mime, value.sizeBytes, value.checksum, value.createdAt,
])
/** This comparison is data validation; Platform and Go reauthorization remain mandatory. */
export const sameIdentity = (left: KernelDeliverySchema.Source, right: KernelDeliverySchema.Source) =>
  left.realm === right.realm && left.appkey === right.appkey && left.orgID === right.orgID && left.senderID === right.senderID
export const uploadID = (source: KernelDeliverySchema.Source, messageID: string, local: typeof KernelDeliverySchema.LocalAttachment.Type) =>
  `dac_${createHash("sha256").update(JSON.stringify(["im-media-upload-v1", {
    realm: source.realm, appkey: source.appkey, orgID: source.orgID, senderID: source.senderID,
    credentialFingerprint: source.credentialFingerprint,
  }, messageID, local.id, local.checksum])).digest("hex")}`
export const encode = (value: Record) => {
  const record = CanonicalJson.stringify(Schema.decodeUnknownSync(Record)(value, { onExcessProperty: "error" }))
  if (utf8(record) > RECORD_BYTES) throw capacity()
  return record
}
export const decode = (value: string) => {
  if (utf8(value) > RECORD_BYTES) throw invalid()
  return Schema.decodeUnknownSync(Record)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value), { onExcessProperty: "error" })
}
function coherent(value: Record): boolean {
  if (value.checkpointID !== checkpointID(value.origin) || value.originHash !== originHash(value.origin) || value.planHash !== planHash(value.plan) || value.remoteHash !== remoteHash(value.remote)) return false
  if ((value.attemptOwner === null) !== (value.attemptExpiresAt === null) || value.attemptOwner !== null && (value.attemptRevision === 0 || value.currentSourceHash === null)) return false
  if (value.phase === "eligible") return value.plan === null && value.remote === null && value.remoteFacts === null && !value.bodyVerified && !value.beginDispatched &&
    value.attemptOwner === null && value.attemptRevision === 0 && value.currentSourceHash === null && value.messageRef === null && value.receiptRef === null && value.outcome === "none"
  if (!value.plan || !sameIdentity(value.origin.source, value.plan.source) || value.plan.uploadID !== uploadID(value.plan.source, value.plan.messageID, value.origin.attachment) ||
    value.plan.batch[value.plan.index]?.attachmentID !== value.origin.attachment.id || value.plan.batch[value.plan.index]?.identityHash !== attachmentHash(value.origin.attachment)) return false
  if ((value.remote === null) !== (value.remoteFacts === null) || !value.bodyVerified && value.beginDispatched) return false
  if (value.remote && value.remoteFacts && (value.remote.uploadID !== value.plan.uploadID || value.remote.filename !== value.origin.attachment.filename ||
    value.remote.sizeBytes !== value.origin.attachment.sizeBytes || value.remote.sha256 !== value.origin.attachment.checksum || !value.beginDispatched || !value.bodyVerified ||
    value.remoteFacts.receivedBytes > value.remote.sizeBytes || value.remoteFacts.receivedChunks > Math.ceil(value.remote.sizeBytes / 262144))) return false
  if (value.phase === "uploading" && (!value.remote || value.remoteFacts?.state !== "uploading")) return false
  if (value.phase === "uploaded" && (!value.remote || value.remoteFacts?.state !== "uploaded_unbound" || value.remoteFacts.receivedBytes !== value.remote.sizeBytes ||
    value.remoteFacts.receivedChunks !== Math.ceil(value.remote.sizeBytes / 262144))) return false
  if (value.phase === "unknown_upload" && !value.beginDispatched) return false
  if (value.phase === "attached") return value.remote !== null && value.messageRef === value.plan.messageID && (value.receiptRef === null || value.receiptRef === value.messageRef)
  return value.messageRef === null && value.receiptRef === null && value.remoteFacts?.state !== "bound"
}
