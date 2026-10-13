export * as IMMediaReceiverTuple from "./im-media-receiver-tuple"

import { Option, Schema } from "effect"
import { IMMediaProductDescriptor } from "./im-media-product-descriptor"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192),
  Schema.makeFilter((value: string) => value.isWellFormed() && !value.includes("\0")))
const ID = Text.check(Schema.isMaxLength(512))
const Integer = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
export const Attachment = Schema.Struct({
  profile: Schema.Literal("kernel_media"),
  attachmentID: ID,
  contentRef: Text,
  filename: Text,
  mime: Text,
  sizeBytes: Integer.check(Schema.isLessThanOrEqualTo(50 * 1024 * 1024)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  createdAt: Integer,
  expiresAt: Integer,
})
const Owner = { origin: Text, directory: Text, groupID: ID, messageID: ID }
export const Tuple = Schema.Struct({
  version: Schema.Literal(1), window: Text, createdAt: Integer, deadlineAt: Integer,
  sender: Schema.Struct({ ...Owner, clientRequestID: ID,
    attachmentIDs: Schema.Array(ID).check(Schema.isMinLength(4), Schema.isMaxLength(4),
      Schema.makeFilter((values) => new Set(values).size === values.length)) }),
  receiver: Schema.Struct({ ...Owner, attachments: Schema.Array(Attachment).check(Schema.isMinLength(4), Schema.isMaxLength(4),
    Schema.makeFilter((values) => new Set(values.map((value) => value.attachmentID)).size === values.length)) }),
})
export type Tuple = typeof Tuple.Type
export const Page = Schema.Struct({
  reader: Schema.optional(Schema.NullOr(Schema.Struct({
    displayEpoch: Text, validatedServerNow: Integer, nextExpiryAt: Schema.NullOr(Integer),
  }))),
  protectedUnavailable: Schema.optional(Schema.Boolean),
  messages: Schema.Array(Schema.Struct({
    id: ID, groupID: ID, type: Text,
    remoteAttachments: Schema.optional(Schema.Array(Attachment)),
  })).check(Schema.isMaxLength(64)),
})

/** Actual IDs are identity observations only. The original current HTTP/reader
 * still decides whether metadata, preview or download is available. */
export function decode(value: unknown, descriptor: IMMediaProductDescriptor.Descriptor) {
  const tuple = Schema.decodeUnknownSync(Tuple, { onExcessProperty: "error" })(value)
  if (tuple.window !== descriptor.window || tuple.createdAt > tuple.deadlineAt ||
      tuple.sender.origin !== new URL(descriptor.peers.A.url).origin ||
      tuple.receiver.origin !== new URL(descriptor.peers.B.url).origin ||
      tuple.sender.directory !== descriptor.peers.A.directory || tuple.receiver.directory !== descriptor.peers.B.directory ||
      tuple.sender.groupID !== descriptor.groups.A.id || tuple.receiver.groupID !== descriptor.groups.B.id)
    throw new Error("Receiver tuple does not belong to the original current peer scope")
  if (!tuple.receiver.attachments.every((attachment, index) => {
    const file = descriptor.files[index]!
    // The remote service detects MIME from the actual content. Preserve its
    // original DTO; the local file-picker hint is not the receiver's MIME.
    return attachment.filename === file.filename && attachment.sizeBytes === file.bytes &&
      attachment.sha256 === file.sha256 && attachment.createdAt < attachment.expiresAt
  })) throw new Error("Original four-attachment identity/order changed")
  return tuple
}

export class ObservationError extends Error {
  constructor(readonly code: "invalid_page" | "reader_unavailable" | "message_identity" | "attachment_tuple") {
    super("Original receiver observation: " + code)
  }
}

export function observe(value: unknown, tuple: Tuple, displayEpoch: string) {
  const decoded = Schema.decodeUnknownOption(Page)(value)
  if (Option.isNone(decoded)) throw new ObservationError("invalid_page")
  const page = decoded.value
  if (page.protectedUnavailable || !page.reader || page.reader.displayEpoch !== displayEpoch ||
      (page.reader.nextExpiryAt !== null && page.reader.nextExpiryAt <= page.reader.validatedServerNow))
    throw new ObservationError("reader_unavailable")
  const message = page.messages.find((message) => message.id === tuple.receiver.messageID)
  if (!message) return undefined
  // Kernel mirrors retain the original text storage type; displayMessage
  // projects the independently authenticated remote attachment descriptors.
  if (message.groupID !== tuple.receiver.groupID || message.type !== "text")
    throw new ObservationError("message_identity")
  if (message.remoteAttachments?.length !== 4 ||
      !message.remoteAttachments.every((attachment, index) => {
        const expected = tuple.receiver.attachments[index]!
        return attachment.attachmentID === expected.attachmentID && attachment.contentRef === expected.contentRef &&
          attachment.filename === expected.filename && attachment.mime === expected.mime &&
          attachment.sizeBytes === expected.sizeBytes && attachment.sha256 === expected.sha256 &&
          attachment.createdAt === expected.createdAt && attachment.expiresAt === expected.expiresAt
      })) throw new ObservationError("attachment_tuple")
  return message
}
