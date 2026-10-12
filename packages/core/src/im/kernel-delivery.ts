export * as KernelDelivery from "./kernel-delivery"

import { createHash, randomUUID } from "node:crypto"
import { and, asc, eq, getTableColumns, inArray, isNull, lte, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { KernelDeliverySchema } from "./kernel-delivery.schema"
import { IMKernelDeliveryTable } from "./kernel-delivery.sql"
import { ReplyBodyRetirement } from "./reply-body-retirement"
import { ReplyBodyRetirementModel } from "./reply-body-retirement.model"
import { IMReplyBodyTable, IMReplyBodyMeterTable } from "./reply-body-retirement.sql"
import { IMReplyOutboxTable } from "./reply-outbox.sql"
import { MediaUploadCheckpoint } from "./media-upload-checkpoint"
import { KernelMediaRetirement } from "./kernel-media-retirement"
import { KernelMediaRetirementModel } from "./kernel-media-retirement.model"
import { IMKernelMediaBodyTable, IMKernelMediaMeterTable } from "./kernel-media-retirement.sql"
import { AttachmentTable, GroupTable, MemberTable, MessageTable, AttachmentRefMetadata } from "./sql"
import { KernelReader } from "./kernel-reader"
import { KernelReaderSchema } from "./kernel-reader.schema"
import { IMKernelReaderProjectionTable, IMKernelReaderScopeTable } from "./kernel-reader.sql"
import { AttachmentStorage } from "./attachment-storage"
import { ReplyDeliveryID } from "./reply-delivery-id"
import { IMTaskStatusNotice } from "./task-status-notice"

type Db = Database.Interface["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Db | Tx
type Message = typeof MessageTable.$inferSelect
export type Runtime = { readonly source: KernelDeliverySchema.Source }
export type Dispatch = { readonly binding: KernelDeliverySchema.Binding; readonly owner: string; readonly text: string }
export interface ResultOwner {
  readonly id: string
  readonly delivery_message_id: string
  readonly session_id: string
  readonly group_id: string
  readonly agent_id: string
  readonly trigger_message_id: string | null
  readonly reply_message_id: string
  readonly reply_text: string
  readonly task: boolean
  readonly noticeID?: string
}
/** Internal purpose port. A task result's receipt does not itself authorize disclosure. */
export interface TaskResultDispatch {
  readonly prepare: (binding: KernelDeliverySchema.Binding, owner: ResultOwner) => Effect.Effect<object, KernelDeliverySchema.Error>
  readonly verify: (tx: Tx, input: { binding: KernelDeliverySchema.Binding; owner: ResultOwner; original: object }) => Effect.Effect<void, KernelDeliverySchema.Error>
}
export const TaskResultDispatch = Context.Reference<TaskResultDispatch | undefined>("IMKernelDelivery.task-result-dispatch", {
  defaultValue: () => undefined,
})
/** Separate fixed-template purpose; it never authorizes an assistant result. */
export interface TaskStatusDispatch extends TaskResultDispatch {}
export const TaskStatusDispatch = Context.Reference<TaskStatusDispatch | undefined>("IMKernelDelivery.task-status-dispatch", {
  defaultValue: () => undefined,
})
const PreparedResult = Context.Reference<object | undefined>("IMKernelDelivery.private-task-result-dispatch", { defaultValue: () => undefined })
const preparedResults = new WeakMap<object, { db: Db; runtime: Runtime; bindingHash: string; guard: TaskResultDispatch; original: object }>()

/** Indexed original outbox ownership, independent of caller metadata and current source deletion. */
export const resultOwner = (db: Reader, binding: KernelDeliverySchema.Binding) => Effect.gen(function* () {
  if (!binding.messageID.startsWith("imsg_reply_")) return undefined
  yield* ReplyBodyRetirement.preflight(db,binding.messageID).pipe(Effect.mapError(() => failure("Original reply body custody is unavailable")))
  const owner = yield* db.get<Omit<ResultOwner, "task"> & { task: number }>(sql`SELECT o.id,o.delivery_message_id,o.session_id,o.group_id,o.agent_id,
    o.trigger_message_id,o.reply_message_id,o.reply_text,
    CASE WHEN substr(o.id,1,9)='imresult_' OR substr(o.session_id,1,11)='ses_imtask_' OR g.grant_id IS NOT NULL THEN 1 ELSE 0 END task
    FROM im_reply_outbox o LEFT JOIN im_task_grant g ON g.result_key=o.id
    WHERE o.delivery_message_id=${binding.messageID}`)
  const message = yield* db.select().from(MessageTable).where(sql`${MessageTable.id}=${binding.messageID}`).get()
  if (!owner || !message || owner.delivery_message_id !== ReplyDeliveryID.fromOutbox(owner.id) ||
    owner.group_id !== binding.groupID || owner.group_id !== message.group_id || owner.agent_id !== message.sender_id ||
    message.sender_type !== "agent" || message.type !== "text" || message.content !== owner.reply_text ||
    !wireMessage(binding, message)) return yield* failure("Original result delivery identity is unavailable")
  const notice = yield* IMTaskStatusNotice.readByDelivery(db, binding.messageID)
  if (owner.id.startsWith("imnotice_") || notice) {
    if (!notice || notice.outboxID !== owner.id || notice.deliveryMessageID !== owner.delivery_message_id ||
      (notice.sessionID ?? notice.requestID) !== owner.session_id || notice.groupID !== owner.group_id ||
      notice.agentID !== owner.agent_id || notice.sourceMessageID !== owner.trigger_message_id ||
      notice.noticeID !== owner.reply_message_id || notice.text !== owner.reply_text)
      return yield* failure("Original status notice delivery identity is unavailable")
    return { ...owner, task: true, noticeID: notice.noticeID }
  }
  return { ...owner, task: !!owner.task }
})

/** Refresh the original native source outside SQL, then consume only this exact private frame. */
export const withResultDispatch = <A, E, R>(db: Db, runtime: Runtime, messageID: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const receipt = yield* read(db, messageID)
    if (!receipt || receipt.state !== "prepared") return yield* effect
    const owner = yield* resultOwner(db, receipt.binding)
    if (!owner?.task) return yield* effect
    const guard = owner.noticeID ? yield* TaskStatusDispatch : yield* TaskResultDispatch
    if (!guard) return yield* failure("Task result dispatch authority is unavailable")
    const original = yield* guard.prepare(receipt.binding, owner)
    const witness = {}
    preparedResults.set(witness, { db, runtime, bindingHash: receipt.binding_hash, guard, original })
    return yield* effect.pipe(Effect.provideService(PreparedResult, witness),
      Effect.ensuring(Effect.sync(() => preparedResults.delete(witness))))
  })
const runtimes = new WeakMap<Runtime, { active: boolean; capacity: number }>()
const Current = Context.Reference<object | undefined>("IMKernelDelivery.private-creation", {
  defaultValue: () => undefined,
})
const witnesses = new WeakMap<object, { runtime: Runtime; groupID: string; media?: KernelDeliverySchema.MediaCreation }>()
const Verified = Context.Reference<object | undefined>("IMKernelDelivery.private-verification", {
  defaultValue: () => undefined,
})
const verifications = new WeakMap<
  object,
  { runtime: Runtime; conversationType: 1 | 2; conversationID: string; orgID: number; memberIDs: readonly string[] }
>()
export const withVerification = <A, E, R>(
  runtime: Runtime,
  proof: { conversationType: 1 | 2; conversationID: string; orgID: number; memberIDs: readonly string[] },
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const witness = {}
    verifications.set(witness, { runtime, ...proof, memberIDs: [...proof.memberIDs] })
    return effect.pipe(
      Effect.provideService(Verified, witness),
      Effect.ensuring(Effect.sync(() => verifications.delete(witness))),
    )
  })
export const TTL = 259_200_000
export const hash = (value: unknown) => createHash("sha256").update(CanonicalJson.stringify(value)).digest("hex")
const failure = (message: string) => new KernelDeliverySchema.Error({ code: "KERNEL_DELIVERY_UNAVAILABLE", message })
export const active = (runtime: Runtime) => runtimes.get(runtime)?.active === true

/** Host-only issuer. The HTTP payload never receives a Runtime or creation witness. */
export function runtime(source: KernelDeliverySchema.Source, capacity = 100_000): Runtime {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000)
    throw new Error("Kernel delivery capacity must be between 1 and 100000")
  const value = Object.freeze({ source: Object.freeze(Schema.decodeUnknownSync(KernelDeliverySchema.Source)(source)) })
  runtimes.set(value, { active: true, capacity })
  return value
}
export const close = (runtime: Runtime) => {
  const value = runtimes.get(runtime)
  if (value) value.active = false
}
export const withCreation = <A, E, R>(runtime: Runtime, groupID: string, effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const witness = {}
    witnesses.set(witness, { runtime, groupID })
    return effect.pipe(
      Effect.provideService(Current, witness),
      Effect.ensuring(Effect.sync(() => witnesses.delete(witness))),
    )
  })

/** Fixed host boundary after authenticated Finalize, never populated from message metadata.
 * The scoped witness holds the original local record and the independently dated remote object. */
export const withMediaCreation = <A, E, R>(runtime: Runtime, input: KernelDeliverySchema.MediaCreation, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const media = yield* Effect.try({ try: () => structuredClone(Schema.decodeUnknownSync(KernelDeliverySchema.MediaCreation)(input, { onExcessProperty: "error" })), catch: () => failure("Invalid finalized media identity") })
    const witness = {}
    witnesses.set(witness, { runtime, groupID: media.groupID, media })
    return yield* effect.pipe(Effect.provideService(Current, witness), Effect.ensuring(Effect.sync(() => witnesses.delete(witness))))
  })

/** The repository's existing attachment gate may admit a kernel-bound group only
 * inside the exact host Finalize scope. prepare still rechecks and binds every row. */
export const mediaAttachment = (input: { messageID: string; groupID: string; senderID: string; attachmentID: string; workspaceID: string }) => Effect.gen(function* () {
  const token = yield* Current
  const witness = token ? witnesses.get(token) : undefined
  return !!witness?.media && active(witness.runtime) && witness.media.messageID === input.messageID &&
    witness.media.groupID === input.groupID && witness.media.senderID === input.senderID &&
    witness.media.attachments.some((item) => item.local.id === input.attachmentID && item.local.workspaceID === input.workspaceID && item.local.groupID === input.groupID)
})

export const messageHash = (message: Message) =>
  hash([
    message.id,
    message.group_id,
    message.sender_id,
    message.sender_type,
    message.type,
    message.content,
    message.mentions,
    message.metadata,
    message.reply_to_id,
    message.created_at,
  ])
export const wireText = (message: Message) =>
  message.sender_type === "agent" ? `[Agent·${message.sender_id}] ${message.content}` : message.content
const boundedWireText = (message: Message) => {
  const text = wireText(message)
  return new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(text)) === text && new TextEncoder().encode(JSON.stringify({ content: text })).byteLength <= 65536
}
const wireHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
const mediaContent = KernelMediaRetirementModel.mediaWire
const localIdentity = (row: typeof AttachmentTable.$inferSelect) => hash([row.id, row.workspace_id, row.project_id, row.group_id,
  row.uploaded_by, row.storage_path, row.filename, row.mime, row.size_bytes, row.checksum, row.created_at])

/** A comparison/projection only; no caller-provided object gains transport authority. */
export function wireMessage(binding: KernelDeliverySchema.Binding, message: Message) {
  if (binding.messageID !== message.id || binding.groupID !== message.group_id || binding.messageHash !== messageHash(message) ||
      hash(wireText(message)) !== binding.textHash) return undefined
  if (binding.version === 1) return message.type === "text" && boundedWireText(message) ? { messageType: "jg:text" as const, content: JSON.stringify({ content: wireText(message) }) } : undefined
  return message.type === "file" && mediaContent(wireText(message), binding.attachments) === binding.wireContent
    ? { messageType: binding.messageType, content: binding.wireContent } : undefined
}

/** Same transaction as message insertion. An old row never gains a new permission to send. */
export const prepare = Effect.fn("KernelDelivery.prepare")(function* (tx: Tx, message: Message, inserted: boolean) {
  if (!["text", "file"].includes(message.type) || !["user", "agent"].includes(message.sender_type))
    return
  if (message.kernel_msg_id !== null && (message.type !== "file" || (yield* read(tx, message.id))?.binding.version !== 2)) return
  const group = yield* tx.select().from(GroupTable).where(eq(GroupTable.id, message.group_id)).get()
  if (!group?.kernel_conv_id) return
  const token = yield* Current
  const witness = token ? witnesses.get(token) : undefined
  if (!inserted) {
    const existing = yield* read(tx, message.id)
    if (
      existing &&
      witness &&
      (!active(witness.runtime) || hash(existing.binding.source) !== hash(witness.runtime.source))
    )
      return yield* failure("The original message belongs to another transport identity; delivery requires review")
    if (existing?.binding.version === 2 && (!witness?.media || !mediaMatches(witness.media, existing.binding, message)))
      return yield* failure("The original finalized media identity does not match this request")
    return
  }
  if (!witness || witness.groupID !== message.group_id || !active(witness.runtime))
    return yield* failure("Current transport identity is unavailable; the message was not queued for remote delivery")
  const count = yield* tx
    .select({ count: sql<number>`count(*)` })
    .from(IMKernelDeliveryTable)
    .get()
  if ((count?.count ?? 0) >= (runtimes.get(witness.runtime)?.capacity ?? 0))
    return yield* failure("Transport receipt capacity is exhausted; no message was queued")
  const legacy = /^k:([12]):(.+)$/.exec(group.kernel_conv_id)
  const conversation = group.kernel_conv_id.startsWith("kr1:") ? yield* KernelReader.senderConversation(tx, group.id, witness.runtime.source) : legacy ? { conversationType: legacy[1] === "1" ? 1 as const : 2 as const, conversationID: legacy[2] } : undefined
  if (!conversation || group.deleted_at !== null)
    return yield* failure("The kernel conversation binding is unavailable")
  if (message.type === "text" && (!boundedWireText(message) || witness.media)) return yield* failure("Transport message exceeds the bounded text contract")
  const base: KernelDeliverySchema.TextBinding = {
    version: 1,
    messageID: message.id,
    groupID: message.group_id,
    workspaceID: group.workspace_id,
    source: witness.runtime.source,
    conversationType: conversation.conversationType,
    conversationID: conversation.conversationID,
    messageHash: messageHash(message),
    wireID: `dac_${hash(["im-kernel-wire-v1", witness.runtime.source, message.id])}`,
    textHash: hash(wireText(message)),
    createdAt: message.created_at,
    expiresAt: message.created_at + TTL,
  }
  const binding = message.type === "file" ? yield* mediaBinding(tx, base, message, witness.media) : base
  const receipt = yield* tx
    .insert(IMKernelDeliveryTable)
    .values({
      message_id: message.id,
      binding,
      binding_hash: hash(binding),
      wire_id: binding.wireID,
      state: "prepared",
      created_at: message.created_at,
      updated_at: Date.now(),
    })
    .returning().get()
  if (binding.version === 2) {
    if (!receipt) return yield* failure("Original media receipt was not persisted")
    yield* KernelMediaRetirement.initialize(tx, receipt, message).pipe(Effect.mapError(() => failure("Original media body custody is unavailable")))
    if (!active(witness.runtime)) return yield* failure("Current transport identity changed before media commit")
    const member = yield* tx.select({ id: MemberTable.member_id }).from(MemberTable).where(and(eq(MemberTable.group_id, message.group_id),
      eq(MemberTable.member_id, message.sender_id), eq(MemberTable.member_type, message.sender_type === "agent" ? "agent" : "user"))).get()
    if (!member || !(yield* matches(tx, binding, witness.runtime))) return yield* failure("Current media owner changed before commit")
    yield* MediaUploadCheckpoint.handoff(tx,receipt).pipe(Effect.mapError(() => failure("Original upload custody handoff is unavailable")))
    if (!active(witness.runtime) || !(yield* matches(tx,binding,witness.runtime))) return yield* failure("Current media owner changed before handoff commit")
  }
})

function mediaMatches(media: KernelDeliverySchema.MediaCreation, binding: KernelDeliverySchema.MediaBinding, message: Message) {
  return media.messageID === message.id && media.groupID === message.group_id && media.senderID === message.sender_id && media.content === message.content &&
    mediaContent(wireText(message), media.attachments.map((item) => item.remote)) === binding.wireContent &&
    hash(media.attachments.map((item) => ({ localAttachmentID: item.local.id, attachmentID: item.remote.attachmentID, identityHash: capturedLocalIdentity(item.local) }))) === hash(binding.localAttachments)
}
const capturedLocalIdentity = (local: typeof KernelDeliverySchema.LocalAttachment.Type) => hash([local.id, local.workspaceID, local.projectID,
  local.groupID, local.uploadedBy, local.storagePath, local.filename, local.mime, local.sizeBytes, local.checksum, local.createdAt])

function mediaBinding(tx: Tx, base: KernelDeliverySchema.TextBinding, message: Message, media?: KernelDeliverySchema.MediaCreation) {
  return Effect.gen(function* () {
    if (message.sender_type !== "user" && message.sender_type !== "agent") return yield* failure("Media sender is unavailable")
    const metadataMatches = media && (Array.isArray(message.metadata)
      ? message.metadata.length === media.attachments.length && message.metadata.every((item, index) => item.type === "attachment_ref" && item.batch === true && item.attachmentID === media.attachments[index]?.local.id)
      : media.attachments.length === 1 && Schema.is(AttachmentRefMetadata)(message.metadata) && message.metadata.batch === undefined && message.metadata.attachmentID === media.attachments[0]?.local.id)
    if (!media || media.messageID !== message.id || media.groupID !== message.group_id || media.senderID !== message.sender_id || media.content !== message.content || !metadataMatches ||
        new Set(media.attachments.map((item) => item.local.id)).size !== media.attachments.length)
      return yield* failure("Finalized media creation authority is unavailable")
    const member = yield* tx.select({ id: MemberTable.member_id }).from(MemberTable).where(and(eq(MemberTable.group_id, message.group_id), eq(MemberTable.member_id, message.sender_id), eq(MemberTable.member_type, message.sender_type))).get()
    if (!member) return yield* failure("Current attachment owner is not a local conversation member")
    const wireContent = mediaContent(wireText(message), media.attachments.map((item) => item.remote))
    const binding: KernelDeliverySchema.MediaBinding = { ...base, version: 2, messageType: "dac:media.v1",
      wireID: `dac_${hash(["im-kernel-wire-media-v2", base.source, message.id])}`,
      wireContent, wireHash: wireHash(wireContent),
      attachments: media.attachments.map((item) => item.remote),
      localAttachments: media.attachments.map((item) => ({ localAttachmentID: item.local.id, attachmentID: item.remote.attachmentID, identityHash: capturedLocalIdentity(item.local) })),
      expiresAt: Math.min(...media.attachments.map((item) => item.remote.expiresAt)),
    }
    yield* Effect.try({ try: () => { KernelReaderSchema.wireContent(binding.wireContent, binding.messageType, binding.expiresAt); if (KernelReaderSchema.bytes(JSON.stringify(binding)) > KernelDeliverySchema.MEDIA_BINDING_BYTES) throw failure("Media receipt capacity is exhausted") }, catch: () => failure("Finalized media exceeds its bounded wire contract") })
    if (binding.expiresAt <= Date.now()) return yield* failure("The finalized media object has expired")
    for (const item of media.attachments) {
      const local = yield* tx.select().from(AttachmentTable).where(sql`${AttachmentTable.id} = ${item.local.id}`).get()
      if (!local || localIdentity(local) !== capturedLocalIdentity(item.local) || local.workspace_id !== base.workspaceID || local.group_id !== message.group_id ||
          local.uploaded_by !== message.sender_id || local.deleted_at !== null || item.local.deletedAt !== null ||
          (local.message_id !== null && local.message_id !== message.id) || (item.local.messageID !== null && item.local.messageID !== message.id) ||
          AttachmentStorage.expiresAt(local.created_at) <= Date.now() || local.filename !== item.remote.filename || local.size_bytes !== item.remote.sizeBytes || local.checksum !== item.remote.sha256)
        return yield* failure("The original local attachment no longer matches Finalize")
      if (local.message_id === null) yield* tx.update(AttachmentTable).set({ message_id: message.id }).where(eq(AttachmentTable.id, local.id)).run()
    }
    return binding
  })
}

/** Retired facts never yield a live Binding or a new execution grant. */
export const history = Effect.fn("KernelDelivery.history")(function* (db: Reader, messageID: string) {
  const size = yield* db.select({ bytes: sql<number>`length(CAST(${IMKernelDeliveryTable.binding} AS BLOB))` }).from(IMKernelDeliveryTable).where(eq(IMKernelDeliveryTable.message_id, messageID)).get()
  if (size && size.bytes > KernelDeliverySchema.BINDING_BYTES) return yield* failure("Persisted transport receipt exceeds its bounded contract")
  const row = yield* db
    .select()
    .from(IMKernelDeliveryTable)
    .where(eq(IMKernelDeliveryTable.message_id, messageID))
    .get()
  if (!row) {
    yield* ReplyBodyRetirement.forMessage(db,messageID).pipe(Effect.flatMap((value) => value?.receipt ? failure("Original reply receipt custody is unavailable") : Effect.void), Effect.mapError(() => failure("Original reply body custody is unavailable")))
    yield* KernelMediaRetirement.assertMissing(db, messageID).pipe(Effect.mapError(() => failure("Original media body custody is unavailable")))
    return { kind: "missing" as const }
  }
  const reply = yield* ReplyBodyRetirement.forMessage(db,messageID).pipe(Effect.mapError(() => failure("Original reply body custody is unavailable")))
  if (reply?.record.bodyState==="retired") return {kind:"reply_retired" as const,record:reply.record,receipt:{...row,binding:null,body_state:"retired" as const}}
  const body = yield* KernelMediaRetirement.read(db, row).pipe(Effect.mapError(() => failure("Original media body custody is unavailable")))
  if (body?.record.bodyState === "retired") return { kind: "retired" as const, record: body.record,
    receipt: { ...row, binding: null, body_state: "retired" as const } }
  const value = decode(row)
  if (!value) return yield* failure("Persisted transport receipt is invalid")
  return { kind: "live" as const, receipt: value }
})

export const read = Effect.fn("KernelDelivery.read")(function* (db: Reader, messageID: string) {
  const value = yield* history(db, messageID)
  if (value.kind === "missing") return undefined
  if (value.kind === "retired" || value.kind === "reply_retired") return yield* new KernelDeliverySchema.Error({ code: "KERNEL_DELIVERY_RETIRED",
    message: "The original message body has expired; it cannot be uploaded or sent again" })
  return value.receipt
})

function decode(row: typeof IMKernelDeliveryTable.$inferSelect) {
  if (row.body_state !== "live" || row.binding === null) return undefined
  const binding = Schema.decodeUnknownOption(KernelDeliverySchema.Binding)(row.binding, { onExcessProperty: "error" })
  if (
    Option.isNone(binding) ||
    row.binding_hash !== hash(binding.value) ||
    row.message_id !== binding.value.messageID ||
    row.wire_id !== binding.value.wireID ||
    binding.value.wireID !== `dac_${hash([binding.value.version === 1 ? "im-kernel-wire-v1" : "im-kernel-wire-media-v2", binding.value.source, binding.value.messageID])}` ||
    ![
      row.created_at,
      row.updated_at,
      ...(row.dispatched_at === null ? [] : [row.dispatched_at]),
      ...(row.acknowledged_at === null ? [] : [row.acknowledged_at]),
    ].every((time) => Number.isSafeInteger(time) && time >= 0) ||
    row.updated_at < row.created_at ||
    (row.dispatched_at !== null && (row.dispatched_at < row.created_at || row.dispatched_at > row.updated_at)) ||
    (row.acknowledged_at !== null &&
      (row.dispatched_at === null ||
        row.acknowledged_at < row.dispatched_at ||
        row.acknowledged_at > row.updated_at)) ||
    row.created_at !== binding.value.createdAt ||
    (binding.value.version === 1 ? binding.value.expiresAt !== binding.value.createdAt + TTL : !validMedia(binding.value)) ||
    !["prepared", "dispatched", "acknowledged", "unknown"].includes(row.state) ||
    (row.state === "prepared"
      ? row.dispatch_owner !== null || row.dispatched_at !== null
      : !row.dispatch_owner || row.dispatched_at === null) ||
    (row.state === "acknowledged"
      ? !row.kernel_message_id || row.acknowledged_at === null
      : row.kernel_message_id !== null || row.acknowledged_at !== null)
  )
    return undefined
  return { ...row, binding: binding.value }
}

function validMedia(binding: KernelDeliverySchema.MediaBinding) {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(binding.wireContent)
  const envelope = Option.isSome(parsed) ? Schema.decodeUnknownOption(KernelReaderSchema.MediaEnvelope)(parsed.value, { onExcessProperty: "error" }) : Option.none()
  return Option.isSome(envelope) && KernelReaderSchema.bytes(JSON.stringify(binding)) <= KernelDeliverySchema.MEDIA_BINDING_BYTES &&
    binding.wireHash === wireHash(binding.wireContent) && mediaContent(envelope.value.content, binding.attachments) === binding.wireContent &&
    hash(envelope.value.attachments) === hash(binding.attachments) && binding.expiresAt === Math.min(...binding.attachments.map((item) => item.expiresAt)) &&
    binding.expiresAt > binding.createdAt && new Set(binding.attachments.map((item) => item.attachmentID)).size === binding.attachments.length &&
    new Set(binding.localAttachments.map((item) => item.localAttachmentID)).size === binding.localAttachments.length &&
    binding.localAttachments.length === binding.attachments.length && binding.localAttachments.every((item, index) => item.attachmentID === binding.attachments[index]?.attachmentID)
}

const matches = Effect.fn("KernelDelivery.matches")(function* (
  tx: Reader,
  binding: KernelDeliverySchema.Binding,
  runtime: Runtime,
) {
  if (!active(runtime) || hash(binding.source) !== hash(runtime.source)) return false
  const message = yield* tx
    .select()
    .from(MessageTable)
    .where(sql`${MessageTable.id} = ${binding.messageID}`)
    .get()
  const group = yield* tx
    .select()
    .from(GroupTable)
    .where(sql`${GroupTable.id} = ${binding.groupID}`)
    .get()
  const scoped = group?.kernel_conv_id?.startsWith("kr1:") ? yield* KernelReader.senderConversation(tx, group.id, runtime.source) : undefined
  if (binding.version === 2) for (const item of binding.localAttachments) {
    const local = yield* tx.select().from(AttachmentTable).where(sql`${AttachmentTable.id} = ${item.localAttachmentID}`).get()
    if (!local || localIdentity(local) !== item.identityHash || local.deleted_at !== null || local.message_id !== binding.messageID || AttachmentStorage.expiresAt(local.created_at) <= Date.now()) return false
  }
  if (binding.version === 2 && message && (!["agent", "user"].includes(message.sender_type) || !(yield* tx.select({ id: MemberTable.member_id }).from(MemberTable).where(and(
    eq(MemberTable.group_id, message.group_id), eq(MemberTable.member_id, message.sender_id), eq(MemberTable.member_type, message.sender_type === "agent" ? "agent" : "user"))).get()))) return false
  return (
    !!message &&
    !!group &&
    message.deleted_at === null &&
    group.deleted_at === null &&
    group.workspace_id === binding.workspaceID &&
    (group.kernel_conv_id === `k:${binding.conversationType}:${binding.conversationID}` || scoped?.conversationType === binding.conversationType && scoped.conversationID === binding.conversationID) &&
    wireMessage(binding, message) !== undefined
  )
})

/** The caller verifies current platform membership first. CAS consumes the single dispatch forever. */
export const claim = (db: Db, runtime: Runtime, messageID: string) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      const row = yield* read(tx, messageID)
      if (!row || row.state !== "prepared") return undefined
      const token = yield* Verified
      const proof = token ? verifications.get(token) : undefined
      if (
        !proof ||
        proof.runtime !== runtime ||
        proof.orgID !== runtime.source.orgID ||
        proof.conversationType !== row.binding.conversationType ||
        proof.conversationID !== row.binding.conversationID ||
        !proof.memberIDs.includes(runtime.source.senderID) ||
        (proof.conversationType === 1 && !proof.memberIDs.includes(proof.conversationID))
      )
        return undefined
      if (row.binding.expiresAt <= Date.now() || !(yield* matches(tx, row.binding, runtime))) return undefined
      const result = yield* resultOwner(tx, row.binding)
      if (result?.task) {
        const witness = yield* PreparedResult
        const prepared = witness ? preparedResults.get(witness) : undefined
        if (!prepared || prepared.db !== db || prepared.runtime !== runtime || prepared.bindingHash !== row.binding_hash)
          return yield* failure("Original task result dispatch preparation is unavailable")
        yield* prepared.guard.verify(tx, { binding: row.binding, owner: result, original: prepared.original })
      }
      const owner = randomUUID()
      const changed = yield* tx
        .update(IMKernelDeliveryTable)
        .set({ state: "dispatched", dispatch_owner: owner, dispatched_at: Date.now(), updated_at: Date.now() })
        .where(and(eq(IMKernelDeliveryTable.message_id, messageID), eq(IMKernelDeliveryTable.state, "prepared")))
        .returning()
        .get()
      const message = yield* tx
        .select()
        .from(MessageTable)
        .where(sql`${MessageTable.id} = ${messageID}`)
        .get()
      if (changed) yield* ReplyBodyRetirement.refreshMessage(tx,row.message_id).pipe(Effect.mapError(() => failure("Original reply body accounting is unavailable")))
      if (changed && row.binding.version === 2) {
        yield* KernelMediaRetirement.refresh(tx, row).pipe(Effect.mapError(() => failure("Original media body custody is unavailable")))
        if (!(yield* matches(tx, row.binding, runtime))) return yield* failure("Current media dispatch identity changed before commit")
      }
      return changed && message ? { binding: row.binding, owner, text: wireText(message) } : undefined
    }),
  )

export const acknowledge = (db: Db, runtime: Runtime, dispatch: Dispatch, kernelMessageID: string) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      if (!kernelMessageID) return yield* failure("The transport acknowledgement has no message identity")
      const row = yield* read(tx, dispatch.binding.messageID)
      if (
        !row ||
        row.state !== "dispatched" ||
        row.dispatch_owner !== dispatch.owner ||
        row.binding_hash !== hash(dispatch.binding) ||
        !(yield* matches(tx, row.binding, runtime))
      )
        return false
      const group = yield* tx.select().from(GroupTable).where(sql`${GroupTable.id} = ${row.binding.groupID}`).get()
      const message = yield* tx
        .update(MessageTable)
        .set({ kernel_msg_id: group?.kernel_conv_id?.startsWith("kr1:") ? null : kernelMessageID })
        .where(and(sql`${MessageTable.id} = ${row.message_id}`, isNull(MessageTable.kernel_msg_id)))
        .returning()
        .get()
      if (!message) return yield* failure("The local message no longer matches its transport acknowledgement")
      yield* tx
        .update(IMKernelDeliveryTable)
        .set({
          state: "acknowledged",
          kernel_message_id: kernelMessageID,
          acknowledged_at: Date.now(),
          updated_at: Date.now(),
        })
        .where(eq(IMKernelDeliveryTable.message_id, row.message_id))
        .run()
      yield* ReplyBodyRetirement.refreshMessage(tx,row.message_id).pipe(Effect.mapError(() => failure("Original reply body accounting is unavailable")))
      if (row.binding.version === 2) {
        yield* KernelMediaRetirement.refresh(tx, row).pipe(Effect.mapError(() => failure("Original media body custody is unavailable")))
        if (!(yield* matches(tx, row.binding, runtime))) return yield* failure("Current media acknowledgement identity changed before commit")
      }
      return true
    }),
  )

export const uncertain = (db: Db, runtime: Runtime, dispatch: Dispatch) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      const row = yield* read(tx, dispatch.binding.messageID)
      if (
        !row ||
        row.state !== "dispatched" ||
        row.dispatch_owner !== dispatch.owner ||
        row.binding_hash !== hash(dispatch.binding) ||
        !active(runtime) ||
        hash(runtime.source) !== hash(row.binding.source)
      )
        return
      yield* tx
        .update(IMKernelDeliveryTable)
        .set({ state: "unknown", reason: "delivery_outcome_unknown", updated_at: Date.now() })
        .where(eq(IMKernelDeliveryTable.message_id, row.message_id))
        .run()
      yield* ReplyBodyRetirement.refreshMessage(tx,row.message_id).pipe(Effect.mapError(() => failure("Original reply body accounting is unavailable")))
      if (row.binding.version === 2) {
        yield* KernelMediaRetirement.refresh(tx, row).pipe(Effect.mapError(() => failure("Original media body custody is unavailable")))
        if (!active(runtime) || hash(runtime.source) !== hash(row.binding.source)) return yield* failure("Current media uncertainty owner changed before commit")
      }
    }),
  )

export const pending = (db: Db, runtime: Runtime, limit: number) =>
  db
    .select({ message: MessageTable, kernel_conv_id: GroupTable.kernel_conv_id })
    .from(IMKernelDeliveryTable)
    .innerJoin(MessageTable, sql`${MessageTable.id} = ${IMKernelDeliveryTable.message_id}`)
    .innerJoin(GroupTable, eq(GroupTable.id, MessageTable.group_id))
    .where(
      and(
        eq(IMKernelDeliveryTable.state, "prepared"),
        eq(IMKernelDeliveryTable.body_state, "live"),
        isNull(MessageTable.deleted_at),
        isNull(GroupTable.deleted_at),
        sql`json_extract(${IMKernelDeliveryTable.binding}, '$.source.credentialFingerprint') = ${runtime.source.credentialFingerprint}`,
        sql`json_extract(${IMKernelDeliveryTable.binding}, '$.expiresAt') > ${Date.now()}`,
      ),
    )
    .orderBy(asc(IMKernelDeliveryTable.created_at), asc(IMKernelDeliveryTable.message_id))
    .limit(limit)
    .all()

type SenderRetirementFrame = {
  runtime: KernelReader.Runtime; db: Db; sourceHash: string; workspaceID: string; userID: string;
  readerKey: string; bindingHash: string; scopeKey: string; scopeRevision: number;
  serverNow: number; deadline: number; consumed: boolean; mediaConsumed: boolean; replyConsumed: boolean;
}
const SenderRetirement = Context.Reference<object | undefined>("IMKernelDelivery.private-sender-retirement", { defaultValue: () => undefined })
const senderRetirements = new WeakMap<object, SenderRetirementFrame>()
/** No current mapping exists yet. The original body remains unchanged while
 * the Host independently establishes its current projection. */
export class SenderRetirementDeferred extends Schema.TaggedErrorClass<SenderRetirementDeferred>()("KernelDelivery.SenderRetirementDeferred", {
  candidates: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
}) {}

/** A body-only purpose. Neither persisted receipt JSON nor a caller clock can
 * reconstruct the original Host's successful SDK observation. */
export const withSenderRetirement = <A, E, R>(runtime: KernelReader.Runtime, observation: object, effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const engine = yield* KernelReader.current(runtime)
  const observed = engine.retirementObservation?.(observation)
  const stored = yield* KernelReader.scope(runtime)
  if (!observed || !stored || performance.now() >= observed.deadline ||
    Option.isNone(Schema.decodeUnknownOption(KernelDeliverySchema.Time)(observed.serverNow)) ||
    observed.scopeKey !== stored.scope_key || observed.version !== KernelReader.readerVersion(runtime))
    return yield* failure("The original sender retirement observation is unavailable")
  const witness = {}
  senderRetirements.set(witness, { runtime, db: engine.db, sourceHash: hash(engine.source), workspaceID: engine.workspaceID,
    userID: engine.userID, readerKey: stored.reader_key, bindingHash: stored.binding_hash, scopeKey: stored.scope_key,
    scopeRevision: stored.local_revision, serverNow: observed.serverNow, deadline: observed.deadline, consumed: false, mediaConsumed: false, replyConsumed: false })
  return yield* effect.pipe(Effect.provideService(SenderRetirement, witness),
    Effect.ensuring(Effect.sync(() => senderRetirements.delete(witness))))
})

export const retirePreviousSender = () => Effect.gen(function* () {
  const witness = yield* SenderRetirement
  const frame = witness && senderRetirements.get(witness)
  if (!frame || frame.consumed || performance.now() >= frame.deadline)
    return yield* failure("The original sender retirement purpose is unavailable")
  frame.consumed = true
  return yield* cleanupSenderBodies(frame.runtime, frame.serverNow, frame)
})

/** The same one-use SDK observation may maintain independent sender body
 * domains. Neither its clock nor a persisted media summary can authorize send. */
export const retireSenderMedia = () => Effect.gen(function* () {
  const witness = yield* SenderRetirement
  const frame = witness && senderRetirements.get(witness)
  if (!frame || frame.mediaConsumed || performance.now() >= frame.deadline)
    return yield* failure("The original sender retirement purpose is unavailable")
  frame.mediaConsumed = true
  return yield* cleanupMediaBodies(frame)
})

/** Independent one-use reply custody purpose, from the same actual SDK clock.
 * No collector timestamp or persisted record can manufacture this frame. */
export const retireSenderReplies = () => Effect.gen(function* () {
  const witness = yield* SenderRetirement
  const frame = witness && senderRetirements.get(witness)
  if (!frame || frame.replyConsumed || performance.now() >= frame.deadline)
    return yield* failure("The original reply retirement purpose is unavailable")
  frame.replyConsumed = true
  return yield* cleanupMediaBodies(frame,"reply")
})

/** Core owns only the canonical Message/receipt/summary copies. Attachment
 * files, remote objects, reader mirrors and outbox bodies retain their owners. */
function cleanupMediaBodies(frame: SenderRetirementFrame, domain: "media"|"reply"="media") {
  return Effect.gen(function* () {
    const engine = yield* KernelReader.current(frame.runtime)
    const committed: { binding: KernelDeliverySchema.Binding; ledgerHash: string }[] = []
    const meter: {revision:number;used_records:number;used_bytes:number;custody_id:string}[] = []
    const verify = (tx: Reader, binding?: KernelDeliverySchema.Binding) => Effect.gen(function* () {
        const current = yield* KernelReader.current(frame.runtime)
        const scope = yield* tx.select().from(IMKernelReaderScopeTable).where(eq(IMKernelReaderScopeTable.reader_key, frame.readerKey)).get()
        if (performance.now() >= frame.deadline || current.db !== frame.db || current.workspaceID !== frame.workspaceID ||
          current.userID !== frame.userID || hash(current.source) !== frame.sourceHash || !scope ||
          scope.scope_key !== frame.scopeKey || scope.binding_hash !== frame.bindingHash || scope.local_revision !== frame.scopeRevision ||
          scope.binding_hash !== hash(scope.binding) || (yield* KernelReader.scope(frame.runtime))?.reader_key !== scope.reader_key)
          return yield* failure("Current media retirement owner or scope changed")
        if (!binding) return
        if (!sameSenderAccount(binding.source, current.source) || binding.workspaceID !== current.workspaceID || binding.expiresAt > frame.serverNow)
          return yield* failure("Original media retirement identity changed")
        const group = yield* tx.select().from(GroupTable).where(sql`${GroupTable.id}=${binding.groupID}`).get()
        const member = yield* tx.select({ id: MemberTable.member_id }).from(MemberTable).where(and(
          sql`${MemberTable.group_id}=${binding.groupID}`, eq(MemberTable.member_id, current.userID), eq(MemberTable.member_type, "user"))).get()
        const scoped = group?.kernel_conv_id?.startsWith("kr1:") ? yield* KernelReader.senderConversation(tx, group.id, current.source) : undefined
        if (!group || !member || group.deleted_at !== null || group.workspace_id !== binding.workspaceID ||
          (group.kernel_conv_id !== `k:${binding.conversationType}:${binding.conversationID}` &&
            !(scoped?.conversationType === binding.conversationType && scoped.conversationID === binding.conversationID)))
          return yield* failure("Current media retirement conversation or membership changed")
        if (hash(binding.source) === hash(current.source)) return
        const projection = yield* tx.select({ projection: IMKernelReaderProjectionTable, scope: IMKernelReaderScopeTable })
          .from(IMKernelReaderProjectionTable).innerJoin(IMKernelReaderScopeTable, eq(IMKernelReaderScopeTable.reader_key, IMKernelReaderProjectionTable.reader_key))
          .where(and(eq(IMKernelReaderProjectionTable.reader_key, frame.readerKey), eq(IMKernelReaderProjectionTable.conversation_type, binding.conversationType),
            eq(IMKernelReaderProjectionTable.target_id, binding.conversationID))).limit(2).all()
        if (projection.length !== 1 || !retirementProjection(projection[0]!, binding, current.source, true))
          return yield* failure("Original media retirement account lacks its current projection")
        const currentMember = yield* tx.select({ id: MemberTable.member_id }).from(MemberTable).innerJoin(GroupTable, eq(GroupTable.id, MemberTable.group_id))
          .where(and(sql`${MemberTable.group_id}=${projection[0]!.projection.local_group_id}`, eq(MemberTable.member_id, current.userID),
            eq(MemberTable.member_type, "user"), eq(GroupTable.workspace_id, current.workspaceID), isNull(GroupTable.deleted_at))).get()
        if (!currentMember) return yield* failure("Current media retirement account membership changed")
    })
    return yield* engine.db.transaction((tx) => Effect.gen(function* () {
      yield* verify(tx)
      const rows = domain==="reply" ? yield* tx.select({delivery:IMKernelDeliveryTable}).from(IMReplyBodyTable)
        .innerJoin(IMReplyOutboxTable,eq(IMReplyOutboxTable.id,IMReplyBodyTable.outbox_id))
        .innerJoin(IMKernelDeliveryTable,eq(IMKernelDeliveryTable.message_id,IMReplyBodyTable.receipt_message_id))
        .innerJoin(MessageTable,eq(MessageTable.id,IMReplyBodyTable.local_message_id)).innerJoin(GroupTable,eq(GroupTable.id,MessageTable.group_id))
        .where(and(eq(IMReplyBodyTable.body_state,"live"),eq(IMReplyBodyTable.custody_state,"kernel"),lte(IMReplyBodyTable.original_expires_at,frame.serverNow),
          eq(IMReplyOutboxTable.status,"delivered"),eq(IMKernelDeliveryTable.state,"acknowledged"),eq(GroupTable.workspace_id,engine.workspaceID),
          eq(MessageTable.sender_type,"agent"),eq(MessageTable.type,"text"),isNull(MessageTable.deleted_at),isNull(GroupTable.deleted_at),
          sql`${IMReplyBodyTable.origin_kind}<>'legacy_unbound'`,
          sql`json_extract(${IMKernelDeliveryTable.binding},'$.source.realm')=${engine.source.realm}`,
          sql`json_extract(${IMKernelDeliveryTable.binding},'$.source.appkey')=${engine.source.appkey}`,
          sql`json_extract(${IMKernelDeliveryTable.binding},'$.source.orgID') IS ${engine.source.orgID}`,
          sql`json_extract(${IMKernelDeliveryTable.binding},'$.source.senderID')=${engine.source.senderID}`,
          sql`NOT EXISTS(SELECT 1 FROM im_kernel_reader_message r WHERE r.local_message_id=${MessageTable.id} AND r.owns_message=1)`))
        .orderBy(asc(IMReplyBodyTable.original_expires_at),asc(IMReplyBodyTable.outbox_id)).limit(32).all() : yield* tx.select({ delivery: IMKernelDeliveryTable }).from(IMKernelMediaBodyTable)
        .innerJoin(IMKernelDeliveryTable, eq(IMKernelDeliveryTable.message_id, IMKernelMediaBodyTable.message_id))
        .innerJoin(MessageTable, eq(MessageTable.id, IMKernelMediaBodyTable.message_id)).innerJoin(GroupTable, eq(GroupTable.id, MessageTable.group_id))
        .where(and(eq(IMKernelMediaBodyTable.workspace_id, engine.workspaceID), eq(IMKernelMediaBodyTable.body_state, "live"),
          lte(IMKernelMediaBodyTable.expires_at, frame.serverNow), eq(IMKernelDeliveryTable.state, "acknowledged"),
          eq(MessageTable.sender_id, engine.userID), eq(MessageTable.sender_type, "user"), eq(MessageTable.type, "file"),
          isNull(MessageTable.deleted_at), isNull(GroupTable.deleted_at),
          sql`json_extract(${IMKernelDeliveryTable.binding},'$.source.realm')=${engine.source.realm}`,
          sql`json_extract(${IMKernelDeliveryTable.binding},'$.source.appkey')=${engine.source.appkey}`,
          sql`json_extract(${IMKernelDeliveryTable.binding},'$.source.orgID') IS ${engine.source.orgID}`,
          sql`json_extract(${IMKernelDeliveryTable.binding},'$.source.senderID')=${engine.source.senderID}`,
          sql`NOT EXISTS(SELECT 1 FROM im_kernel_reader_message r WHERE r.local_message_id=${MessageTable.id} AND r.owns_message=1)`,
          sql`NOT EXISTS(SELECT 1 FROM im_reply_outbox o WHERE o.delivery_message_id=${MessageTable.id})`))
        .orderBy(asc(IMKernelMediaBodyTable.expires_at), asc(IMKernelMediaBodyTable.message_id)).limit(KernelMediaRetirementModel.PAGE_LIMIT).all()
      const bindings: KernelDeliverySchema.Binding[] = []
      for (const item of rows) {
        const receipt = decode(item.delivery)
        if (!receipt || receipt.binding.version !== (domain==="media"?2:1)) return yield* failure("Original media retirement receipt is invalid")
        yield* verify(tx, receipt.binding)
        const retired = domain==="media" ? yield* KernelMediaRetirement.retire(tx,receipt,frame.serverNow).pipe(Effect.mapError(() => failure("Original media retirement custody is unavailable"))) :
          yield* ReplyBodyRetirement.forMessage(tx,receipt.message_id).pipe(Effect.flatMap((owner) => owner ? ReplyBodyRetirement.retire(tx,owner.outbox.id,frame.serverNow) : ReplyBodyRetirementModel.invalid()),Effect.mapError(() => failure("Original reply body custody is unavailable")))
        if (!retired) return yield* failure("Original sender retirement body changed")
        bindings.push(receipt.binding)
      }
      yield* verify(tx)
      yield* Effect.forEach(bindings, (binding) => verify(tx, binding), { discard: true })
      for (const binding of bindings) {
        const body = domain==="media" ? yield* tx.select().from(IMKernelMediaBodyTable).where(eq(IMKernelMediaBodyTable.message_id,binding.messageID)).get() : (yield* ReplyBodyRetirement.forMessage(tx,binding.messageID))?.body
        if (!body || body.body_state !== "retired") return yield* failure("Original media retirement marker is unavailable")
        committed.push({ binding, ledgerHash: hash(body) })
      }
      if (committed.length) meter.push(yield* (domain==="media" ? KernelMediaRetirement.currentMeter(tx) : ReplyBodyRetirement.currentMeter(tx)))
      return [...new Set(bindings.map((binding) => binding.groupID))]
    }), { behavior: "immediate" }).pipe(Effect.catchCause((cause) => {
      if (!committed.length || meter.length !== 1) return Effect.failCause(cause)
      // COMMIT may have succeeded before its response failed. Reconcile only
      // exact actual after-write facts; this path contains no business writes.
      return engine.db.transaction((tx) => Effect.gen(function* () {
        yield* verify(tx)
        const actualMeter = yield* (domain==="media" ? KernelMediaRetirement.currentMeter(tx) : ReplyBodyRetirement.currentMeter(tx))
        if (hash(actualMeter) !== hash(meter[0])) return yield* failure("Original media retirement accounting changed")
        for (const item of committed) {
          yield* verify(tx, item.binding)
          const historical = yield* history(tx, item.binding.messageID)
          const body = domain==="media" ? yield* tx.select().from(IMKernelMediaBodyTable).where(eq(IMKernelMediaBodyTable.message_id,item.binding.messageID)).get() : (yield* ReplyBodyRetirement.forMessage(tx,item.binding.messageID))?.body
          if (!body || hash(body)!==item.ledgerHash || (domain==="media" ? historical.kind!=="retired" || historical.record.identity.bindingHash!==hash(item.binding) : historical.kind!=="reply_retired" || historical.record.transport?.bindingHash!==hash(item.binding)) ||
            historical.kind==="missing" || historical.kind==="live" || historical.record.retiredAt!==item.binding.expiresAt)
            return yield* failure("Original media retirement commit is unknown")
        }
        yield* verify(tx)
        yield* Effect.forEach(committed, (item) => verify(tx, item.binding), { discard: true })
        return [...new Set(committed.map((item) => item.binding.groupID))]
      })).pipe(Effect.catchCause(() => Effect.failCause(cause)))
    }))
  })
}

/** Only a successful current SDK response supplies this clock. This local body
 * cleanup retains the original receipt and request identity; it never sends. */
export const cleanupSender = (runtime: KernelReader.Runtime, serverNow: number) => cleanupSenderBodies(runtime, serverNow)
const cleanupSenderBodies = (runtime: KernelReader.Runtime, serverNow: number, retirement?: SenderRetirementFrame) => Effect.gen(function* () {
  const engine = yield* KernelReader.current(runtime)
  if (Option.isNone(Schema.decodeUnknownOption(KernelDeliverySchema.Time)(serverNow)))
    return yield* failure("The sender cleanup clock is unavailable")
  if (!(yield* KernelReader.scope(runtime))) return []
  return yield* engine.db.transaction((tx) => Effect.gen(function* () {
    const rows = yield* tx.select({ message: MessageTable, delivery: IMKernelDeliveryTable })
      .from(IMKernelDeliveryTable).innerJoin(MessageTable, eq(IMKernelDeliveryTable.message_id, MessageTable.id))
      .innerJoin(GroupTable, eq(GroupTable.id, MessageTable.group_id))
      .where(and(eq(GroupTable.workspace_id, engine.workspaceID), isNull(GroupTable.deleted_at),
        eq(MessageTable.sender_id, engine.userID), eq(MessageTable.sender_type, "user"), eq(MessageTable.type, "text"),
        isNull(MessageTable.reply_to_id), isNull(MessageTable.deleted_at),
        // V1 expiry equals created_at+TTL. The original state/time index avoids
        // scanning current receipt bodies when no sender text has expired.
        inArray(IMKernelDeliveryTable.state, ["prepared", "dispatched", "acknowledged", "unknown"]),
        lte(IMKernelDeliveryTable.created_at, serverNow - TTL),
        sql`json_extract(${IMKernelDeliveryTable.binding}, '$.version') = 1`,
        sql`json_extract(${IMKernelDeliveryTable.binding}, '$.expiresAt') <= ${serverNow}`,
        sql`json_extract(${IMKernelDeliveryTable.binding}, '$.source.realm') = ${engine.source.realm}`,
        sql`json_extract(${IMKernelDeliveryTable.binding}, '$.source.appkey') = ${engine.source.appkey}`,
        sql`json_extract(${IMKernelDeliveryTable.binding}, '$.source.orgID') = ${engine.source.orgID}`,
        sql`json_extract(${IMKernelDeliveryTable.binding}, '$.source.senderID') = ${engine.source.senderID}`,
        retirement ? sql`json_extract(${IMKernelDeliveryTable.binding}, '$.source.credentialFingerprint') <> ${engine.source.credentialFingerprint}`
          : sql`json_extract(${IMKernelDeliveryTable.binding}, '$.source.credentialFingerprint') = ${engine.source.credentialFingerprint}`,
        sql`length(CAST(${IMKernelDeliveryTable.binding} AS BLOB)) <= ${KernelDeliverySchema.BINDING_BYTES}`,
        sql`length(CAST(${MessageTable.content} AS BLOB)) <= 65536`,
        sql`coalesce(length(CAST(${MessageTable.metadata} AS BLOB)), 0) <= 131072`,
        sql`coalesce(length(CAST(${MessageTable.mentions} AS BLOB)), 0) <= 131072`,
        sql`NOT EXISTS (SELECT 1 FROM im_kernel_reader_message r WHERE r.local_message_id=${MessageTable.id} AND r.owns_message=1)`,
        sql`NOT EXISTS (SELECT 1 FROM im_reply_outbox o WHERE o.delivery_message_id=${MessageTable.id})`))
      .orderBy(asc(IMKernelDeliveryTable.state), asc(IMKernelDeliveryTable.created_at), asc(IMKernelDeliveryTable.message_id)).limit(32).all()
    const verifyRetirement = () => Effect.gen(function* () {
      if (!retirement) return
      const current = yield* KernelReader.current(runtime)
      const stored = yield* tx.select().from(IMKernelReaderScopeTable).where(eq(IMKernelReaderScopeTable.reader_key, retirement.readerKey)).get()
      if (performance.now() >= retirement.deadline || current.db !== retirement.db || current.workspaceID !== retirement.workspaceID ||
        current.userID !== retirement.userID || hash(current.source) !== retirement.sourceHash || !stored ||
        stored.scope_key !== retirement.scopeKey || stored.binding_hash !== retirement.bindingHash ||
        stored.local_revision !== retirement.scopeRevision || stored.binding_hash !== hash(stored.binding))
        return yield* failure("The current sender retirement owner or scope changed")
      const original = yield* KernelReader.scope(runtime)
      if (original?.reader_key !== stored.reader_key || original.binding_hash !== stored.binding_hash)
        return yield* failure("The current sender retirement scope is unavailable")
    })
    yield* verifyRetirement()
    const verifyScope = (groupID: string, binding?: KernelDeliverySchema.TextBinding) => Effect.gen(function* () {
      yield* KernelReader.current(runtime)
      yield* verifyRetirement()
      const group = yield* tx.select().from(GroupTable).where(sql`${GroupTable.id}=${groupID}`).get()
      const member = yield* tx.select({ id: MemberTable.member_id }).from(MemberTable)
        .where(and(sql`${MemberTable.group_id}=${groupID}`, eq(MemberTable.member_id, engine.userID), eq(MemberTable.member_type, "user"))).get()
      const scoped = group?.kernel_conv_id?.startsWith("kr1:")
        ? yield* KernelReader.senderConversation(tx, group.id, engine.source) : undefined
      if (!group || !member || group.deleted_at !== null || group.workspace_id !== engine.workspaceID ||
        (!binding && !scoped && !/^k:[12]:.+$/.test(group.kernel_conv_id ?? "")) ||
        (binding && (binding.groupID !== groupID || binding.workspaceID !== group.workspace_id ||
          (group.kernel_conv_id !== `k:${binding.conversationType}:${binding.conversationID}` &&
            !(scoped?.conversationType === binding.conversationType && scoped.conversationID === binding.conversationID)))))
        return yield* failure("The current sender cleanup scope is unavailable")
      if (!retirement || !binding) return
      // The old group and the current projection can have different local IDs.
      // Their original remote tuple is proved independently; no mirror body is
      // accepted as evidence that the canonical old sender body was retired.
      const current = yield* tx.select({ projection: IMKernelReaderProjectionTable, scope: IMKernelReaderScopeTable })
        .from(IMKernelReaderProjectionTable).innerJoin(IMKernelReaderScopeTable, eq(IMKernelReaderScopeTable.reader_key, IMKernelReaderProjectionTable.reader_key))
        .where(and(eq(IMKernelReaderProjectionTable.reader_key, retirement.readerKey),
          eq(IMKernelReaderProjectionTable.conversation_type, binding.conversationType),
          eq(IMKernelReaderProjectionTable.target_id, binding.conversationID))).limit(2).all()
      if (current.length === 0 && bindings.length === 0)
        return yield* Effect.fail(new SenderRetirementDeferred({ candidates: rows.length }))
      if (current.length !== 1 || !retirementProjection(current[0], binding, engine.source, true))
        return yield* failure("The current sender retirement conversation is unavailable")
      const currentGroup = current[0].projection.local_group_id
      const currentMember = currentGroup && (yield* tx.select({ id: MemberTable.member_id }).from(MemberTable)
        .innerJoin(GroupTable, eq(GroupTable.id, MemberTable.group_id)).where(and(sql`${MemberTable.group_id}=${currentGroup}`,
          eq(MemberTable.member_id, engine.userID), eq(MemberTable.member_type, "user"), eq(GroupTable.workspace_id, engine.workspaceID), isNull(GroupTable.deleted_at))).get())
      if (!currentMember) return yield* failure("The current sender retirement membership is unavailable")
      if (!group.kernel_conv_id?.startsWith("kr1:")) return
      const old = yield* tx.select({ projection: IMKernelReaderProjectionTable, scope: IMKernelReaderScopeTable })
        .from(IMKernelReaderProjectionTable).innerJoin(IMKernelReaderScopeTable, eq(IMKernelReaderScopeTable.reader_key, IMKernelReaderProjectionTable.reader_key))
        .where(eq(IMKernelReaderProjectionTable.local_group_id, group.id)).get()
      if (!old || group.kernel_conv_id !== `kr1:${old.projection.binding_key}` || !retirementProjection(old, binding, engine.source, false))
        return yield* failure("The original sender retirement group is unavailable")
    })
    const bindings: KernelDeliverySchema.TextBinding[] = []
    for (const item of rows) {
      const row = decode(item.delivery)
      // A malformed old receipt cannot hide current owner or membership loss.
      yield* verifyScope(item.message.group_id, row?.binding.version === 1 ? row.binding : undefined)
      if (!row || row.binding.version !== 1 || row.binding.expiresAt > serverNow ||
        (retirement ? !sameSenderAccount(row.binding.source, engine.source) || row.binding.source.credentialFingerprint === engine.source.credentialFingerprint
          : hash(row.binding.source) !== hash(engine.source)))
        return yield* Effect.fail(new KernelDeliverySchema.SenderCleanupError({ code: "sender_binding_mismatch", candidates: rows.length }))
      if (!wireMessage(row.binding, item.message))
        return yield* Effect.fail(new KernelDeliverySchema.SenderCleanupError({ code: "sender_body_mismatch", candidates: rows.length }))
      const changed = yield* tx.update(MessageTable).set({ content: "", deleted_at: row.binding.expiresAt,
        updated_at: Math.max(item.message.updated_at, Date.now()) })
        .where(and(eq(MessageTable.id, item.message.id), isNull(MessageTable.deleted_at),
          eq(MessageTable.content, item.message.content), eq(MessageTable.updated_at, item.message.updated_at)))
        .returning({ id: MessageTable.id }).get()
      if (!changed) return yield* failure("The expired sender body changed before cleanup")
      bindings.push(row.binding)
    }
    // A later owner, membership or group change rolls back every body in this
    // batch. No receipt/hash is rewritten to make the tombstone sendable again.
    yield* KernelReader.current(runtime)
    yield* Effect.forEach(bindings, (binding) => verifyScope(binding.groupID, binding), { discard: true })
    yield* verifyRetirement()
    return [...new Set(bindings.map((binding) => binding.groupID))]
  }), { behavior: "immediate" })
})

function sameSenderAccount(original: KernelDeliverySchema.Source, current: KernelDeliverySchema.Source) {
  return original.realm === current.realm && original.appkey === current.appkey && original.orgID === current.orgID && original.senderID === current.senderID
}

function retirementProjection(row: { projection: typeof IMKernelReaderProjectionTable.$inferSelect; scope: typeof IMKernelReaderScopeTable.$inferSelect }, binding: KernelDeliverySchema.Binding, source: KernelDeliverySchema.Source, visible: boolean) {
  if (KernelReaderSchema.bytes(row.projection.metadata) > 4096 || KernelReaderSchema.bytes(row.scope.binding) > 8192 ||
    row.scope.binding_hash !== hash(row.scope.binding) || row.projection.metadata_hash !== hash(row.projection.metadata)) return false
  const scope = KernelReaderSchema.decode(KernelReaderSchema.Binding, row.scope.binding, 8192)
  const metadata = KernelReaderSchema.decode(KernelReaderSchema.Metadata, row.projection.metadata, 4096)
  if (scope.workspaceID !== binding.workspaceID || row.scope.workspace_id !== binding.workspaceID || scope.realm !== source.realm ||
    scope.appkey !== source.appkey || scope.orgID !== String(source.orgID) || scope.userID !== source.senderID ||
    row.scope.scope_key !== scope.scopeKey || row.scope.reader_key !== hash(["deepagent.im.reader.v1", row.scope.binding]) ||
    row.projection.visibility !== metadata.visibility || row.projection.local_group_id === null ||
    row.projection.conversation_type !== binding.conversationType || row.projection.target_id !== binding.conversationID ||
    row.projection.binding_key !== hash(["deepagent.im.reader.mapping.v1", row.scope.reader_key, binding.conversationType, binding.conversationID]) ||
    row.projection.local_group_id !== `img_kr_${row.projection.binding_key}`) return false
  if (metadata.visibility === "pending") return !visible && metadata.sourceHash === hash(binding.source) && metadata.conversationType === binding.conversationType && metadata.targetId === binding.conversationID
  return metadata.visibility === "visible" && metadata.conversationType === binding.conversationType && metadata.targetId === binding.conversationID &&
    row.projection.projection_key === metadata.projectionKey && row.projection.server_revision === metadata.revision && row.projection.cursor === metadata.cursor &&
    row.projection.live_unread === metadata.liveUnread && row.projection.stored_unread === metadata.storedUnread && row.projection.read_ordinal === metadata.readOrdinal &&
    row.projection.admitted_ordinal === metadata.admittedOrdinal && row.projection.next_expiry_at === metadata.nextExpiryAt
}

export const status = Effect.fn("KernelDelivery.status")(function* (db: Reader, messageID: string, runtime?: Runtime) {
  const historical = yield* history(db, messageID)
  if (historical.kind === "missing") return { messageID, state: "unknown" as const, kernelMessageID: null, reason: "legacy_missing_receipt" }
  if (historical.kind === "retired" || historical.kind === "reply_retired") return { messageID, state: historical.receipt.state, kernelMessageID: historical.receipt.kernel_message_id, reason: historical.receipt.reason }
  const row = historical.receipt
  if (row.state === "dispatched")
    return { messageID, state: "unknown" as const, kernelMessageID: null, reason: "delivery_outcome_unknown" }
  if (
    row.state === "prepared" &&
    (row.binding.expiresAt <= Date.now() || (runtime && hash(runtime.source) !== hash(row.binding.source)))
  )
    return {
      messageID,
      state: "unknown" as const,
      kernelMessageID: null,
      reason: "delivery_identity_or_expiry_changed",
    }
  return { messageID, state: row.state, kernelMessageID: row.kernel_message_id, reason: row.reason }
})

export type Transport = { state: "prepared" | "acknowledged" | "unknown"; reason?: string }
/** One bounded SELECT per authorized message page; reads never reconcile or dispatch. */
export const statuses = Effect.fn("KernelDelivery.statuses")(function* (
  db: Reader,
  messageIDs: readonly string[],
  runtime?: Runtime,
) {
  if (messageIDs.length > 100) return yield* failure("Transport status page exceeds its bounded limit")
  const result: Record<string, Transport> = {}
  if (messageIDs.length === 0) return result
  const rows = yield* db
    .select({ message: MessageTable, group: GroupTable, delivery: IMKernelDeliveryTable,
      body: { ...getTableColumns(IMKernelMediaBodyTable), record: sql<string | null>`CASE WHEN length(CAST(${IMKernelMediaBodyTable.record} AS BLOB))<=${KernelMediaRetirementModel.SUMMARY_BYTES} THEN ${IMKernelMediaBodyTable.record} ELSE NULL END` },
      meter: IMKernelMediaMeterTable, mediaBytes: sql<number>`${KernelMediaRetirement.joinedBytes}`,
      reply: IMReplyBodyTable, replyMeter: IMReplyBodyMeterTable, outbox: IMReplyOutboxTable,
      replyBytes: sql<number>`${ReplyBodyRetirement.joinedBytes}`,
      rawOutbox: sql<string|null>`CASE WHEN ${IMReplyBodyTable.outbox_id} IS NOT NULL AND sum(CASE WHEN ${IMReplyBodyTable.outbox_id} IS NULL THEN 0 ELSE ${ReplyBodyRetirement.joinedBytes} END) OVER()<=${ReplyBodyRetirementModel.BYTE_LIMIT} THEN ${ReplyBodyRetirement.outboxJSON} END`,
      rawMessage: sql<string|null>`CASE WHEN ${IMReplyBodyTable.outbox_id} IS NOT NULL AND sum(CASE WHEN ${IMReplyBodyTable.outbox_id} IS NULL THEN 0 ELSE ${ReplyBodyRetirement.joinedBytes} END) OVER()<=${ReplyBodyRetirementModel.BYTE_LIMIT} THEN ${ReplyBodyRetirement.messageJSON} END`,
      rawReceipt: sql<string|null>`CASE WHEN ${IMReplyBodyTable.outbox_id} IS NOT NULL AND ${IMKernelDeliveryTable.message_id} IS NOT NULL AND sum(CASE WHEN ${IMReplyBodyTable.outbox_id} IS NULL THEN 0 ELSE ${ReplyBodyRetirement.joinedBytes} END) OVER()<=${ReplyBodyRetirementModel.BYTE_LIMIT} THEN ${ReplyBodyRetirement.receiptJSON} END` })
    .from(MessageTable)
    .innerJoin(GroupTable, eq(GroupTable.id, MessageTable.group_id))
    .leftJoin(IMKernelDeliveryTable, and(sql`${IMKernelDeliveryTable.message_id} = ${MessageTable.id}`, sql`(${IMKernelDeliveryTable.binding} IS NULL OR length(CAST(${IMKernelDeliveryTable.binding} AS BLOB)) <= ${KernelDeliverySchema.BINDING_BYTES})`))
    .leftJoin(IMKernelMediaBodyTable, eq(IMKernelMediaBodyTable.message_id, MessageTable.id))
    .leftJoin(IMKernelMediaMeterTable, eq(IMKernelMediaMeterTable.meter_id, 1))
    .leftJoin(IMReplyOutboxTable,eq(IMReplyOutboxTable.delivery_message_id,MessageTable.id))
    .leftJoin(IMReplyBodyTable,eq(IMReplyBodyTable.outbox_id,IMReplyOutboxTable.id))
    .leftJoin(IMReplyBodyMeterTable,eq(IMReplyBodyMeterTable.meter_id,1))
    .where(inArray(MessageTable.id, messageIDs as Message["id"][]))
    .all()
  for (const item of rows) {
    if (item.outbox || item.reply) {
      if (!item.outbox || !item.reply || !item.replyMeter || !item.rawOutbox || !item.rawMessage || item.body || item.delivery && !item.rawReceipt)
        return yield* failure("Original reply body custody is unavailable")
      const reply = yield* Effect.try({try:() => ReplyBodyRetirement.validateStored({outbox:item.outbox!,message:item.message,receipt:item.delivery??undefined,
        group:item.group,rawOutbox:ReplyBodyRetirement.rawFromJSON(item.rawOutbox!),rawMessage:ReplyBodyRetirement.rawFromJSON(item.rawMessage!),
        rawReceipt:item.rawReceipt ? ReplyBodyRetirement.rawFromJSON(item.rawReceipt) : null,
        bytes:item.replyBytes-ReplyBodyRetirementModel.accounting([item.reply!])},item.reply!,item.replyMeter!),catch:()=>failure("Original reply body custody is unavailable")})
      if (reply.record.bodyState==="retired") {result[item.message.id]={state:"acknowledged"};continue}
    }
    const body = item.body && typeof item.body.record === "string" ? { ...item.body, record: item.body.record } : null
    if (item.body && !body || !item.delivery && item.body) return yield* failure("Original media body custody is unavailable")
    const original = item.delivery ? yield* Effect.try({ try: () => KernelMediaRetirement.validateStored({ receipt: item.delivery!,
      body, meter: item.meter, message: item.message, group: item.group, bytes: item.mediaBytes }),
      catch: () => failure("Original media body custody is unavailable") }) : undefined
    if (original?.record.bodyState === "retired") {
      result[item.message.id] = { state: "acknowledged" }
      continue
    }
    if (item.message.deleted_at !== null || item.group.deleted_at !== null || !item.group.kernel_conv_id) continue
    if (!item.delivery) {
      if (
        item.message.kernel_msg_id === null &&
        ["text", "file"].includes(item.message.type) &&
        ((item.message.sender_type === "user" && item.message.sender_id === "server") ||
          item.message.sender_type === "agent")
      )
        result[item.message.id] = { state: "unknown", reason: "legacy_missing_receipt" }
      continue
    }
    const row = decode(item.delivery)
    const scoped = runtime && item.group.kernel_conv_id.startsWith("kr1:") ? yield* KernelReader.senderConversation(db, item.group.id, runtime.source) : undefined
    if (
      !row ||
      !wireMessage(row.binding, item.message) ||
      row.binding.groupID !== item.group.id ||
      row.binding.workspaceID !== item.group.workspace_id ||
      (item.group.kernel_conv_id !== `k:${row.binding.conversationType}:${row.binding.conversationID}` && !(scoped?.conversationType === row.binding.conversationType && scoped.conversationID === row.binding.conversationID))
    ) {
      result[item.message.id] = { state: "unknown", reason: "receipt_mismatch" }
      continue
    }
    if (row.state === "acknowledged") {
      result[item.message.id] =
        row.kernel_message_id !== null && (item.message.kernel_msg_id === row.kernel_message_id || scoped !== undefined && item.message.kernel_msg_id === null)
          ? { state: "acknowledged" }
          : { state: "unknown", reason: "receipt_mismatch" }
      continue
    }
    if (row.state !== "prepared") {
      result[item.message.id] = { state: "unknown", reason: "delivery_outcome_unknown" }
      continue
    }
    result[item.message.id] =
      !runtime ||
      !active(runtime) ||
      hash(row.binding.source) !== hash(runtime.source) ||
      row.binding.expiresAt <= Date.now()
        ? { state: "unknown", reason: "delivery_identity_or_expiry_changed" }
        : { state: "prepared" }
  }
  return result
})
