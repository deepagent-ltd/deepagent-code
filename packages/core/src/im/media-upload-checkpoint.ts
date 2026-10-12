export * as MediaUploadCheckpoint from "./media-upload-checkpoint"

import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { Context, Effect } from "effect"
import type { Database } from "../database/database"
import { AttachmentStorage } from "./attachment-storage"
import { KernelReader } from "./kernel-reader"
import { KernelReaderSchema } from "./kernel-reader.schema"
import { KernelDelivery } from "./kernel-delivery"
import { KernelDeliverySchema } from "./kernel-delivery.schema"
import { KernelMediaRetirement } from "./kernel-media-retirement"
import { MediaUploadCheckpointModel } from "./media-upload-checkpoint.model"
import { IMMediaUploadCheckpointTable, IMMediaUploadMeterTable } from "./media-upload-checkpoint.sql"
import { IMKernelDeliveryTable } from "./kernel-delivery.sql"
import { AttachmentTable, GroupTable, MemberTable, MessageTable } from "./sql"

type Db = Database.Interface["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Db | Tx
type Row = typeof IMMediaUploadCheckpointTable.$inferSelect
export type Request = { messageID: string; clientRequestID: string; groupID: string; senderID: string; content: string; replyToID?: string; attachmentIDs: readonly string[]; batch: boolean }
const OriginFrame = Context.Reference<object | undefined>("IMMediaUpload.private-origin", { defaultValue: () => undefined })
const frames = new WeakMap<object, { runtime: KernelReader.Runtime; db: Db; groupID: string; namespace: Namespace; active: boolean }>()
export type Namespace = Omit<MediaUploadCheckpointModel.Origin, "attachment" | "localExpiresAt">
const bounded = <A>(run: () => A) => Effect.try({ try: run, catch: (error) => error instanceof MediaUploadCheckpointModel.Error ? error : MediaUploadCheckpointModel.invalid() })
export const requestHash = (input: Request) => MediaUploadCheckpointModel.hash(["deepagent.im.media-upload.request.v1", input.messageID, input.clientRequestID, input.groupID, input.senderID, "user", "file", input.content, input.replyToID ?? null, input.batch, input.attachmentIDs])
export const attachment = (row: typeof AttachmentTable.$inferSelect): typeof KernelDeliverySchema.LocalAttachment.Type => ({ id: row.id, workspaceID: row.workspace_id, projectID: row.project_id, groupID: row.group_id, messageID: row.message_id, uploadedBy: row.uploaded_by, storagePath: row.storage_path, filename: row.filename, mime: row.mime, sizeBytes: row.size_bytes, checksum: row.checksum, createdAt: row.created_at, deletedAt: row.deleted_at })
const accounting = (row: Record<string, unknown>) => MediaUploadCheckpointModel.ROW_OVERHEAD + Object.values(row).reduce<number>((total, value) => total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : typeof value === "number" ? 8 : 0), 0)
export const actualBytes = sql.raw("1024+" + ["checkpoint_id","custody_id","attachment_id","group_id","planned_message_id","origin_hash","plan_hash","remote_hash","record","record_hash","phase","attempt_owner","current_source_hash","message_ref","receipt_ref"].map((name) => `coalesce(length(CAST(\"${name}\" AS BLOB)),0)`).concat(["meter_id","body_verified","begin_dispatched","attempt_revision","attempt_expires_at","original_local_expires_at","original_remote_expires_at","local_revision","accounted_records","accounted_bytes","created_at","updated_at"].map((name) => `CASE WHEN \"${name}\" IS NULL THEN 0 ELSE 8 END`)).join("+"))
export const meter = (db: Reader) => Effect.gen(function* () {
  const value = yield* db.select().from(IMMediaUploadMeterTable).where(eq(IMMediaUploadMeterTable.meter_id,1)).get()
  if (!value || value.version !== 1 || value.used_records < 1 || value.used_records > MediaUploadCheckpointModel.RECORD_LIMIT || value.used_bytes < MediaUploadCheckpointModel.METER_BYTES || value.used_bytes > MediaUploadCheckpointModel.BYTE_LIMIT) return yield* MediaUploadCheckpointModel.invalid()
  return value
})
export const namespace = (runtime: KernelReader.Runtime) => Effect.gen(function* () {
  const engine = yield* KernelReader.current(runtime)
  const scope = yield* KernelReader.scope(runtime)
  if (!scope || engine.source.orgID === null) return yield* MediaUploadCheckpointModel.invalid()
  const binding = yield* bounded(() => KernelReaderSchema.decode(KernelReaderSchema.Binding,scope.binding,8192))
  const budget = yield* meter(engine.db)
  return { custodyID: budget.custody_id, readerInstanceID: binding.instanceID, readerKey: scope.reader_key, scopeKey: scope.scope_key, workspaceID: engine.workspaceID, userID: engine.userID, groupID: "", source: engine.source as MediaUploadCheckpointModel.Source }
})
const fence = (tx: Reader, runtime: KernelReader.Runtime, original: Namespace) => Effect.gen(function* () {
  const engine = yield* KernelReader.current(runtime)
  const scope = yield* KernelReader.scope(runtime)
  const group = yield* tx.select().from(GroupTable).where(sql`${GroupTable.id}=${original.groupID}`).get()
  const member = yield* tx.select().from(MemberTable).where(and(sql`${MemberTable.group_id}=${original.groupID}`,eq(MemberTable.member_id,original.userID),eq(MemberTable.member_type,"user"))).get()
  if (!scope || scope.reader_key !== original.readerKey || scope.scope_key !== original.scopeKey || engine.workspaceID !== original.workspaceID || engine.userID !== original.userID || KernelDelivery.hash(engine.source) !== KernelDelivery.hash(original.source) || !group || group.deleted_at !== null || group.workspace_id !== original.workspaceID || !group.kernel_conv_id || !member) return yield* MediaUploadCheckpointModel.conflict()
})
/** Only an actual current protected upload can mint an origin. The callback's
 * insert and this frame's consumption run in the original repository TX. */
export const withOrigin = <A,E,R>(runtime: KernelReader.Runtime,groupID:string,effect:Effect.Effect<A,E,R>) => Effect.gen(function* () {
  const engine = yield* KernelReader.current(runtime)
  const original = { ...(yield* namespace(runtime)), groupID }
  yield* fence(engine.db,runtime,original)
  const token = {}
  const frame = { runtime,db:engine.db,groupID,namespace:original,active:true }
  frames.set(token,frame)
  return yield* effect.pipe(Effect.provideService(OriginFrame,token),Effect.ensuring(Effect.sync(() => { frame.active=false;frames.delete(token) })))
})
export const initializeOrigin = (tx: Tx,local:typeof AttachmentTable.$inferSelect) => Effect.gen(function* () {
  const token = yield* OriginFrame
  const frame = token ? frames.get(token) : undefined
  if (!frame?.active) return
  if (local.group_id !== frame.groupID || local.workspace_id !== frame.namespace.workspaceID || local.uploaded_by !== frame.namespace.userID || local.message_id !== null || local.deleted_at !== null) return yield* MediaUploadCheckpointModel.conflict()
  yield* fence(tx,frame.runtime,frame.namespace)
  const origin = { ...frame.namespace,attachment:attachment(local),localExpiresAt:AttachmentStorage.expiresAt(local.created_at) }
  const value: MediaUploadCheckpointModel.Record = {version:1,checkpointID:MediaUploadCheckpointModel.checkpointID(origin),origin,originHash:MediaUploadCheckpointModel.originHash(origin),plan:null,planHash:null,remote:null,remoteHash:null,remoteFacts:null,phase:"eligible",bodyVerified:false,beginDispatched:false,attemptOwner:null,attemptRevision:0,attemptExpiresAt:null,currentSourceHash:null,messageRef:null,receiptRef:null,outcome:"none"}
  const row = yield* bounded(() => physical(value,1,Date.now(),Date.now()))
  yield* reserve(tx,1,row.accounted_bytes)
  yield* tx.insert(IMMediaUploadCheckpointTable).values(row).run()
  yield* read(tx,local.id)
  yield* fence(tx,frame.runtime,frame.namespace)
})
export const read = (db:Reader,attachmentID:string) => Effect.gen(function* () {
  const length = yield* db.get<{bytes:number}>(sql`SELECT length(CAST(record AS BLOB)) bytes FROM im_media_upload_checkpoint WHERE attachment_id=${attachmentID}`)
  if (length && length.bytes > MediaUploadCheckpointModel.RECORD_BYTES) return yield* MediaUploadCheckpointModel.invalid()
  const row = yield* db.select().from(IMMediaUploadCheckpointTable).where(eq(IMMediaUploadCheckpointTable.attachment_id,attachmentID)).get()
  if (!row) return undefined
  const value = yield* bounded(() => MediaUploadCheckpointModel.decode(row.record))
  const budget = yield* meter(db)
  const local = yield* db.select().from(AttachmentTable).where(sql`${AttachmentTable.id}=${attachmentID}`).get()
  const measured = yield* db.get<{bytes:number}>(sql`SELECT ${actualBytes} bytes FROM im_media_upload_checkpoint WHERE attachment_id=${attachmentID}`)
  if (!local || row.custody_id !== budget.custody_id || value.origin.custodyID !== budget.custody_id || row.record_hash !== MediaUploadCheckpointModel.hash(value) || row.accounted_records !== 1 || row.accounted_bytes !== measured?.bytes || row.accounted_bytes !== accounting(row) || budget.used_records < 2 || budget.used_bytes < MediaUploadCheckpointModel.METER_BYTES+row.accounted_bytes || MediaUploadCheckpointModel.attachmentHash(attachment(local)) !== MediaUploadCheckpointModel.attachmentHash(value.origin.attachment) || row.checkpoint_id !== value.checkpointID || row.origin_hash !== value.originHash || row.plan_hash !== value.planHash || row.remote_hash !== value.remoteHash || row.phase !== value.phase || row.local_revision < 1) return yield* MediaUploadCheckpointModel.invalid()
  return {row,value,local,budget}
})
export const emptyBusiness = (db:Reader,messageID:string) => Effect.gen(function* () {
  const history = yield* KernelDelivery.history(db,messageID)
  const message = yield* db.select({id:MessageTable.id}).from(MessageTable).where(sql`${MessageTable.id}=${messageID}`).get()
  const foreign = yield* db.get<{occupied:number}>(sql`SELECT EXISTS(SELECT 1 FROM im_reply_outbox WHERE delivery_message_id=${messageID}) OR EXISTS(SELECT 1 FROM im_kernel_reader_message WHERE local_message_id=${messageID}) occupied`)
  if (history.kind !== "missing" || message || foreign?.occupied) return yield* MediaUploadCheckpointModel.conflict()
})
export const plan = (runtime:KernelReader.Runtime,input:Request) => Effect.gen(function* () {
  const engine = yield* KernelReader.current(runtime)
  const current = { ...(yield* namespace(runtime)),groupID:input.groupID }
  if (!input.clientRequestID || input.senderID !== current.userID || input.attachmentIDs.length < 1 || input.attachmentIDs.length > 4 || new Set(input.attachmentIDs).size !== input.attachmentIDs.length) return yield* MediaUploadCheckpointModel.conflict()
  return yield* engine.db.transaction((tx) => Effect.gen(function* () {
    yield* fence(tx,runtime,current)
    yield* emptyBusiness(tx,input.messageID)
    const rows = yield* Effect.forEach(input.attachmentIDs,(id) => read(tx,id).pipe(Effect.flatMap((found) => found ? Effect.succeed(found) : Effect.fail(MediaUploadCheckpointModel.legacy()))))
    const other = yield* tx.select({id:IMMediaUploadCheckpointTable.attachment_id}).from(IMMediaUploadCheckpointTable).where(eq(IMMediaUploadCheckpointTable.planned_message_id,input.messageID)).all()
    if (other.some((item) => !input.attachmentIDs.includes(item.id))) return yield* MediaUploadCheckpointModel.conflict()
    const batch = rows.map((item) => ({attachmentID:item.local.id,identityHash:MediaUploadCheckpointModel.attachmentHash(attachment(item.local))}))
    const result = yield* Effect.forEach(rows,(found,index) => Effect.gen(function* () {
      const origin = found.value.origin
      if (origin.readerInstanceID !== current.readerInstanceID || origin.readerKey !== current.readerKey || origin.scopeKey !== current.scopeKey || origin.workspaceID !== current.workspaceID || origin.userID !== current.userID || origin.groupID !== current.groupID || !MediaUploadCheckpointModel.sameIdentity(origin.source,current.source) || found.local.message_id !== null || found.local.deleted_at !== null) return yield* MediaUploadCheckpointModel.conflict()
      if (origin.localExpiresAt <= Date.now()) return yield* MediaUploadCheckpointModel.expired()
      const proposed:MediaUploadCheckpointModel.Plan = {messageID:input.messageID,clientRequestHash:MediaUploadCheckpointModel.hash(input.clientRequestID),requestHash:requestHash(input),source:found.value.plan?.source ?? origin.source,uploadID:found.value.plan?.uploadID ?? MediaUploadCheckpointModel.uploadID(origin.source,input.messageID,origin.attachment),batch,index}
      if (found.value.plan && found.value.planHash !== MediaUploadCheckpointModel.planHash(proposed)) return yield* MediaUploadCheckpointModel.conflict()
      if (found.value.attemptOwner && found.value.attemptExpiresAt !== null && found.value.attemptExpiresAt > Date.now()) return yield* MediaUploadCheckpointModel.inFlight()
      if (found.value.phase === "eligible") return yield* rewrite(tx,found,{...found.value,plan:proposed,planHash:MediaUploadCheckpointModel.planHash(proposed),phase:"planned"})
      if (["expired","cancelled","attached"].includes(found.value.phase)) return yield* MediaUploadCheckpointModel.conflict()
      return found.value
    }))
    yield* fence(tx,runtime,current)
    return result
  }),{behavior:"immediate"})
})
export const claim = (runtime:KernelReader.Runtime,attachmentID:string) => Effect.gen(function* () {
  const engine = yield* KernelReader.current(runtime)
  const current = yield* namespace(runtime)
  return yield* engine.db.transaction((tx) => Effect.gen(function* () {
    const found = yield* read(tx,attachmentID)
    if (!found?.value.plan || found.local.message_id !== null || found.local.deleted_at !== null) return yield* MediaUploadCheckpointModel.conflict()
    yield* emptyBusiness(tx,found.value.plan.messageID)
    const original = {...current,groupID:found.value.origin.groupID}
    yield* fence(tx,runtime,original)
    if (!MediaUploadCheckpointModel.sameIdentity(found.value.origin.source,current.source) || found.value.origin.readerKey !== current.readerKey || found.value.origin.readerInstanceID !== current.readerInstanceID || found.value.origin.scopeKey !== current.scopeKey || found.value.origin.localExpiresAt <= Date.now() || found.value.remote && found.value.remote.expiresAt <= Date.now()) return yield* MediaUploadCheckpointModel.expired()
    if (found.value.attemptOwner && found.value.attemptExpiresAt !== null && found.value.attemptExpiresAt > Date.now()) return yield* MediaUploadCheckpointModel.inFlight()
    const updated = {...found.value,attemptOwner:randomUUID(),attemptRevision:found.value.attemptRevision+1,attemptExpiresAt:Date.now()+30_000,currentSourceHash:KernelDelivery.hash(current.source)}
    yield* rewrite(tx,found,updated)
    yield* fence(tx,runtime,original)
    return updated
  }),{behavior:"immediate"})
})
export const updateAttempt = (runtime:KernelReader.Runtime,original:MediaUploadCheckpointModel.Record,update:Partial<Pick<MediaUploadCheckpointModel.Record,"bodyVerified"|"beginDispatched"|"remote"|"remoteFacts"|"phase"|"outcome">>, release=false) => Effect.gen(function* () {
  const engine = yield* KernelReader.current(runtime)
  const current = {...(yield* namespace(runtime)),groupID:original.origin.groupID}
  return yield* engine.db.transaction((tx) => Effect.gen(function* () {
    yield* fence(tx,runtime,current)
    const found = yield* read(tx,original.origin.attachment.id)
    if (!found || found.value.attemptOwner !== original.attemptOwner || found.value.attemptRevision !== original.attemptRevision || found.value.currentSourceHash !== KernelDelivery.hash(current.source) || found.value.planHash !== original.planHash || found.value.attemptExpiresAt === null || found.value.attemptExpiresAt <= Date.now()) return yield* MediaUploadCheckpointModel.conflict()
    yield* emptyBusiness(tx,found.value.plan!.messageID)
    if (update.remote && found.value.remote && MediaUploadCheckpointModel.remoteHash(update.remote) !== found.value.remoteHash) return yield* MediaUploadCheckpointModel.conflict()
    const changed = {...found.value,...update,remoteHash:MediaUploadCheckpointModel.remoteHash(update.remote ?? found.value.remote),...(release?{attemptOwner:null,attemptExpiresAt:null}:{})}
    const result = yield* rewrite(tx,found,changed)
    yield* fence(tx,runtime,current)
    return result
  }),{behavior:"immediate"})
})
export const abandon = (runtime:KernelReader.Runtime,original:MediaUploadCheckpointModel.Record) => Effect.gen(function* () {
  const engine = yield* KernelReader.current(runtime)
  const found = yield* read(engine.db,original.origin.attachment.id)
  if (!found) return yield* MediaUploadCheckpointModel.invalid()
  return yield* updateAttempt(runtime,original,{phase:found.value.beginDispatched ? "unknown_upload" : "planned",outcome:found.value.beginDispatched ? "unknown_upload" : "local_unavailable"},true)
})
/** Complete real transport custody replaces, rather than duplicates, the
 * temporary upload origin. No weak Message-only handoff can release quota. */
export const handoff = (tx:Tx,receipt:typeof IMKernelDeliveryTable.$inferSelect) => Effect.gen(function* () {
  if (receipt.binding?.version !== 2) return
  const rows = yield* tx.select({id:IMMediaUploadCheckpointTable.attachment_id}).from(IMMediaUploadCheckpointTable).where(eq(IMMediaUploadCheckpointTable.planned_message_id,receipt.message_id)).limit(5).all()
  const binding = receipt.binding
  const owned = yield* tx.select({id:IMMediaUploadCheckpointTable.attachment_id}).from(IMMediaUploadCheckpointTable).where(sql`${IMMediaUploadCheckpointTable.attachment_id} IN (${sql.join(binding.localAttachments.map((item)=>sql`${item.localAttachmentID}`),sql`,`)})`).limit(5).all()
  if (!rows.length && !owned.length) return
  if (owned.length !== rows.length) return yield* MediaUploadCheckpointModel.conflict()
  const custody = yield* KernelMediaRetirement.read(tx,receipt)
  if (!custody || custody.record.bodyState !== "live" || rows.length !== binding.localAttachments.length || rows.length > 4) return yield* MediaUploadCheckpointModel.invalid()
  yield* Effect.forEach(binding.localAttachments,(mapping,index) => Effect.gen(function* () {
    const found = yield* read(tx,mapping.localAttachmentID)
    const remote = binding.attachments[index]
    if (!found?.value.plan || found.value.phase !== "uploaded" || found.value.attemptOwner !== null || found.value.plan.messageID !== receipt.message_id || found.value.plan.index !== index || found.value.plan.batch.length !== rows.length || found.value.origin.groupID !== binding.groupID || found.value.origin.workspaceID !== binding.workspaceID || found.value.origin.userID !== custody.message.sender_id || found.value.currentSourceHash !== KernelDelivery.hash(binding.source) || found.local.message_id !== receipt.message_id || !remote || found.value.remote?.objectID !== remote.attachmentID || found.value.remoteHash !== MediaUploadCheckpointModel.remoteHash({objectID:remote.attachmentID,uploadID:found.value.plan.uploadID,filename:remote.filename,sizeBytes:remote.sizeBytes,sha256:remote.sha256,createdAt:remote.createdAt,expiresAt:remote.expiresAt})) return yield* MediaUploadCheckpointModel.invalid()
    if (!custody.message.client_request_id || found.value.plan.clientRequestHash !== MediaUploadCheckpointModel.hash(custody.message.client_request_id) || found.value.plan.requestHash !== requestHash({messageID:receipt.message_id,clientRequestID:custody.message.client_request_id,groupID:custody.message.group_id,senderID:custody.message.sender_id,content:custody.message.content,replyToID:custody.message.reply_to_id??undefined,attachmentIDs:binding.localAttachments.map((item)=>item.localAttachmentID),batch:Array.isArray(custody.message.metadata)})) return yield* MediaUploadCheckpointModel.conflict()
    yield* reserve(tx,-1,-found.row.accounted_bytes)
    const deleted = yield* tx.delete(IMMediaUploadCheckpointTable).where(and(eq(IMMediaUploadCheckpointTable.checkpoint_id,found.row.checkpoint_id),eq(IMMediaUploadCheckpointTable.local_revision,found.row.local_revision))).returning({id:IMMediaUploadCheckpointTable.checkpoint_id}).get()
    if (!deleted) return yield* MediaUploadCheckpointModel.conflict()
  }),{discard:true})
})
export const expire = (tx:Tx,attachmentID:string) => Effect.gen(function* () {
  const found = yield* read(tx,attachmentID)
  if (!found || found.value.beginDispatched || found.value.attemptOwner || found.value.remote || found.value.origin.localExpiresAt > Date.now() || found.local.deleted_at === null || found.local.message_id !== null) return
  if (found.value.plan) yield* emptyBusiness(tx,found.value.plan.messageID)
  yield* reserve(tx,-1,-found.row.accounted_bytes)
  yield* tx.delete(IMMediaUploadCheckpointTable).where(and(eq(IMMediaUploadCheckpointTable.checkpoint_id,found.row.checkpoint_id),eq(IMMediaUploadCheckpointTable.local_revision,found.row.local_revision))).run()
})
function physical(value:MediaUploadCheckpointModel.Record,revision:number,created:number,updated:number):Row {
  const record = MediaUploadCheckpointModel.encode(value)
  const row = {checkpoint_id:value.checkpointID,meter_id:1,custody_id:value.origin.custodyID,attachment_id:value.origin.attachment.id,group_id:value.origin.groupID,planned_message_id:value.plan?.messageID??null,origin_hash:value.originHash,plan_hash:value.planHash,remote_hash:value.remoteHash,record,record_hash:MediaUploadCheckpointModel.hash(value),phase:value.phase,body_verified:value.bodyVerified?1:0,begin_dispatched:value.beginDispatched?1:0,attempt_owner:value.attemptOwner,attempt_revision:value.attemptRevision,attempt_expires_at:value.attemptExpiresAt,current_source_hash:value.currentSourceHash,original_local_expires_at:value.origin.localExpiresAt,original_remote_expires_at:value.remote?.expiresAt??null,message_ref:value.messageRef,receipt_ref:value.receiptRef,local_revision:revision,accounted_records:1,accounted_bytes:0,created_at:created,updated_at:updated}
  row.accounted_bytes=accounting(row)
  if (row.accounted_bytes>MediaUploadCheckpointModel.RECORD_BYTES) throw MediaUploadCheckpointModel.capacity()
  return row
}
const reserve = (tx:Tx,records:number,bytes:number) => Effect.gen(function* () {
  if (!Number.isSafeInteger(records) || !Number.isSafeInteger(bytes) || Math.abs(bytes)>4*MediaUploadCheckpointModel.RECORD_BYTES) return yield* MediaUploadCheckpointModel.capacity()
  const original = yield* meter(tx)
  const changed = yield* tx.update(IMMediaUploadMeterTable).set({used_records:original.used_records+records,used_bytes:original.used_bytes+bytes,revision:original.revision+1,updated_at:Math.max(Date.now(),original.updated_at)}).where(and(eq(IMMediaUploadMeterTable.meter_id,1),eq(IMMediaUploadMeterTable.revision,original.revision),sql`${original.used_records+records} BETWEEN 1 AND ${MediaUploadCheckpointModel.RECORD_LIMIT}`,sql`${original.used_bytes+bytes} BETWEEN ${MediaUploadCheckpointModel.METER_BYTES} AND ${MediaUploadCheckpointModel.BYTE_LIMIT}`)).returning().get()
  if (!changed) return yield* MediaUploadCheckpointModel.capacity()
})
const rewrite = (tx:Tx,original:Effect.Success<ReturnType<typeof read>> & {},value:MediaUploadCheckpointModel.Record) => Effect.gen(function* () {
  const row = yield* bounded(() => physical(value,original.row.local_revision+1,original.row.created_at,Math.max(Date.now(),original.row.updated_at)))
  yield* reserve(tx,0,row.accounted_bytes-original.row.accounted_bytes)
  const changed = yield* tx.update(IMMediaUploadCheckpointTable).set(row).where(and(eq(IMMediaUploadCheckpointTable.checkpoint_id,original.row.checkpoint_id),eq(IMMediaUploadCheckpointTable.local_revision,original.row.local_revision))).returning().get()
  if (!changed) return yield* MediaUploadCheckpointModel.conflict()
  return value
})
