export * as MediaBatch from "./media-batch"

import { Schema } from "effect"
import { MediaIntent } from "./media-intent"
import { AttachmentPreview } from "./attachment-preview"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const Time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Policy = Schema.Struct({
  version: Schema.Literal(2),
  enabled: Schema.Boolean,
  multipleAttachments: Schema.Literal(true),
  maxAttachments: Schema.Literal(4),
  maxAttachmentBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AttachmentPreview.maxBytes })),
  ttlMs: Schema.Literal(86_400_000),
})
export type Policy = typeof Policy.Type
export const Item = Schema.Struct({ intentID: Text, attachment: MediaIntent.Attachment })
export type Item = typeof Item.Type
export const Phase = Schema.Literals(["draft", "sending", "send_outcome_unknown", "bound", "unavailable"])
export const Record = Schema.Struct({
  version: Schema.Literal(1),
  id: Text,
  requestID: Text,
  revision: Time,
  createdAt: Time,
  scope: MediaIntent.Scope,
  content: Schema.String,
  format: Schema.Literals(["batch", "legacy"]),
  files: Schema.Array(Item).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  phase: Phase,
  messageID: Schema.optional(Text),
})
export type Record = typeof Record.Type

// These are durable client observations, never server authorization or upload grants.
export function decode(input: unknown): Record {
  const value = Schema.decodeUnknownSync(Record)(input, { onExcessProperty: "error" })
  MediaIntent.scope(value.scope)
  const attachments = value.files.map((file) => MediaIntent.attachment(file.attachment))
  if (
    new Set(value.files.map((file) => file.intentID)).size !== value.files.length ||
    new Set(attachments.map((file) => file.id)).size !== value.files.length ||
    attachments.some(
      (file) =>
        file.workspaceID !== value.scope.workspaceID ||
        file.groupID !== value.scope.groupID ||
        file.uploadedBy !== value.scope.memberID ||
        file.messageID !== null,
    ) ||
    (value.phase === "bound" && !value.messageID) ||
    (value.phase !== "bound" && value.messageID !== undefined) ||
    (value.format === "legacy" &&
      value.phase !== "draft" &&
      (value.files.length !== 1 || value.content !== attachments[0].filename))
  )
    throw new Error("media_batch_invalid")
  return value
}

export function create(scope: MediaIntent.Scope, file: Item, format: Record["format"]): Record {
  return decode({
    version: 1,
    id: crypto.randomUUID(),
    requestID: crypto.randomUUID(),
    revision: 0,
    createdAt: Date.now(),
    scope: MediaIntent.scope(scope),
    content: "",
    format,
    files: [file],
    phase: "draft",
  })
}

export function edit(
  current: Record,
  input: { files?: readonly Item[]; content?: string; format?: Record["format"] },
): Record {
  if (current.phase !== "draft") throw new Error("media_batch_frozen")
  return decode({ ...current, ...input, revision: current.revision + 1 })
}

export function change(current: Record, phase: Record["phase"], messageID?: string): Record {
  const allowed: { [Key in Record["phase"]]: readonly Record["phase"][] } = {
    draft: ["sending", "unavailable"],
    sending: ["send_outcome_unknown", "bound"],
    send_outcome_unknown: ["sending", "bound", "unavailable"],
    bound: [],
    unavailable: [],
  }
  if (!allowed[current.phase].includes(phase)) throw new Error("media_batch_transition_conflict")
  if (phase === "sending" && current.files.some((file) => file.attachment.expiresAt <= Date.now()))
    throw new Error("media_batch_expired")
  return decode({
    ...current,
    phase,
    revision: current.revision + 1,
    ...(messageID === undefined ? {} : { messageID }),
  })
}

// A cold 'sending' observation never schedules a retry.
export const observedPhase = (value: Record) => (value.phase === "sending" ? "send_outcome_unknown" : value.phase)

export function records(input: unknown): Record[] {
  if (
    !Array.isArray(input) ||
    input.length > MediaIntent.maxRecords ||
    new TextEncoder().encode(JSON.stringify(input)).length > MediaIntent.maxStoreBytes
  )
    throw new Error("media_store_limit")
  const values = input.map(decode)
  const active = values.filter((value) => value.phase !== "unavailable")
  if (
    new Set(values.map((value) => value.id)).size !== values.length ||
    new Set(values.map((value) => value.requestID)).size !== values.length ||
    new Set(active.flatMap((value) => value.files.map((file) => file.intentID))).size !==
      active.reduce((sum, value) => sum + value.files.length, 0) ||
    new Set(active.flatMap((value) => value.files.map((file) => file.attachment.id))).size !==
      active.reduce((sum, value) => sum + value.files.length, 0)
  )
    throw new Error("media_store_conflict")
  return values
}

export function upsert(values: Record[], value: Record, expectedRevision?: number) {
  decode(value)
  const previous = values.find((item) => item.id === value.id)
  if (
    previous
      ? previous.revision !== expectedRevision ||
        value.revision !== previous.revision + 1 ||
        value.requestID !== previous.requestID ||
        value.createdAt !== previous.createdAt ||
        !MediaIntent.sameScope(value.scope, previous.scope) ||
        (previous.phase !== "draft" &&
          (value.content !== previous.content ||
            value.format !== previous.format ||
            JSON.stringify(value.files) !== JSON.stringify(previous.files)))
      : expectedRevision !== undefined || value.revision !== 0
  )
    throw new Error("media_store_conflict")
  if (
    previous &&
    (previous.phase === "draft" && value.phase === "draft"
      ? false
      : !(
          {
            draft: ["sending", "unavailable"],
            sending: ["send_outcome_unknown", "bound"],
            send_outcome_unknown: ["sending", "bound", "unavailable"],
            bound: [],
            unavailable: [],
          }[previous.phase] as readonly string[]
        ).includes(value.phase))
  )
    throw new Error("media_batch_transition_conflict")
  const next = [...values.filter((item) => item.id !== value.id), value]
  while (next.length > MediaIntent.maxRecords) {
    const retired = next.findIndex((item) => item.id !== value.id && ["bound", "unavailable"].includes(item.phase))
    if (retired < 0) throw new Error("media_store_limit")
    next.splice(retired, 1)
  }
  return records(next)
}

export function item(record: MediaIntent.Record): Item {
  const value = MediaIntent.decode(record)
  if (value.phase !== "uploaded_unbound" || !value.attachment) throw new Error("media_receipt_missing")
  return { intentID: value.id, attachment: value.attachment }
}

export function matches(
  record: Record,
  value: { id: string; groupID: string; senderID: string; type: string; content: string; metadata: unknown },
) {
  if (
    !value.id ||
    value.groupID !== record.scope.groupID ||
    value.senderID !== record.scope.memberID ||
    value.type !== "file" ||
    value.content !== record.content
  )
    return false
  const metadata = record.format === "batch" ? value.metadata : [value.metadata]
  return (
    Array.isArray(metadata) &&
    metadata.length === record.files.length &&
    metadata.every(
      (item: unknown, index) =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "attachment_ref" &&
        "attachmentID" in item &&
        item.attachmentID === record.files[index].attachment.id &&
        (record.format === "batch" ? "batch" in item && item.batch === true : !("batch" in item)),
    )
  )
}

// References only drive a current authenticated descriptor lookup, never grant access.
export function references(input: unknown): string[] {
  const values = Array.isArray(input) ? input : [input]
  if (
    !values.length ||
    values.length > 4 ||
    !values.every(
      (value: unknown) =>
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "attachment_ref" &&
        "attachmentID" in value &&
        typeof value.attachmentID === "string" &&
        value.attachmentID.length > 0 &&
        value.attachmentID.length <= 4096 &&
        (Array.isArray(input) ? "batch" in value && value.batch === true : !("batch" in value)),
    )
  )
    return []
  const decoded = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal("attachment_ref"),
        attachmentID: Text,
        batch: Schema.optional(Schema.Literal(true)),
      }),
    ),
  )(values)
  const ids = decoded.map((value) => value.attachmentID)
  return new Set(ids).size === ids.length ? ids : []
}
