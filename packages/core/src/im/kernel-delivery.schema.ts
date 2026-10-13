export * as KernelDeliverySchema from "./kernel-delivery.schema"

import { Schema } from "effect"
import { KernelReaderSchema } from "./kernel-reader.schema"

export const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))
export const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Time = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const Source = Schema.Struct({
  realm: Text,
  appkey: Text,
  orgID: Schema.NullOr(Time),
  senderID: Text,
  // A digest of the actual credential, not a claim about the platform's identity revision.
  credentialFingerprint: Hash,
})
export type Source = typeof Source.Type
export const TextBinding = Schema.Struct({
  version: Schema.Literal(1),
  messageID: Text,
  groupID: Text,
  workspaceID: Text,
  source: Source,
  conversationType: Schema.Literals([1, 2]),
  conversationID: Text,
  messageHash: Hash,
  wireID: Text,
  textHash: Hash,
  createdAt: Time,
  expiresAt: Time,
})
export type TextBinding = typeof TextBinding.Type
export const MEDIA_BINDING_BYTES = 32768
// Eight legacy Text fields may each require six JSON bytes per code unit.
export const BINDING_BYTES = 131072
export const MediaLocalAttachment = Schema.Struct({ localAttachmentID: Text, attachmentID: Hash, identityHash: Hash })
export const MediaBinding = Schema.Struct({
  ...TextBinding.fields,
  version: Schema.Literal(2),
  messageType: Schema.Literal("dac:media.v1"),
  wireContent: Schema.String.check(Schema.makeFilter((value) => KernelReaderSchema.bytes(value) <= 16384)),
  wireHash: Hash,
  attachments: Schema.Array(KernelReaderSchema.MediaAttachment).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  localAttachments: Schema.Array(MediaLocalAttachment).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
})
export type MediaBinding = typeof MediaBinding.Type
export const Binding = Schema.Union([TextBinding, MediaBinding])
export type Binding = typeof Binding.Type
export const LocalAttachment = Schema.Struct({
  id: Text, workspaceID: Text, projectID: Schema.NullOr(Text), groupID: Schema.NullOr(Text),
  messageID: Schema.NullOr(Text), uploadedBy: Text, storagePath: KernelReaderSchema.text(8192),
  filename: KernelReaderSchema.text(255), mime: KernelReaderSchema.text(127),
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 52428800 })), checksum: Hash,
  createdAt: Time, deletedAt: Schema.NullOr(Time),
})
export const MediaCreation = Schema.Struct({
  messageID: Text,
  groupID: Text,
  senderID: Text,
  content: Schema.String,
  attachments: Schema.Array(Schema.Struct({ local: LocalAttachment, remote: KernelReaderSchema.MediaAttachment }))
    .check(Schema.isMinLength(1), Schema.isMaxLength(4)),
})
export type MediaCreation = typeof MediaCreation.Type
export const State = Schema.Literals(["prepared", "dispatched", "acknowledged", "unknown"])
export type State = typeof State.Type
export const Status = Schema.Struct({
  state: State,
  messageID: Text,
  kernelMessageID: Schema.NullOr(Text),
  reason: Schema.NullOr(Text),
})
export type Status = typeof Status.Type
export class Error extends Schema.TaggedErrorClass<Error>()("KernelDelivery.Error", {
  code: Schema.Literals(["KERNEL_DELIVERY_UNAVAILABLE", "KERNEL_DELIVERY_CONFLICT", "KERNEL_DELIVERY_UNKNOWN", "KERNEL_DELIVERY_RETIRED"]),
  message: Schema.String,
}) {}

/** Local maintenance refusal; it grants neither delivery nor reader authority. */
export class SenderCleanupError extends Schema.TaggedErrorClass<SenderCleanupError>()("KernelDelivery.SenderCleanupError", {
  code: Schema.Literals(["sender_binding_mismatch", "sender_body_mismatch"]),
  candidates: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
}) {}
