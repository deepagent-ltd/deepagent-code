export * as MediaIntent from "./media-intent"

import { Schema } from "effect"
import { AttachmentPreview } from "./attachment-preview"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const Time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Bytes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: AttachmentPreview.legacyMaxBytes }))

// The server currently emits null for these IDs despite its generated SDK's string type.
// Decode actual wire data instead of widening/casting the generated response.
export const Attachment = Schema.Struct({
  id: Text,
  workspaceID: Text,
  projectID: Schema.NullOr(Text),
  groupID: Schema.NullOr(Text),
  messageID: Schema.NullOr(Text),
  uploadedBy: Text,
  filename: Text,
  mime: Text,
  sizeBytes: Bytes,
  checksum: Hash,
  createdAt: Time,
  expiresAt: Time,
  preview: Schema.Boolean,
})
export type Attachment = typeof Attachment.Type
export const Scope = Schema.Struct({
  server: Text,
  directory: Schema.String,
  workspaceID: Text,
  groupID: Text,
  memberID: Text,
})
export type Scope = typeof Scope.Type
export const File = Schema.Struct({ name: Text, mime: Text, sizeBytes: Bytes, checksum: Hash })
export type File = typeof File.Type
export const Phase = Schema.Literals([
  "prepared",
  "uploading",
  "upload_outcome_unknown",
  "uploaded_unbound",
  "sending",
  "send_outcome_unknown",
  "bound",
  "unavailable",
])
export const Record = Schema.Struct({
  version: Schema.Literal(1),
  id: Text,
  requestID: Text,
  revision: Time,
  createdAt: Time,
  scope: Scope,
  file: File,
  phase: Phase,
  attachment: Schema.optional(Attachment),
  messageID: Schema.optional(Text),
})
export type Record = typeof Record.Type
export const maxRecords = 32
export const maxStoreBytes = 1024 * 1024

export function attachment(input: unknown): Attachment {
  const value = Schema.decodeUnknownSync(Attachment)(input)
  if (value.expiresAt !== value.createdAt + 86_400_000 || /[\r\n\x00]/.test(value.mime))
    throw new Error("media_descriptor_invalid")
  return value
}

export function scope(input: Scope): Scope {
  const result = Schema.decodeUnknownSync(Scope)(input)
  const url = new URL(result.server)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("media_scope_invalid")
  return { ...result, server: url.href.replace(/\/+$/, "") }
}

export const sameScope = (a: Scope, b: Scope) =>
  a.server === b.server &&
  a.directory === b.directory &&
  a.workspaceID === b.workspaceID &&
  a.groupID === b.groupID &&
  a.memberID === b.memberID

export function create(target: Scope, file: File): Record {
  return {
    version: 1,
    id: crypto.randomUUID(),
    requestID: crypto.randomUUID(),
    revision: 0,
    createdAt: Date.now(),
    scope: scope(target),
    file: Schema.decodeUnknownSync(File)(file),
    phase: "prepared",
  }
}

export function decode(input: unknown): Record {
  const value = Schema.decodeUnknownSync(Record)(input, { onExcessProperty: "error" })
  scope(value.scope)
  if (value.attachment) {
    const receipt = attachment(value.attachment)
    if (
      receipt.groupID !== value.scope.groupID ||
      receipt.workspaceID !== value.scope.workspaceID ||
      receipt.uploadedBy !== value.scope.memberID ||
      receipt.sizeBytes !== value.file.sizeBytes ||
      receipt.checksum !== value.file.checksum
    )
      throw new Error("media_receipt_mismatch")
  }
  if (["uploaded_unbound", "sending", "send_outcome_unknown", "bound"].includes(value.phase) && !value.attachment)
    throw new Error("media_receipt_missing")
  if (value.phase === "bound" && (!value.messageID || value.attachment?.messageID !== value.messageID))
    throw new Error("media_message_missing")
  return value
}

export function records(input: unknown): Record[] {
  if (
    !Array.isArray(input) ||
    input.length > maxRecords ||
    new TextEncoder().encode(JSON.stringify(input)).length > maxStoreBytes
  )
    throw new Error("media_store_limit")
  const values = input.map(decode)
  if (
    new Set(values.map((v) => v.id)).size !== values.length ||
    new Set(values.map((v) => v.requestID)).size !== values.length
  )
    throw new Error("media_store_conflict")
  return values
}

export function change(current: Record, phase: typeof Phase.Type, receipt?: unknown): Record {
  const allowed: RecordTransitions = {
    prepared: ["uploading", "unavailable"],
    uploading: ["uploaded_unbound", "upload_outcome_unknown"],
    upload_outcome_unknown: ["unavailable"],
    uploaded_unbound: ["sending", "bound", "unavailable"],
    sending: ["bound", "send_outcome_unknown"],
    send_outcome_unknown: ["sending", "bound", "unavailable"],
    bound: [],
    unavailable: [],
  }
  if (!allowed[current.phase].includes(phase)) throw new Error("media_transition_conflict")
  const next = receipt === undefined ? current.attachment : attachment(receipt)
  if (
    current.attachment &&
    next &&
    (current.attachment.id !== next.id ||
      current.attachment.expiresAt !== next.expiresAt ||
      current.attachment.checksum !== next.checksum)
  )
    throw new Error("media_receipt_changed")
  return decode({
    ...current,
    revision: current.revision + 1,
    phase,
    ...(next ? { attachment: next } : {}),
    ...(phase === "bound" && next?.messageID ? { messageID: next.messageID } : {}),
  })
}

type RecordTransitions = { [Key in typeof Phase.Type]: ReadonlyArray<typeof Phase.Type> }

// Crashed transport never becomes an instruction to resend. This is a read-only projection.
export const observedPhase = (value: Record) =>
  value.phase === "uploading"
    ? "upload_outcome_unknown"
    : value.phase === "sending"
      ? "send_outcome_unknown"
      : value.phase

export function upsert(values: Record[], value: Record, expectedRevision?: number) {
  const previous = values.find((item) => item.id === value.id)
  if (
    previous
      ? previous.revision !== expectedRevision ||
        value.revision !== previous.revision + 1 ||
        value.requestID !== previous.requestID ||
        !sameScope(value.scope, previous.scope)
      : expectedRevision !== undefined || value.revision !== 0
  )
    throw new Error("media_store_conflict")
  const next = [...values.filter((item) => item.id !== value.id), value]
  while (next.length > maxRecords) {
    const retired = next.findIndex((item) => item.id !== value.id && ["bound", "unavailable"].includes(item.phase))
    if (retired < 0) throw new Error("media_store_limit")
    next.splice(retired, 1)
  }
  return records(next)
}

export async function checksum(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")
}

export async function readBytes(stream: ReadableStream<Uint8Array> | null, expected: number, signal: AbortSignal) {
  if (!stream || !Number.isSafeInteger(expected) || expected < 0 || expected > AttachmentPreview.maxBytes)
    throw new Error("media_size_invalid")
  const reader = stream.getReader()
  const bytes = new Uint8Array(expected)
  let offset = 0
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      if (offset + chunk.value.length > expected) throw new Error("media_size_invalid")
      bytes.set(chunk.value, offset)
      offset += chunk.value.length
    }
    if (offset !== expected) throw new Error("media_size_invalid")
    return bytes
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export async function verifiedBytes(response: Response, value: Attachment, signal: AbortSignal) {
  if (!response.ok || response.redirected || value.expiresAt <= Date.now()) throw new Error("media_unavailable")
  const length = response.headers.get("content-length")
  if (length !== null && Number(length) !== value.sizeBytes) throw new Error("media_size_invalid")
  const bytes = await readBytes(response.body, value.sizeBytes, signal)
  if (
    (await checksum(bytes)) !== value.checksum ||
    value.expiresAt <= Date.now() ||
    (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value.mime) &&
      AttachmentPreview.mime(bytes) !== value.mime)
  )
    throw new Error("media_integrity_failed")
  signal.throwIfAborted()
  return bytes
}
