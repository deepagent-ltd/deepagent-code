export * as KernelReader from "./kernel-reader"

import { createHash, randomUUID } from "node:crypto"
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { KernelReaderSchema } from "./kernel-reader.schema"
import { KernelDelivery } from "./kernel-delivery"
import { KernelDeliverySchema } from "./kernel-delivery.schema"
import { IMKernelDeliveryTable } from "./kernel-delivery.sql"
import { IMKernelReaderMeterTable, IMKernelReaderScopeTable, IMKernelReaderProjectionTable, IMKernelReaderMessageTable, IMKernelReaderReadIntentTable } from "./kernel-reader.sql"
import { GroupTable, MemberTable, MessageTable } from "./sql"
import { GroupID, MessageID } from "./id"
import { Log } from "../util/log"
import { IMMentionIntentBytes, IMMentionIntentTable } from "./mention-intent.sql"

type Db = Database.Interface["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Db | Tx
type Projection = typeof IMKernelReaderProjectionTable.$inferSelect
type Scope = typeof IMKernelReaderScopeTable.$inferSelect
type ReadIntent = typeof IMKernelReaderReadIntentTable.$inferSelect
export type Runtime = { readonly incarnation: string; readonly displayEpoch: string }
type Engine = { db: Db; workspaceID: string; userID: string; source: KernelDeliverySchema.Source; current: () => Effect.Effect<boolean>; readCut: (input: { version: 1 | 2; scopeKey: string; projectionKey: string; projectionRevision: string }) => Effect.Effect<KernelReaderSchema.Cut, KernelReaderSchema.Error>; inspect: (input: { conversationType: 1 | 2; conversationID: string }) => Effect.Effect<{ name: string }, KernelReaderSchema.Error>; liveObservation?: (handle: object) => KernelReaderSchema.LiveObservation | undefined; retirementObservation?: (handle: object) => { serverNow: number; scopeKey: string; version: 1 | 2; deadline: number } | undefined; active: boolean; scopeKey?: string; readerKey?: string; readerVersion?: 1 | 2 }
const engines = new WeakMap<Runtime, Engine>()
const Output = Context.Reference<object | undefined>("IMKernelReader.private-output", { defaultValue: () => undefined })
type Frame = { runtime: Runtime; db: Db; workspaceID: string; userID: string; readerKey?: string; started: number; emptyProofDeadline?: number; projections: Map<string, { row: Projection; deadline: number; serverNow: number; started: number; cut?: KernelReaderSchema.Cut }>; active: boolean }
const outputs = new WeakMap<object, Frame>()
// The existing public GroupPageReader proof window also bounds pending/cut observations.
const outputProofWindowMs = 1000
export const hash = (value: unknown) => KernelDelivery.hash(value)
const bodyHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
const failure = KernelReaderSchema.failure

/** Constructed once by the actual scoped host engine. Persistent hashes never recreate it. */
export function attach(input: Omit<Engine, "active" | "scopeKey" | "readerKey" | "readerVersion">): Runtime {
  const runtime = Object.freeze({ incarnation: randomUUID(), displayEpoch: randomUUID() })
  engines.set(runtime, { ...input, source: Object.freeze({ ...input.source }), active: true })
  return runtime
}
export const close = (runtime: Runtime) => { const engine = engines.get(runtime); if (engine) engine.active = false }
/** Only the original retired in-memory owner may conservatively settle its
 * dispatched bookkeeping. A fresh runtime or persisted incarnation is not
 * permission to infer another owner's completion or perform a new mark. */
export const retireReads = (runtime: Runtime) => Effect.gen(function* () {
  const engine = engines.get(runtime)
  if (!engine || engine.active) return yield* failure("reader_unavailable", "retire-read")
  if (!engine.readerKey) return
  const within = and(eq(IMKernelReaderReadIntentTable.reader_key, engine.readerKey),
    eq(IMKernelReaderReadIntentTable.runtime_incarnation, runtime.incarnation),
    eq(IMKernelReaderReadIntentTable.phase, "dispatched"))
  // Each transaction materializes at most one page of body-free IDs. The
  // existing whole-store record budget bounds the total number of batches.
  for (const round of Array.from({ length: Math.ceil(KernelReaderSchema.RECORD_LIMIT / 32) + 1 }, (_, index) => index)) {
    const changed = yield* engine.db.transaction((tx) => Effect.gen(function* () {
      const rows = yield* tx.select({ id: IMKernelReaderReadIntentTable.action_id,
        revision: IMKernelReaderReadIntentTable.local_revision, updated: IMKernelReaderReadIntentTable.updated_at })
        .from(IMKernelReaderReadIntentTable).where(within).orderBy(IMKernelReaderReadIntentTable.action_id).limit(32).all()
      if (round === Math.ceil(KernelReaderSchema.RECORD_LIMIT / 32) && rows.length)
        return yield* failure("reader_cleanup_required", "retire-read")
      yield* Effect.forEach(rows, (row) => Effect.gen(function* () {
        const result = yield* tx.update(IMKernelReaderReadIntentTable).set({ phase: "unknown",
          local_revision: row.revision + 1, updated_at: Math.max(row.updated, Date.now()) })
          .where(and(within, eq(IMKernelReaderReadIntentTable.action_id, row.id),
            eq(IMKernelReaderReadIntentTable.local_revision, row.revision)))
          .returning({ id: IMKernelReaderReadIntentTable.action_id }).get()
        if (!result) return yield* failure("reader_stale", "retire-read")
      }), { discard: true })
      return rows.length
    }), { behavior: "immediate" })
    if (!changed) return
    yield* Effect.yieldNow
  }
}).pipe(Effect.mapError((error) => error instanceof KernelReaderSchema.Error
  ? error : failure("reader_cleanup_required", "retire-read")))
export const active = (runtime: Runtime) => engines.get(runtime)?.active === true
export const current = (runtime: Runtime) => Effect.gen(function* () {
  const engine = engines.get(runtime)
  if (!engine?.active || !(yield* engine.current())) return yield* failure("reader_unavailable", "current")
  return engine
})
export const readerVersion = (runtime: Runtime): 1 | 2 => engines.get(runtime)?.readerVersion ?? 1
export const bind = (runtime: Runtime, scopeKey: string, version: 1 | 2 = 1) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  SchemaHash(scopeKey)
  if ((version !== 1 && version !== 2) || engine.scopeKey && (engine.scopeKey !== scopeKey || readerVersion(runtime) !== version)) { engine.active = false; return yield* failure("reader_scope_mismatch", "bind") }
  engine.scopeKey = scopeKey
  engine.readerVersion = version
})
function SchemaHash(value: string) { if (!/^[a-f0-9]{64}$/.test(value)) throw failure("reader_scope_mismatch", "scope") }
export const accounting = (value: Record<string, unknown>, reserved = 0) => 1024 + Object.values(value).reduce<number>((sum, item) => sum + (typeof item === "string" ? KernelReaderSchema.bytes(item) : typeof item === "number" ? 8 : 0), 0) + reserved
const reserve = (tx: Tx, records: number, bytes: number) => Effect.gen(function* () {
  if (!Number.isSafeInteger(records) || !Number.isSafeInteger(bytes) || Math.abs(bytes) > 8_388_608) return yield* failure("reader_capacity", "reserve")
  const meter = yield* tx.select().from(IMKernelReaderMeterTable).where(eq(IMKernelReaderMeterTable.id, 1)).get()
  if (!meter) return yield* failure("reader_cleanup_required", "meter")
  const changed = yield* tx.update(IMKernelReaderMeterTable).set({ used_records: sql`${IMKernelReaderMeterTable.used_records} + ${records}`, used_bytes: sql`${IMKernelReaderMeterTable.used_bytes} + ${bytes}`, revision: meter.revision + 1, updated_at: Date.now() }).where(and(eq(IMKernelReaderMeterTable.id, 1), eq(IMKernelReaderMeterTable.revision, meter.revision), sql`${IMKernelReaderMeterTable.used_records} + ${records} BETWEEN 1 AND ${KernelReaderSchema.RECORD_LIMIT}`, sql`${IMKernelReaderMeterTable.used_bytes} + ${bytes} BETWEEN 1024 AND ${KernelReaderSchema.BYTE_LIMIT}`)).returning().get()
  if (!changed) return yield* failure("reader_capacity", "reserve")
})
const refreshGroupName = (tx: Tx, engine: Engine, projection: Projection, name: string) => Effect.gen(function* () {
  if (!Schema.is(KernelReaderSchema.text(512))(name) || !projection.local_group_id || projection.visibility === "revoked") return yield* failure("reader_mapping_conflict", "group-name")
  const group = yield* tx.select().from(GroupTable).where(and(eq(GroupTable.id, GroupID.make(projection.local_group_id)), eq(GroupTable.workspace_id, engine.workspaceID), eq(GroupTable.kernel_conv_id, `kr1:${projection.binding_key}`), isNull(GroupTable.deleted_at))).get()
  if (!group || projection.owned_group_bytes < accounting(group) || projection.accounted_bytes !== accounting(projection) + projection.owned_group_bytes) return yield* failure("reader_mapping_conflict", "group-name")
  if (group.name === name) return projection
  const delta = accounting({ ...group, name }) - accounting(group)
  const update = { owned_group_bytes: projection.owned_group_bytes + delta, accounted_bytes: projection.accounted_bytes + delta, local_revision: projection.local_revision + 1, updated_at: Date.now() }
  yield* reserve(tx, 0, delta)
  const changed = yield* tx.update(GroupTable).set({ name }).where(and(eq(GroupTable.id, group.id), eq(GroupTable.workspace_id, engine.workspaceID), eq(GroupTable.kernel_conv_id, group.kernel_conv_id!), eq(GroupTable.name, group.name), isNull(GroupTable.deleted_at))).returning().get()
  if (!changed) return yield* failure("reader_stale", "group-name")
  const refreshed = yield* tx.update(IMKernelReaderProjectionTable).set(update).where(and(eq(IMKernelReaderProjectionTable.reader_key, projection.reader_key), eq(IMKernelReaderProjectionTable.binding_key, projection.binding_key), eq(IMKernelReaderProjectionTable.local_revision, projection.local_revision))).returning().get()
  if (!refreshed) return yield* failure("reader_stale", "group-name")
  return refreshed
})
/** Original persisted obligations are custody, never new execution permission.
 * All intent writers call this inside their own transaction, so quota failure
 * rolls back both the binding/status change and its accounting. */
export const accountObligations = (tx: Tx, messageID: string) => Effect.gen(function* () {
  const row = yield* tx.select().from(IMKernelReaderMessageTable).where(and(
    eq(IMKernelReaderMessageTable.local_message_id, MessageID.make(messageID)), eq(IMKernelReaderMessageTable.owns_message, 1),
  )).get()
  if (!row) return
  const totals = yield* tx.get<{ records: number; bytes: number }>(sql`SELECT count(*) records, coalesce(sum(bytes),0) bytes
    FROM (SELECT ${IMMentionIntentBytes} bytes FROM ${IMMentionIntentTable}
      WHERE ${IMMentionIntentTable.message_id}=${messageID} LIMIT ${KernelReaderSchema.RECORD_LIMIT + 1})`)
  if (!totals || !Number.isSafeInteger(totals.records) || !Number.isSafeInteger(totals.bytes)
    || totals.records + 2 > KernelReaderSchema.RECORD_LIMIT || totals.bytes < totals.records * 1024
    || totals.bytes > KernelReaderSchema.BYTE_LIMIT) return yield* failure("reader_capacity", "obligation-meter")
  if (row.obligation_records === totals.records && row.obligation_bytes === totals.bytes) return
  const update = { ...row, obligation_records: totals.records, obligation_bytes: totals.bytes,
    accounted_records: 2 + totals.records, accounted_bytes: row.accounted_bytes + totals.bytes - row.obligation_bytes,
    local_revision: row.local_revision + 1, updated_at: Math.max(row.updated_at, Date.now()) }
  yield* reserve(tx, update.accounted_records - row.accounted_records, update.accounted_bytes - row.accounted_bytes)
  const changed = yield* tx.update(IMKernelReaderMessageTable).set(update).where(and(
    eq(IMKernelReaderMessageTable.reader_key, row.reader_key), eq(IMKernelReaderMessageTable.effect_key, row.effect_key),
    eq(IMKernelReaderMessageTable.local_revision, row.local_revision),
  )).returning({ effectKey: IMKernelReaderMessageTable.effect_key }).get()
  if (!changed) return yield* failure("reader_stale", "obligation-meter")
})
export const ensureScope = (runtime: Runtime) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  if (!engine.scopeKey || engine.source.orgID === null) return yield* failure("reader_scope_mismatch", "scope")
  const scopeKey = engine.scopeKey
  const scope = yield* engine.db.transaction((tx) => Effect.gen(function* () {
    const existing = yield* tx.select().from(IMKernelReaderMeterTable).where(eq(IMKernelReaderMeterTable.id, 1)).get()
    if (!existing) {
      const occupied = yield* tx.get<{ occupied: number }>(sql`SELECT EXISTS(SELECT 1 FROM im_kernel_reader_scope LIMIT 1) OR EXISTS(SELECT 1 FROM im_kernel_reader_projection LIMIT 1) OR EXISTS(SELECT 1 FROM im_kernel_reader_message LIMIT 1) OR EXISTS(SELECT 1 FROM im_kernel_reader_read_intent LIMIT 1) AS occupied`)
      if (occupied?.occupied) return yield* failure("reader_cleanup_required", "initialize")
      yield* tx.insert(IMKernelReaderMeterTable).values({ id: 1, version: 1, instance_id: randomUUID(), revision: 1, used_records: 1, used_bytes: 1024, created_at: Date.now(), updated_at: Date.now() }).run()
    }
    const meter = existing ?? (yield* tx.select().from(IMKernelReaderMeterTable).get())!
    const binding = KernelReaderSchema.encode(KernelReaderSchema.Binding, { version: 1, instanceID: meter.instance_id, workspaceID: engine.workspaceID, realm: engine.source.realm, appkey: engine.source.appkey, orgID: String(engine.source.orgID), userID: engine.source.senderID, scopeKey, ...(readerVersion(runtime) === 2 ? { readerVersion: 2 as const } : {}) }, 8192)
    const readerKey = hash(["deepagent.im.reader.v1", binding])
    const stored = yield* tx.select().from(IMKernelReaderScopeTable).where(and(eq(IMKernelReaderScopeTable.reader_key, readerKey), sql`length(CAST(${IMKernelReaderScopeTable.binding} AS BLOB)) <= 8192`, sql`length(CAST(${IMKernelReaderScopeTable.continuation} AS BLOB)) <= 8192`)).get()
    if (stored) {
      if (stored.binding !== binding || stored.binding_hash !== hash(binding)) return yield* failure("reader_mapping_conflict", "scope")
      return stored
    }
    const row = { reader_key: readerKey, meter_id: 1, version: 1, local_revision: 1, workspace_id: engine.workspaceID, scope_key: scopeKey, binding, binding_hash: hash(binding), phase: "idle" as const, completed_after: "0", window_after: null, window_upper: null, scan_cursor: null, scan_projection_key: null, page_token: null, fixed_limit: 32, continuation: KernelReaderSchema.encode(KernelReaderSchema.Continuation, { version: 1, projections: [] }, 8192), blocked_code: null, created_at: Date.now(), updated_at: Date.now(), accounted_records: 1, accounted_bytes: 0 }
    row.accounted_bytes = accounting(row, 8192)
    yield* reserve(tx, 1, row.accounted_bytes)
    yield* tx.insert(IMKernelReaderScopeTable).values(row).run()
    return row
  }), { behavior: "immediate" })
  engine.readerKey = scope.reader_key
  return scope
})
export const scope = (runtime: Runtime) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  if (!engine.readerKey) {
    const meter = yield* engine.db.select().from(IMKernelReaderMeterTable).where(eq(IMKernelReaderMeterTable.id, 1)).get()
    if (!meter || !engine.scopeKey || engine.source.orgID === null) return undefined
    const binding = KernelReaderSchema.encode(KernelReaderSchema.Binding, { version: 1, instanceID: meter.instance_id, workspaceID: engine.workspaceID, realm: engine.source.realm, appkey: engine.source.appkey, orgID: String(engine.source.orgID), userID: engine.source.senderID, scopeKey: engine.scopeKey, ...(readerVersion(runtime) === 2 ? { readerVersion: 2 as const } : {}) }, 8192)
    engine.readerKey = hash(["deepagent.im.reader.v1", binding])
  }
  const stored = yield* engine.db.select().from(IMKernelReaderScopeTable).where(and(eq(IMKernelReaderScopeTable.reader_key, engine.readerKey), sql`length(CAST(${IMKernelReaderScopeTable.binding} AS BLOB)) <= 8192`, sql`length(CAST(${IMKernelReaderScopeTable.continuation} AS BLOB)) <= 8192`)).get()
  if (stored) {
    const binding = KernelReaderSchema.decode(KernelReaderSchema.Binding, stored.binding, 8192)
    KernelReaderSchema.decode(KernelReaderSchema.Continuation, stored.continuation, 8192)
    if (stored.binding_hash !== hash(stored.binding) || hash(["deepagent.im.reader.v1", stored.binding]) !== stored.reader_key || binding.workspaceID !== engine.workspaceID || binding.scopeKey !== engine.scopeKey || binding.realm !== engine.source.realm || binding.appkey !== engine.source.appkey || binding.orgID !== String(engine.source.orgID) || binding.userID !== engine.source.senderID || (binding.readerVersion ?? 1) !== readerVersion(runtime)) return yield* failure("reader_scope_mismatch", "scope")
  }
  return stored
})
export const projections = (runtime: Runtime, groupIDs?: readonly string[]) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored) return []
  const rows = yield* engine.db.select().from(IMKernelReaderProjectionTable).where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), groupIDs ? inArray(IMKernelReaderProjectionTable.local_group_id, [...groupIDs]) : and(inArray(IMKernelReaderProjectionTable.visibility, ["visible", "pending"]), sql`${IMKernelReaderProjectionTable.local_group_id} IS NOT NULL`), sql`length(CAST(${IMKernelReaderProjectionTable.metadata} AS BLOB)) <= 4096`)).limit(groupIDs ? groupIDs.length : 3).all()
  if (!groupIDs && rows.length > 2 || groupIDs && groupIDs.length > 2) return yield* failure("reader_capacity", "output")
  for (const row of rows) {
    const metadata = KernelReaderSchema.decode(KernelReaderSchema.Metadata, row.metadata, 4096)
    if (row.metadata_hash !== hash(row.metadata) || row.visibility !== metadata.visibility || metadata.visibility !== "pending" && (row.projection_key !== metadata.projectionKey || row.server_revision !== metadata.revision || row.cursor !== metadata.cursor) || metadata.visibility === "visible" && (row.target_id !== metadata.targetId || row.conversation_type !== metadata.conversationType || row.live_unread !== metadata.liveUnread || row.stored_unread !== metadata.storedUnread || row.read_ordinal !== metadata.readOrdinal || row.admitted_ordinal !== metadata.admittedOrdinal || row.next_expiry_at !== metadata.nextExpiryAt)) return yield* failure("reader_mapping_conflict", "projection")
  }
  return rows
})
/** The sync continuation is bounded, but persistent projections are queried by their exact key. */
export const projection = (runtime: Runtime, projectionKey: string) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored) return undefined
  const row = yield* engine.db.select({ local_group_id: IMKernelReaderProjectionTable.local_group_id }).from(IMKernelReaderProjectionTable).where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), eq(IMKernelReaderProjectionTable.projection_key, projectionKey))).get()
  if (!row?.local_group_id) return undefined
  return (yield* projections(runtime, [row.local_group_id]))[0]
})
/** Original retained source identity. This read neither grants task authority
 * nor replaces the Host's fresh native membership and connection witness. */
export const taskSourceDescriptor = (runtime: Runtime, localMessageID: string) => Effect.gen(function* () {
  const messageID = Schema.decodeUnknownOption(MessageID)(localMessageID)
  if (Option.isNone(messageID)) return yield* failure("reader_unavailable", "task-source")
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored) return yield* failure("reader_unavailable", "task-source")
  const found = yield* engine.db.select({ row: IMKernelReaderMessageTable, message: MessageTable }).from(IMKernelReaderMessageTable)
    .innerJoin(MessageTable, eq(MessageTable.id, IMKernelReaderMessageTable.local_message_id))
    .where(and(eq(IMKernelReaderMessageTable.reader_key, stored.reader_key), eq(IMKernelReaderMessageTable.local_message_id, messageID.value),
      sql`length(CAST(${MessageTable.content} AS BLOB)) <= 65536`, sql`length(CAST(${IMKernelReaderMessageTable.metadata} AS BLOB)) <= 2048`)).get()
  if (!found || found.row.storage_state !== "present" || found.row.owns_message !== 1 || found.message.deleted_at !== null || found.message.sender_type !== "user" || found.message.type !== "text" || found.message.reply_to_id !== null || found.message.kernel_msg_id !== null || found.message.sender_id !== found.row.sender_id || found.message.created_at !== found.row.message_time)
    return yield* failure("reader_unavailable", "task-source")
  const row = found.row
  const visible = yield* projection(runtime, row.projection_key)
  const metadata = yield* Effect.try({ try: () => KernelReaderSchema.decode(SchemaMessageMetadata, row.metadata, 2048), catch: () => failure("reader_mapping_conflict", "task-source") })
  if (!visible || visible.visibility !== "visible" || visible.binding_key !== row.binding_key || visible.local_group_id !== found.message.group_id || visible.conversation_type !== row.conversation_type || visible.target_id !== row.target_id || !visible.server_revision || metadata.isSend || metadata.messageType !== undefined && metadata.messageType !== "jg:text" || metadata.firstSeen?.origin !== "kernel_live" || metadata.firstSeen.sourceHash !== hash(engine.source) || metadata.firstSeen.receiverID !== engine.source.senderID || metadata.firstSeen.sourceExpiresAt > row.expires_at || Math.min(row.expires_at, metadata.firstSeen.sourceExpiresAt) <= Date.now() || bodyHash(found.message.content) !== row.body_hash || KernelReaderSchema.bytes(found.message.content) !== row.body_bytes || row.immutable_hash !== hash({ reader_key: row.reader_key, effect_key: row.effect_key, binding_key: row.binding_key, projection_key: row.projection_key, message_id: row.message_id, sequence: row.sequence, delivery_cursor: row.delivery_cursor, message_time: row.message_time, expires_at: row.expires_at, sender_id: row.sender_id, target_id: row.target_id, conversation_type: row.conversation_type, body_hash: row.body_hash, metadata: row.metadata }))
    return yield* failure("reader_unavailable", "task-source")
  const binding = KernelReaderSchema.decode(KernelReaderSchema.Binding, stored.binding, 8192)
  return { workspaceID: engine.workspaceID, localUserID: engine.userID, readerKey: row.reader_key, bindingKey: row.binding_key,
    scopeKey: stored.scope_key, projectionKey: row.projection_key, currentProjectionRevision: visible.server_revision,
    localProjectionRevision: visible.local_revision, realm: binding.realm, appkey: binding.appkey, orgID: binding.orgID,
    receiverID: binding.userID, localGroupID: found.message.group_id, localMessageID: found.message.id,
    effectKey: row.effect_key, nativeMessageID: row.message_id, sequence: row.sequence, deliveryCursor: row.delivery_cursor,
    messageTime: row.message_time, nativeExpiresAt: row.expires_at, senderID: row.sender_id,
    conversationType: KernelReaderSchema.decode(KernelReaderSchema.Visible, visible.metadata, 4096).conversationType,
    conversationID: row.target_id, rawContent: found.message.content, immutableHash: row.immutable_hash, firstSeen: metadata.firstSeen }
})
export type TaskSourceDescriptor = Effect.Success<ReturnType<typeof taskSourceDescriptor>>
export const pageIdentity = (runtime: Runtime, input: { workspaceID: string; userID: string }) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  if (engine.workspaceID !== input.workspaceID || engine.userID !== input.userID) return yield* failure("reader_scope_mismatch", "group-page")
  const stored = yield* scope(runtime)
  if (!stored) return yield* failure("reader_unavailable", "group-page")
  return { readerKey: stored.reader_key, stamp: hash([engine.workspaceID, engine.userID, engine.source, runtime.incarnation, runtime.displayEpoch, stored.reader_key]) }
})
export const messageGroup = (db: Db, input: { messageID: string; workspaceID: string; userID: string }) => db.select({ groupID: MessageTable.group_id }).from(MessageTable).innerJoin(GroupTable, eq(GroupTable.id, MessageTable.group_id)).innerJoin(MemberTable, and(eq(MemberTable.group_id, GroupTable.id), eq(MemberTable.member_id, input.userID), eq(MemberTable.member_type, "user"))).where(and(eq(MessageTable.id, MessageID.make(input.messageID)), eq(GroupTable.workspace_id, input.workspaceID), isNull(GroupTable.deleted_at), isNull(MessageTable.deleted_at))).get()
export const pending = (runtime: Runtime, input: { conversationType: 1 | 2; conversationID: string; name: string }) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const verified = yield* engine.inspect(input)
  const stored = yield* ensureScope(runtime)
  const bindingKey = hash(["deepagent.im.reader.mapping.v1", stored.reader_key, input.conversationType, input.conversationID])
  const groupID = `img_kr_${bindingKey}`
  return yield* engine.db.transaction((tx) => Effect.gen(function* () {
    yield* current(runtime)
    const original = yield* tx.select().from(IMKernelReaderProjectionTable).where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), eq(IMKernelReaderProjectionTable.binding_key, bindingKey))).get()
    const existing = original?.local_group_id && original.visibility !== "revoked" ? yield* refreshGroupName(tx, engine, original, verified.name) : original
    if (existing?.local_group_id) {
      if (existing.visibility === "revoked") return yield* failure("reader_unavailable", "pending")
      if (existing.visibility === "pending") {
        const previous = KernelReaderSchema.decode(KernelReaderSchema.Pending, existing.metadata, 4096)
        const metadata = KernelReaderSchema.encode(KernelReaderSchema.Pending, { ...previous, sourceHash: hash(engine.source), name: verified.name }, 4096)
        if (metadata !== existing.metadata) {
          const update = { ...existing, metadata, metadata_hash: hash(metadata), local_revision: existing.local_revision + 1, updated_at: Date.now() }
          update.accounted_bytes = accounting(update) + update.owned_group_bytes
          yield* reserve(tx, 0, update.accounted_bytes - existing.accounted_bytes)
          const changed = yield* tx.update(IMKernelReaderProjectionTable).set(update).where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), eq(IMKernelReaderProjectionTable.binding_key, bindingKey), eq(IMKernelReaderProjectionTable.local_revision, existing.local_revision))).returning().get()
          if (!changed) return yield* failure("reader_stale", "pending")
        }
      }
      return existing.local_group_id
    }
    if (existing) return yield* failure("reader_mapping_conflict", "pending")
    const metadata = KernelReaderSchema.encode(KernelReaderSchema.Pending, { version: 1, visibility: "pending", sourceHash: hash(engine.source), conversationType: input.conversationType, targetId: input.conversationID, name: verified.name }, 4096)
    const group = { id: GroupID.make(groupID), workspace_id: engine.workspaceID, project_id: null, type: input.conversationType === 1 ? "direct" as const : "project" as const, name: verified.name, created_by: engine.userID, kernel_conv_id: `kr1:${bindingKey}`, created_at: Date.now(), updated_at: Date.now(), deleted_at: null }
    const member = { group_id: group.id, member_id: engine.userID, member_type: "user" as const, role: "owner" as const, last_read_at: null, joined_at: group.created_at }
    const row = { reader_key: stored.reader_key, binding_key: bindingKey, projection_key: null, conversation_type: input.conversationType, target_id: input.conversationID, version: 1, local_revision: 1, visibility: "pending" as const, server_revision: null, cursor: null, local_group_id: groupID, metadata, metadata_hash: hash(metadata), read_ordinal: null, admitted_ordinal: null, live_unread: null, stored_unread: null, next_expiry_at: null, last_server_now: 0, observed_at: Date.now(), newer_after: "0", older_before: null, scan_revision: null, history_complete: 0, owned_group_bytes: accounting(group) + accounting(member), created_at: group.created_at, updated_at: group.created_at, accounted_records: 3, accounted_bytes: 0 }
    row.accounted_bytes = accounting(row) + row.owned_group_bytes
    yield* reserve(tx, row.accounted_records, row.accounted_bytes)
    yield* tx.insert(GroupTable).values(group).run()
    yield* tx.insert(MemberTable).values(member).run()
    yield* tx.insert(IMKernelReaderProjectionTable).values(row).run()
    return groupID
  }), { behavior: "immediate" })
})

/** Explicit metadata refresh for one already bound local group. It neither
 * discovers a remote target nor advances the delivery scan or message cursor. */
export const refreshGroup = (runtime: Runtime, groupID: string) => Effect.gen(function* () {
  if (!Schema.is(KernelReaderSchema.text(512))(groupID)) return yield* failure("reader_scope_mismatch", "group-name")
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored) return yield* failure("reader_required", "group-name")
  const original = yield* engine.db.select().from(IMKernelReaderProjectionTable).where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), eq(IMKernelReaderProjectionTable.local_group_id, groupID))).get()
  if (!original || original.visibility === "revoked" || !original.target_id || (original.conversation_type !== 1 && original.conversation_type !== 2)) return yield* failure("reader_required", "group-name")
  const member = yield* engine.db.select().from(MemberTable).where(and(eq(MemberTable.group_id, GroupID.make(groupID)), eq(MemberTable.member_id, engine.userID), eq(MemberTable.member_type, "user"))).get()
  if (!member) return yield* failure("reader_scope_mismatch", "group-name")
  const verified = yield* engine.inspect({ conversationType: original.conversation_type, conversationID: original.target_id })
  yield* current(runtime)
  return yield* engine.db.transaction((tx) => Effect.gen(function* () {
    yield* current(runtime)
    const freshScope = yield* tx.select().from(IMKernelReaderScopeTable).where(eq(IMKernelReaderScopeTable.reader_key, stored.reader_key)).get()
    const fresh = yield* tx.select().from(IMKernelReaderProjectionTable).where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), eq(IMKernelReaderProjectionTable.binding_key, original.binding_key))).get()
    if (!freshScope || freshScope.scope_key !== stored.scope_key || freshScope.binding !== stored.binding || !fresh || fresh.local_revision !== original.local_revision || fresh.local_group_id !== groupID || fresh.visibility !== original.visibility || fresh.conversation_type !== original.conversation_type || fresh.target_id !== original.target_id) return yield* failure("reader_stale", "group-name")
    if (!(yield* tx.select().from(MemberTable).where(and(eq(MemberTable.group_id, GroupID.make(groupID)), eq(MemberTable.member_id, engine.userID), eq(MemberTable.member_type, "user"))).get())) return yield* failure("reader_scope_mismatch", "group-name")
    const updated = yield* refreshGroupName(tx, engine, fresh, verified.name)
    // An explicit authenticated refresh also revalidates an empty mapping after
    // credential rotation. Public reads keep rejecting its previous source proof.
    if (updated.visibility === "pending") {
      const previous = KernelReaderSchema.decode(KernelReaderSchema.Pending, updated.metadata, 4096)
      const metadata = KernelReaderSchema.encode(KernelReaderSchema.Pending, { ...previous, sourceHash: hash(engine.source), name: verified.name }, 4096)
      if (metadata !== updated.metadata) {
        const update = { ...updated, metadata, metadata_hash: hash(metadata), local_revision: updated.local_revision + 1, updated_at: Date.now() }
        update.accounted_bytes = accounting(update) + update.owned_group_bytes
        yield* reserve(tx, 0, update.accounted_bytes - updated.accounted_bytes)
        const changed = yield* tx.update(IMKernelReaderProjectionTable).set(update).where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), eq(IMKernelReaderProjectionTable.binding_key, updated.binding_key), eq(IMKernelReaderProjectionTable.local_revision, updated.local_revision))).returning().get()
        if (!changed) return yield* failure("reader_stale", "group-name")
        return true
      }
    }
    return updated.local_revision !== fresh.local_revision
  }), { behavior: "immediate" })
})

/** Explicit reconnect recovery enumerates only this account's empty mappings.
 * It reads no bodies and each selected ID still passes refreshGroup's fresh
 * authenticated inspection, membership and transaction revision checks. */
export const refreshPending = (runtime: Runtime) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored) return []
  const state = { after: "", visited: 0, changed: [] as string[] }
  for (const round of Array.from({ length: Math.ceil(KernelReaderSchema.RECORD_LIMIT / KernelReaderSchema.PAGE_LIMIT) + 1 }, (_, index) => index)) {
    yield* current(runtime)
    const rows = yield* engine.db.select({ bindingKey: IMKernelReaderProjectionTable.binding_key, groupID: GroupTable.id })
      .from(IMKernelReaderProjectionTable)
      .innerJoin(GroupTable, and(eq(GroupTable.id, IMKernelReaderProjectionTable.local_group_id), eq(GroupTable.workspace_id, engine.workspaceID), isNull(GroupTable.deleted_at)))
      .innerJoin(MemberTable, and(eq(MemberTable.group_id, GroupTable.id), eq(MemberTable.member_id, engine.userID), eq(MemberTable.member_type, "user")))
      .where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), eq(IMKernelReaderProjectionTable.visibility, "pending"), sql`${IMKernelReaderProjectionTable.binding_key} > ${state.after}`))
      .orderBy(IMKernelReaderProjectionTable.binding_key).limit(KernelReaderSchema.PAGE_LIMIT).all()
    if (!rows.length) return state.changed
    if (round === Math.ceil(KernelReaderSchema.RECORD_LIMIT / KernelReaderSchema.PAGE_LIMIT) || state.visited + rows.length > KernelReaderSchema.RECORD_LIMIT) return yield* failure("reader_cleanup_required", "pending-refresh")
    const changed = yield* Effect.forEach(rows, (row) => refreshGroup(runtime, row.groupID).pipe(Effect.map((updated) => updated ? row.groupID : undefined)), { concurrency: 2 })
    state.changed.push(...changed.filter((groupID): groupID is NonNullable<typeof groupID> => groupID !== undefined))
    state.visited += rows.length
    state.after = rows[rows.length - 1]!.bindingKey
    yield* Effect.yieldNow
  }
  return state.changed
})

/** Read-only current permission recheck. No ensure, poll, repair or durable writes. */
export const prepareOutput = <A, E, R>(runtime: Runtime, input: { workspaceID: string; userID: string; groupIDs?: readonly string[] }, effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const consumed = { value: false }
  const consume = <PreparedE, PreparedR>(prepared: Effect.Effect<A, PreparedE, PreparedR>) => Effect.suspend<A, PreparedE | KernelReaderSchema.Error, PreparedR>(() => {
    if (consumed.value) return failure("reader_stale", "output-consumed")
    consumed.value = true
    return prepared
  })
  const started = performance.now()
  const observed = yield* current(runtime).pipe(Effect.option)
  if (Option.isNone(observed)) return consume(effect)
  const engine = observed.value
  if (engine.workspaceID !== input.workspaceID || engine.userID !== input.userID) return consume(effect)
  const rows = yield* projections(runtime, input.groupIDs)
  const frame: Frame = { runtime, db: engine.db, workspaceID: input.workspaceID, userID: input.userID, readerKey: engine.readerKey, started, projections: new Map(), active: true }
  const observations: { index: number; visibility: "visible" | "pending" | "revoked"; phase: "observe" | "refresh"; flightMs: number; settledAt: number; deadline: number }[] = []
  const timing = { consumerStarted: 0, refreshSelectedCount: 0, stage: "prepare" as "prepare" | "consume_check" | "consume" | "postcheck" }
  const diagnostic = (error: unknown) => Effect.sync(() => {
    if (!(error instanceof KernelReaderSchema.Error) || error.code !== "reader_stale" || !["output-deadline", "output-revision"].includes(error.operation)) return
    for (const observation of observations.slice(0, 4)) {
      const activeWindow = frame.projections.get(rows[observation.index]?.local_group_id ?? "")?.deadline === observation.deadline
      Log.Default.debug("IM output proof rejected", { index: observation.index, visibility: observation.visibility, phase: observation.phase, flightMs: observation.flightMs, proofAgeMs: Math.max(0, Math.floor(performance.now() - observation.settledAt)), remainingMs: Math.floor(observation.deadline - performance.now()), actualRowCount: rows.length, refreshSelectedCount: timing.refreshSelectedCount, activeWindow, expiredAtFailure: activeWindow && performance.now() >= observation.deadline, consumerMs: timing.consumerStarted ? Math.max(0, Math.floor(performance.now() - timing.consumerStarted)) : 0, outputElapsedMs: Math.max(0, Math.floor(performance.now() - started)), failureStage: timing.stage, operation: error.operation })
    }
  }).pipe(Effect.catchCause(() => Effect.void))
  const observe = (row: Projection, index: number, phase: "observe" | "refresh") => Effect.gen(function* () {
    yield* current(runtime)
    if (!row.local_group_id || row.visibility === "revoked") return
    const started = performance.now()
    if (row.visibility === "pending") {
      if (row.conversation_type !== 1 && row.conversation_type !== 2 || !row.target_id) return yield* failure("reader_mapping_conflict", "pending-output")
      const metadata = KernelReaderSchema.decode(KernelReaderSchema.Pending, row.metadata, 4096)
      if (metadata.sourceHash !== hash(engine.source)) return yield* failure("reader_scope_mismatch", "pending-output")
      yield* engine.inspect({ conversationType: row.conversation_type, conversationID: row.target_id })
      const returned = performance.now()
      const deadline = returned + outputProofWindowMs
      frame.projections.set(row.local_group_id, { row, deadline, serverNow: 0, started })
      if (observations.length < 4) observations.push({ index, visibility: row.visibility, phase, flightMs: Math.max(0, Math.floor(returned - started)), settledAt: returned, deadline })
      return
    }
    if (!engine.scopeKey || !row.projection_key || !row.server_revision) return yield* failure("reader_mapping_conflict", "output")
    const cut = yield* engine.readCut({ version: readerVersion(runtime), scopeKey: engine.scopeKey, projectionKey: row.projection_key, projectionRevision: row.server_revision })
    if (cut.version !== readerVersion(runtime) || cut.scopeKey !== engine.scopeKey || cut.projectionKey !== row.projection_key || cut.projectionRevision !== row.server_revision || cut.serverNow < row.last_server_now) return yield* failure("reader_stale", "output-clock")
    // The local consumption window starts after this current authenticated cut
    // settles. Message expiry still conservatively includes the RPC's full flight.
    const deadline = Math.min(performance.now() + outputProofWindowMs, !row.next_expiry_at ? Infinity : started + row.next_expiry_at - cut.serverNow)
    const returned = performance.now()
    if (observations.length < 4) observations.push({ index, visibility: "visible", phase, flightMs: Math.max(0, Math.floor(returned - started)), settledAt: returned, deadline })
    if (performance.now() >= deadline) return yield* failure("reader_stale", "output-deadline")
    frame.projections.set(row.local_group_id, { row, deadline, serverNow: cut.serverNow, started, cut })
  })
  const guarded = Effect.gen(function* () {
    yield* Effect.forEach(rows, (row, index) => observe(row, index, "observe"), { concurrency: 2 })
    // A fast proof can age while another authenticated row is still settling.
    // Take new evidence once, never renew the old window or repeat output effects.
    const expired = Array.from(frame.projections.values()).filter((item) => performance.now() >= item.deadline)
    timing.refreshSelectedCount = expired.length
    if (expired.length > 2) return yield* failure("reader_stale", "output-deadline")
    yield* Effect.forEach(expired, (item) => observe(item.row, rows.indexOf(item.row), "refresh"), { concurrency: 2 })
    yield* current(runtime)
    // Preparation returns an unevaluated effect so callers can recover only a
    // failed current cut. No business operation or Output witness exists yet.
    return consume(Effect.suspend(() => {
      const witness = {}
      outputs.set(witness, frame)
      return Effect.gen(function* () {
        timing.stage = "consume_check"
        // Preparation may have waited before consumption. Current ownership and
        // the original proof deadline must still hold before any business effect.
        yield* current(runtime)
        yield* assertOutput(engine.db)
        timing.consumerStarted = performance.now()
        timing.stage = "consume"
        return yield* effect
      }).pipe(Effect.tap(() => { timing.stage = "postcheck"; return assertOutput(engine.db) }), Effect.tapError(diagnostic), Effect.provideService(Output, witness), Effect.ensuring(Effect.sync(() => { frame.active = false; outputs.delete(witness) })))
    }))
  })
  return yield* guarded.pipe(Effect.tapError(diagnostic))
})
export const withOutput = <A, E, R>(runtime: Runtime, input: { workspaceID: string; userID: string; groupIDs?: readonly string[] }, effect: Effect.Effect<A, E, R>) => Effect.flatten(prepareOutput(runtime, input, effect))

const output = (db: Reader) => Effect.gen(function* () { const witness = yield* Output; const frame = witness ? outputs.get(witness) : undefined; return frame?.active && frame.db === db ? frame : undefined })
export const assertOutput = (db: Reader) => Effect.gen(function* () {
  const frame = yield* output(db)
  if (!frame) return
  yield* current(frame.runtime)
  if (frame.emptyProofDeadline !== undefined) {
    const stored = yield* scope(frame.runtime)
    if (!stored || stored.reader_key !== frame.readerKey) return yield* failure("reader_scope_mismatch", "group-page")
    if (performance.now() >= frame.emptyProofDeadline) return yield* failure("reader_stale", "output-deadline")
  }
  for (const item of frame.projections.values()) {
    if (performance.now() >= item.deadline) return yield* failure("reader_stale", "output-deadline")
    const row = yield* db.select({ local_revision: IMKernelReaderProjectionTable.local_revision }).from(IMKernelReaderProjectionTable).where(and(eq(IMKernelReaderProjectionTable.reader_key, item.row.reader_key), eq(IMKernelReaderProjectionTable.binding_key, item.row.binding_key))).get()
    if (row?.local_revision !== item.row.local_revision) return yield* failure("reader_stale", "output-revision")
  }
})
export const protectedGroup = (groupID: string) => sql`EXISTS(SELECT 1 FROM im_groups g WHERE g.id = ${groupID} AND g.kernel_conv_id IS NOT NULL) OR EXISTS(SELECT 1 FROM im_messages m WHERE m.group_id = ${groupID} AND (m.kernel_msg_id IS NOT NULL OR json_extract(m.metadata, '$.type') = 'kernel_sync')) OR EXISTS(SELECT 1 FROM im_kernel_delivery d JOIN im_messages m ON m.id = d.message_id WHERE m.group_id = ${groupID}) OR EXISTS(SELECT 1 FROM im_kernel_reader_projection p WHERE p.local_group_id = ${groupID})`
export const ordinaryGroup = sql`NOT (EXISTS(SELECT 1 FROM im_groups g WHERE g.id = ${GroupTable.id} AND g.kernel_conv_id IS NOT NULL) OR EXISTS(SELECT 1 FROM im_messages m WHERE m.group_id = ${GroupTable.id} AND (m.kernel_msg_id IS NOT NULL OR json_extract(m.metadata, '$.type') = 'kernel_sync')) OR EXISTS(SELECT 1 FROM im_kernel_delivery d JOIN im_messages m ON m.id = d.message_id WHERE m.group_id = ${GroupTable.id}) OR EXISTS(SELECT 1 FROM im_kernel_reader_projection p WHERE p.local_group_id = ${GroupTable.id}))`
export const gateGroup = (db: Db, groupID: string) => Effect.gen(function* () {
  const protectedRow = yield* db.get<{ protected: number }>(sql`SELECT (${protectedGroup(groupID)}) AS protected`)
  if (!protectedRow?.protected) return undefined
  const frame = yield* output(db)
  const item = frame?.projections.get(groupID)
  if (!frame || !item) return yield* failure("reader_legacy_unverified", "group")
  yield* assertOutput(db)
  const summary = yield* readSummary(db, groupID)
  return { mode: "protected" as const, state: item.row.visibility === "pending" ? "pending" as const : "ready" as const, liveUnread: item.cut?.liveUnread ?? item.row.live_unread, ...(item.row.conversation_type === 1 && item.row.target_id ? { peerID: item.row.target_id } : {}), ...(item.cut ? { admittedOrdinal: item.cut.targetAdmittedOrdinal } : {}), ...summary }
})
/** A current body-free locator. A fresh cut never rewrites the original action's phase. */
const readSummary = (db: Db, groupID: string) => Effect.gen(function* () {
  const frame = yield* output(db)
  const item = frame?.projections.get(groupID)
  if (!frame || !item?.cut || !item.row.projection_key) return {}
  const fields = { actionID: IMKernelReaderReadIntentTable.original_action_id, cutID: IMKernelReaderReadIntentTable.action_id, phase: IMKernelReaderReadIntentTable.phase, cutIndex: IMKernelReaderReadIntentTable.cut_index, targetAdmitted: IMKernelReaderReadIntentTable.original_target_admitted, throughOrdinal: IMKernelReaderReadIntentTable.through_ordinal }
  const within = and(eq(IMKernelReaderReadIntentTable.reader_key, item.row.reader_key), eq(IMKernelReaderReadIntentTable.binding_key, item.row.binding_key), eq(IMKernelReaderReadIntentTable.projection_key, item.row.projection_key))
  const root = yield* db.select({ actionID: IMKernelReaderReadIntentTable.action_id }).from(IMKernelReaderReadIntentTable).where(and(within, eq(IMKernelReaderReadIntentTable.cut_index, 0))).orderBy(desc(IMKernelReaderReadIntentTable.created_at), desc(IMKernelReaderReadIntentTable.action_id)).limit(1).get()
  const row = root ? yield* db.select(fields).from(IMKernelReaderReadIntentTable).where(and(within, eq(IMKernelReaderReadIntentTable.original_action_id, root.actionID))).orderBy(desc(IMKernelReaderReadIntentTable.cut_index)).limit(1).get() : undefined
  const original = alias(IMKernelReaderReadIntentTable, "im_reader_action_roots")
  const unknown = yield* db.select(fields).from(IMKernelReaderReadIntentTable).innerJoin(original, and(eq(original.action_id, IMKernelReaderReadIntentTable.original_action_id), eq(original.reader_key, IMKernelReaderReadIntentTable.reader_key), eq(original.binding_key, IMKernelReaderReadIntentTable.binding_key), eq(original.projection_key, IMKernelReaderReadIntentTable.projection_key), eq(original.cut_index, 0))).where(and(within, eq(IMKernelReaderReadIntentTable.phase, "unknown"))).orderBy(original.created_at, original.action_id, IMKernelReaderReadIntentTable.cut_index, IMKernelReaderReadIntentTable.action_id).limit(9).all()
  if (unknown.length > 8) return yield* failure("reader_cleanup_required", "read-summary")
  return yield* Effect.try({ try: () => {
    const decode = (value: NonNullable<typeof row>) => Schema.decodeUnknownSync(KernelReaderSchema.ReadActionSummary)({ ...value, targetReached: KernelReaderSchema.compareDecimal(item.cut!.readOrdinal, value.targetAdmitted) >= 0 }, { onExcessProperty: "error" })
    return { ...(row ? { readAction: decode(row) } : {}), ...(unknown.length ? { unresolvedReadActions: unknown.map(decode) } : {}) }
  }, catch: () => failure("reader_cleanup_required", "read-summary") })
})
export const uncoveredGroupPredicate = (db: Db) => Effect.gen(function* () {
  const frame = yield* output(db)
  return frame?.projections.size ? sql`NOT (${ordinaryGroup}) AND ${GroupTable.id} NOT IN (${sql.join([...frame.projections.keys()].map((id) => sql`${id}`), sql`, `)})` : sql`NOT (${ordinaryGroup})`
})
export const groupPredicate = (db: Db) => Effect.gen(function* () { const frame = yield* output(db); return frame?.projections.size ? sql`(${ordinaryGroup}) OR ${inArray(GroupTable.id, [...frame.projections.keys()].map((id) => GroupID.make(id)))}` : ordinaryGroup })
export const messagePredicate = (db: Db) => Effect.gen(function* () {
  const frame = yield* output(db)
  const ordinary = sql`NOT (${protectedGroup(sql`${MessageTable.group_id}` as unknown as string)})`
  if (!frame?.projections.size) return ordinary
  const ids = [...frame.projections.keys()].map((id) => GroupID.make(id))
  return sql`(${ordinary}) OR (${inArray(MessageTable.group_id, ids)} AND (EXISTS(SELECT 1 FROM im_kernel_reader_message r JOIN im_kernel_reader_projection p ON p.reader_key = r.reader_key AND p.binding_key = r.binding_key AND p.projection_key = r.projection_key WHERE r.local_message_id = ${MessageTable.id} AND p.local_group_id = ${MessageTable.group_id} AND p.visibility = 'visible' AND r.storage_state = 'present' AND (r.owns_message = 1 OR EXISTS(SELECT 1 FROM im_kernel_delivery owned WHERE owned.message_id = r.local_message_id AND json_extract(owned.binding, '$.source.credentialFingerprint') = ${engines.get(frame.runtime)!.source.credentialFingerprint})) AND r.expires_at > ${Math.max(...[...frame.projections.values()].map((item) => item.serverNow + Math.max(0, performance.now() - item.started)))}) OR EXISTS(SELECT 1 FROM im_kernel_delivery d WHERE d.message_id = ${MessageTable.id} AND json_extract(d.binding, '$.source.credentialFingerprint') = ${engines.get(frame.runtime)!.source.credentialFingerprint} AND json_extract(d.binding, '$.expiresAt') > ${Math.max(...[...frame.projections.values()].map((item) => item.serverNow + Math.max(0, performance.now() - item.started)))})))`
})
export const verifyMessage = (db: Db, message: typeof MessageTable.$inferSelect) => Effect.gen(function* () {
  const row = yield* db.select().from(IMKernelReaderMessageTable).where(eq(IMKernelReaderMessageTable.local_message_id, message.id)).get()
  const frame = yield* output(db)
  const item = frame?.projections.get(message.group_id)
  if (!row) {
    if (!item) return
    const receipt = yield* KernelDelivery.read(db, message.id)
    const source = frame ? engines.get(frame.runtime)?.source : undefined
    if (!receipt || !source || receipt.binding_hash !== hash(receipt.binding) || receipt.binding.groupID !== message.group_id || receipt.binding.workspaceID !== frame?.workspaceID || hash(receipt.binding.source) !== hash(source) || !KernelDelivery.wireMessage(receipt.binding, message) || receipt.binding.expiresAt <= item.serverNow + performance.now() - item.started) return yield* failure("reader_mapping_conflict", "local-authored")
    return
  }
  // Keep the original fixed projection: protocol metadata is part of the admitted wire identity.
  if (row.immutable_hash !== hash({ reader_key: row.reader_key, effect_key: row.effect_key, binding_key: row.binding_key,
    projection_key: row.projection_key, message_id: row.message_id, sequence: row.sequence, delivery_cursor: row.delivery_cursor,
    message_time: row.message_time, expires_at: row.expires_at, sender_id: row.sender_id, target_id: row.target_id,
    conversation_type: row.conversation_type, body_hash: row.body_hash, metadata: row.metadata }))
    return yield* failure("reader_mapping_conflict", "message-identity")
  const receipt = row.owns_message ? undefined : yield* KernelDelivery.read(db, message.id)
  const wire = receipt ? KernelDelivery.wireMessage(receipt.binding, message) : undefined
  const body = row.owns_message ? message.content : wire?.content
  if (body === undefined || !item || row.reader_key !== item.row.reader_key || row.projection_key !== item.row.projection_key || bodyHash(body) !== row.body_hash || KernelReaderSchema.bytes(body) !== row.body_bytes || row.expires_at <= item.serverNow + performance.now() - item.started) return yield* failure("reader_stale", "message")
  if (!row.owns_message) {
    const metadata = KernelReaderSchema.decode(SchemaMessageMetadata, row.metadata, 2048)
    const source = frame ? engines.get(frame.runtime)?.source : undefined
    if (!receipt || !source || wire?.messageType !== (metadata.messageType ?? "jg:text") || receipt.state !== "acknowledged" || receipt.kernel_message_id !== row.message_id || receipt.binding.expiresAt !== row.expires_at || receipt.binding.groupID !== message.group_id || hash(receipt.binding.source) !== hash(source) || !KernelDelivery.wireMessage(receipt.binding, message)) return yield* failure("reader_mapping_conflict", "sender-receipt")
  }
})
/** The durable hash covers untouched wire bytes; only this checked projection exposes
 * plain DAC text and remote object descriptors. Ordinary message JSON grants nothing. */
export const displayMessage = (db: Db, message: typeof MessageTable.$inferSelect) => Effect.gen(function* () {
  const row = yield* db.select({ owns_message: IMKernelReaderMessageTable.owns_message, metadata: IMKernelReaderMessageTable.metadata, expires_at: IMKernelReaderMessageTable.expires_at })
    .from(IMKernelReaderMessageTable).where(and(eq(IMKernelReaderMessageTable.local_message_id, message.id), sql`length(CAST(${IMKernelReaderMessageTable.metadata} AS BLOB)) <= 2048`)).get()
  if (!row?.owns_message) {
    const receipt = yield* KernelDelivery.read(db, message.id)
    if (receipt?.binding.version !== 2) return { content: message.content }
    yield* verifyMessage(db, message)
    return KernelReaderSchema.wireContent(receipt.binding.wireContent, receipt.binding.messageType, receipt.binding.expiresAt)
  }
  yield* verifyMessage(db, message)
  return yield* Effect.try({ try: () => {
    const metadata = KernelReaderSchema.decode(SchemaMessageMetadata, row.metadata, 2048)
    return KernelReaderSchema.wireContent(message.content, metadata.messageType ?? "jg:text", row.expires_at)
  }, catch: () => failure("reader_mapping_conflict", "body") })
})
export const displayContent = (db: Db, message: typeof MessageTable.$inferSelect) => displayMessage(db, message).pipe(Effect.map((value) => value.content))
export const searchState = (db: Db, groupIDs: readonly string[]) => Effect.gen(function* () {
  const frame = yield* output(db)
  const visible = frame ? [...frame.projections.values()].filter((item) => item.row.visibility === "visible" && item.row.local_group_id !== null && groupIDs.includes(item.row.local_group_id)) : []
  const earliest = visible.sort((a, b) => (a.row.next_expiry_at || Infinity) - a.serverNow + a.started - ((b.row.next_expiry_at || Infinity) - b.serverNow + b.started))[0]
  if (!frame || !earliest) return undefined
  return { state: "partial" as const, displayEpoch: frame.runtime.displayEpoch, projectionRevision: earliest.row.server_revision!, validatedServerNow: earliest.serverNow, nextExpiryAt: earliest.row.next_expiry_at || null }
})
export const pageState = (db: Db, groupID: string) => Effect.gen(function* () { const frame = yield* output(db); const item = frame?.projections.get(groupID); if (!frame || !item || item.row.visibility !== "visible") return undefined; return { state: item.row.history_complete ? "ready" as const : "partial" as const, displayEpoch: frame.runtime.displayEpoch, projectionRevision: item.row.server_revision!, validatedServerNow: item.serverNow, nextExpiryAt: item.row.next_expiry_at || null } })
export const groupPageState = (db: Db) => Effect.gen(function* () {
  const frame = yield* output(db)
  const items = frame ? [...frame.projections.values()] : []
  if (!frame) return undefined
  // An empty page has no projection cut. Its proof belongs to this original
  // current scope and short-lived output frame, never persisted page metadata.
  if (!items.length) frame.emptyProofDeadline = frame.started + outputProofWindowMs
  yield* assertOutput(db)
  const proofWindowMs = Math.floor(items.length ? Math.min(...items.map((item) => item.deadline)) - performance.now() : frame.emptyProofDeadline! - frame.started)
  if (proofWindowMs < 1) return yield* failure("reader_stale", "group-page")
  const visible = items.filter((item) => item.cut).sort((a, b) => (a.row.next_expiry_at || Infinity) - a.serverNow + a.started - ((b.row.next_expiry_at || Infinity) - b.serverNow + b.started))[0]
  return { displayEpoch: frame.runtime.displayEpoch, proofWindowMs, ...(visible ? { validatedServerNow: visible.serverNow } : {}), nextExpiryAt: visible?.row.next_expiry_at || null }
})
export const senderConversation = (db: Reader, groupID: string, source: KernelDeliverySchema.Source) => Effect.gen(function* () {
  const row = yield* db.select({ projection: IMKernelReaderProjectionTable, scope: IMKernelReaderScopeTable }).from(IMKernelReaderProjectionTable).innerJoin(IMKernelReaderScopeTable, eq(IMKernelReaderScopeTable.reader_key, IMKernelReaderProjectionTable.reader_key)).where(eq(IMKernelReaderProjectionTable.local_group_id, groupID)).get()
  if (!row || row.projection.visibility === "revoked" || !row.projection.target_id || (row.projection.conversation_type !== 1 && row.projection.conversation_type !== 2)) return undefined
  const binding = KernelReaderSchema.decode(KernelReaderSchema.Binding, row.scope.binding, 8192)
  if (binding.workspaceID !== row.scope.workspace_id || binding.realm !== source.realm || binding.appkey !== source.appkey || binding.orgID !== String(source.orgID) || binding.userID !== source.senderID) return undefined
  return { conversationType: row.projection.conversation_type as 1 | 2, conversationID: row.projection.target_id }
})

export type ChangesPage = { version: 1 | 2; scopeKey: string; after: string; upper: string; scanCursor: string; scanProjectionKey: string; pageToken: string; windowComplete: boolean; caughtUp: boolean; serverNow: number; items: readonly (Omit<typeof KernelReaderSchema.Visible.Type, "version"> | Omit<typeof KernelReaderSchema.Revoked.Type, "version">)[] }
/** Metadata and the complete bounded work list are committed before any message page is fetched. */
export const applyChanges = (runtime: Runtime, page: ChangesPage) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored || page.version !== readerVersion(runtime) || page.scopeKey !== stored.scope_key || page.items.length > 32 || KernelReaderSchema.bytes(JSON.stringify(page)) > 65536 || page.after !== (stored.window_after ?? stored.completed_after) || (stored.window_upper !== null && page.upper !== stored.window_upper)) return yield* failure("reader_scope_mismatch", "changes")
  const items = page.items.map((item) => KernelReaderSchema.decode(KernelReaderSchema.Metadata, KernelReaderSchema.encode(KernelReaderSchema.Metadata, { version: 1, ...item }, 4096), 4096))
  const names = new Map(yield* Effect.forEach(items.filter((item) => item.visibility === "visible"), (item) => engine.inspect({ conversationType: item.conversationType, conversationID: item.targetId }).pipe(Effect.flatMap((verified) => Schema.is(KernelReaderSchema.text(512))(verified.name) ? Effect.succeed([item.projectionKey, verified.name] as const) : failure("reader_mapping_conflict", "group-name")))))
  const changed: string[] = []
  const work: KernelReaderSchema.Continuation["projections"][number][] = []
  yield* engine.db.transaction((tx) => Effect.gen(function* () {
    yield* current(runtime)
    const fresh = yield* tx.select().from(IMKernelReaderScopeTable).where(eq(IMKernelReaderScopeTable.reader_key, stored.reader_key)).get()
    if (fresh?.local_revision !== stored.local_revision) return yield* failure("reader_stale", "changes")
    for (const item of items) {
      if (item.visibility === "pending") return yield* failure("reader_mapping_conflict", "changes")
      const byProjection = yield* tx.select().from(IMKernelReaderProjectionTable).where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), eq(IMKernelReaderProjectionTable.projection_key, item.projectionKey))).get()
      const byTarget = item.visibility === "visible" ? yield* tx.select().from(IMKernelReaderProjectionTable).where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), eq(IMKernelReaderProjectionTable.conversation_type, item.conversationType), eq(IMKernelReaderProjectionTable.target_id, item.targetId))).get() : undefined
      if (byProjection && byTarget && byProjection.binding_key !== byTarget.binding_key) {
        if (item.visibility !== "visible" || byTarget.visibility !== "pending" || !byTarget.local_group_id || byProjection.visibility !== "revoked" || byProjection.local_group_id !== null || byProjection.owned_group_bytes !== 0 || byProjection.accounted_records !== 1 || byProjection.accounted_bytes !== accounting(byProjection) || !byProjection.server_revision || KernelReaderSchema.compareDecimal(item.revision, byProjection.server_revision) <= 0) return yield* failure("reader_mapping_conflict", "changes")
        const previous = KernelReaderSchema.decode(KernelReaderSchema.Revoked, byProjection.metadata, 4096)
        if (byProjection.metadata_hash !== hash(byProjection.metadata) || previous.projectionKey !== item.projectionKey || previous.revision !== byProjection.server_revision) return yield* failure("reader_mapping_conflict", "changes")
        const occupied = yield* tx.get<{ present: number }>(sql`SELECT EXISTS(SELECT 1 FROM im_kernel_reader_message WHERE reader_key=${stored.reader_key} AND binding_key=${byProjection.binding_key} LIMIT 1) OR EXISTS(SELECT 1 FROM im_kernel_reader_read_intent WHERE reader_key=${stored.reader_key} AND binding_key=${byProjection.binding_key} LIMIT 1) AS present`)
        if (occupied?.present !== 0) return yield* failure("reader_mapping_conflict", "changes")
        yield* reserve(tx, -byProjection.accounted_records, -byProjection.accounted_bytes)
        const removed = yield* tx.delete(IMKernelReaderProjectionTable).where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), eq(IMKernelReaderProjectionTable.binding_key, byProjection.binding_key), eq(IMKernelReaderProjectionTable.local_revision, byProjection.local_revision))).returning().get()
        if (!removed) return yield* failure("reader_stale", "changes")
      }
      const original = byTarget ?? byProjection
      const old = original?.local_group_id && item.visibility === "visible" ? yield* refreshGroupName(tx, engine, original, names.get(item.projectionKey)!) : original
      if (old?.server_revision && KernelReaderSchema.compareDecimal(item.revision, old.server_revision) < 0) return yield* failure("reader_stale", "changes")
      const metadata = KernelReaderSchema.encode(KernelReaderSchema.Metadata, item, 4096)
      if (old?.server_revision === item.revision && old.metadata !== metadata) return yield* failure("reader_mapping_conflict", "changes")
      if (old?.metadata === metadata) {
        if (old !== original && old.local_group_id) changed.push(old.local_group_id)
        continue
      }
      if (item.visibility === "visible") work.push({ projectionKey: item.projectionKey, serverRevision: item.revision, direction: "newer", anchor: old?.newer_after ?? "0", phase: "pending" })
      const bindingKey = old?.binding_key ?? (item.visibility === "visible" ? hash(["deepagent.im.reader.mapping.v1", stored.reader_key, item.conversationType, item.targetId]) : hash(["deepagent.im.reader.projection.v1", stored.reader_key, item.projectionKey]))
      const groupID = old?.local_group_id ?? (item.visibility === "visible" ? `img_kr_${bindingKey}` : null)
      const now = Date.now()
      const group = !old?.local_group_id && item.visibility === "visible" ? { id: GroupID.make(groupID!), workspace_id: engine.workspaceID, project_id: null, type: item.conversationType === 1 ? "direct" as const : "project" as const, name: names.get(item.projectionKey)!, created_by: engine.userID, kernel_conv_id: `kr1:${bindingKey}`, created_at: now, updated_at: now, deleted_at: null } : undefined
      const member = group ? { group_id: group.id, member_id: engine.userID, member_type: "user" as const, role: "owner" as const, last_read_at: null, joined_at: now } : undefined
      const row = { reader_key: stored.reader_key, binding_key: bindingKey, projection_key: item.projectionKey, conversation_type: item.visibility === "visible" ? item.conversationType : old?.conversation_type ?? null, target_id: item.visibility === "visible" ? item.targetId : old?.target_id ?? null, version: 1, local_revision: (old?.local_revision ?? 0) + 1, visibility: item.visibility, server_revision: item.revision, cursor: item.cursor, local_group_id: groupID, metadata, metadata_hash: hash(metadata), read_ordinal: item.visibility === "visible" ? item.readOrdinal : null, admitted_ordinal: item.visibility === "visible" ? item.admittedOrdinal : null, live_unread: item.visibility === "visible" ? item.liveUnread : null, stored_unread: item.visibility === "visible" ? item.storedUnread : null, next_expiry_at: item.visibility === "visible" ? item.nextExpiryAt : null, last_server_now: page.serverNow, observed_at: now, newer_after: old?.newer_after ?? "0", older_before: old?.older_before ?? null, scan_revision: item.visibility === "visible" ? item.revision : null, history_complete: old?.history_complete ?? 0, owned_group_bytes: old?.owned_group_bytes ?? (group && member ? accounting(group) + accounting(member) : 0), created_at: old?.created_at ?? now, updated_at: now, accounted_records: groupID ? 3 : 1, accounted_bytes: 0 }
      row.accounted_bytes = accounting(row) + row.owned_group_bytes
      yield* reserve(tx, row.accounted_records - (old?.accounted_records ?? 0), row.accounted_bytes - (old?.accounted_bytes ?? 0))
      if (group && member) { yield* tx.insert(GroupTable).values(group).run(); yield* tx.insert(MemberTable).values(member).run() }
      if (old) yield* tx.update(IMKernelReaderProjectionTable).set(row).where(and(eq(IMKernelReaderProjectionTable.reader_key, old.reader_key), eq(IMKernelReaderProjectionTable.binding_key, old.binding_key), eq(IMKernelReaderProjectionTable.local_revision, old.local_revision))).run()
      if (!old) yield* tx.insert(IMKernelReaderProjectionTable).values(row).run()
      if (groupID) changed.push(groupID)
    }
    // The SDK change window includes the last cursor's tie group. An unchanged
    // boundary row has already completed its message work and must not rescan.
    const continuation = KernelReaderSchema.encode(KernelReaderSchema.Continuation, { version: 1, projections: work }, 8192)
    const update = { ...stored, phase: "partial" as const, window_after: page.after, window_upper: page.upper, scan_cursor: page.scanCursor, scan_projection_key: page.scanProjectionKey || null, page_token: page.pageToken || null, continuation, local_revision: stored.local_revision + 1, updated_at: Date.now() }
    update.accounted_bytes = accounting(update, 8192 - KernelReaderSchema.bytes(continuation))
    yield* reserve(tx, 0, update.accounted_bytes - stored.accounted_bytes)
    const checkpoint = yield* tx.update(IMKernelReaderScopeTable).set(update).where(and(eq(IMKernelReaderScopeTable.reader_key, stored.reader_key), eq(IMKernelReaderScopeTable.local_revision, stored.local_revision))).returning().get()
    if (!checkpoint) return yield* failure("reader_stale", "checkpoint")
  }), { behavior: "immediate" })
  return changed
})
export type MessagesPage = { version: 1 | 2; scopeKey: string; projectionKey: string; projectionRevision: string; direction: "older" | "newer"; nextDeliveryCursor: string; finished: boolean; serverNow: number; items: readonly KernelReaderSchema.Message[] }
export const applyMessages = (runtime: Runtime, page: MessagesPage, recoveryEffectKey?: string, liveHandle?: object | readonly object[]) => Effect.gen(function* () {
  if (Array.isArray(liveHandle) && liveHandle.length > 32) return yield* failure("reader_capacity", "live-sync")
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored || page.version !== readerVersion(runtime) || page.scopeKey !== stored.scope_key || page.items.length > 32 || KernelReaderSchema.bytes(JSON.stringify(page)) > 4_194_304) return yield* failure("reader_scope_mismatch", "messages")
  const items = yield* Effect.try({ try: () => page.items.map((item) => {
    const decoded: KernelReaderSchema.Message = page.version === 2
      ? KernelReaderSchema.decode(KernelReaderSchema.MessageV2, JSON.stringify(item), 68000)
      : KernelReaderSchema.decode(KernelReaderSchema.MessageV1, JSON.stringify(item), 68000)
    KernelReaderSchema.wireContent(decoded.content, "messageType" in decoded ? Schema.decodeUnknownSync(KernelReaderSchema.MessageType)(decoded.messageType) : "jg:text", decoded.expiresAt)
    return decoded
  }), catch: () => failure("reader_mapping_conflict", "message-body") })
  if (recoveryEffectKey && (items.length !== 1 || items[0]?.effectKey !== recoveryEffectKey)) return yield* failure("reader_mapping_conflict", "sender-recovery")
  return yield* engine.db.transaction((tx) => Effect.gen(function* () {
    yield* current(runtime)
    const projection = yield* tx.select().from(IMKernelReaderProjectionTable).where(and(eq(IMKernelReaderProjectionTable.reader_key, stored.reader_key), eq(IMKernelReaderProjectionTable.projection_key, page.projectionKey))).get()
    if (!projection || projection.visibility !== "visible" || !projection.local_group_id || projection.server_revision !== page.projectionRevision || projection.scan_revision !== page.projectionRevision) return yield* failure("reader_stale", "messages")
    const changed: string[] = []
    for (const item of items) {
      if (item.conversationType !== projection.conversation_type || item.targetId !== projection.target_id) return yield* failure("reader_mapping_conflict", "messages")
      const old = yield* tx.select().from(IMKernelReaderMessageTable).where(and(eq(IMKernelReaderMessageTable.reader_key, stored.reader_key), eq(IMKernelReaderMessageTable.effect_key, item.effectKey), sql`length(CAST(${IMKernelReaderMessageTable.metadata} AS BLOB)) <= 2048`)).get()
      const observation = old ? KernelReaderSchema.decode(SchemaMessageMetadata, old.metadata, 2048) : undefined
      if (observation && (observation.isSend !== item.isSend || observation.isRead && !item.isRead || (observation.readerVersion ?? 1) !== page.version || observation.messageType !== ("messageType" in item ? item.messageType : undefined))) return yield* failure("reader_mapping_conflict", "message-retry")
      // A recipient read flag is a later observation; retain the original bytes/hash.
      const metadata = old?.metadata ?? (yield* Effect.try({ try: () => KernelReaderSchema.encode(SchemaMessageMetadata,
        { version: 1, isSend: item.isSend, isRead: item.isRead, ...("messageType" in item ? { readerVersion: 2 as const, messageType: Schema.decodeUnknownSync(KernelReaderSchema.MessageType)(item.messageType) } : {}), firstSeen: firstSeen(engine, page, item, liveHandle) }, 2048),
        catch: (error) => error instanceof KernelReaderSchema.Error ? error : failure("reader_mapping_conflict", "first-seen") }))
      const immutable = { reader_key: stored.reader_key, effect_key: item.effectKey, binding_key: projection.binding_key, projection_key: page.projectionKey, message_id: item.messageId, sequence: item.sequence, delivery_cursor: item.deliveryCursor, message_time: item.messageTime, expires_at: item.expiresAt, sender_id: item.senderId, target_id: item.targetId, conversation_type: item.conversationType, body_hash: bodyHash(item.content), metadata }
      const immutableHash = hash(immutable)
      if (old) {
        if (old.immutable_hash !== immutableHash || old.body_hash !== immutable.body_hash) return yield* failure("reader_mapping_conflict", "message-retry")
        if (old.owns_message || !old.local_message_id || old.storage_state !== "present") continue
        const original = yield* tx.select({ message: MessageTable, delivery: IMKernelDeliveryTable }).from(IMKernelDeliveryTable).innerJoin(MessageTable, eq(MessageTable.id, IMKernelDeliveryTable.message_id)).where(and(eq(MessageTable.id, MessageID.make(old.local_message_id)), sql`(${IMKernelDeliveryTable.binding} IS NULL OR length(CAST(${IMKernelDeliveryTable.binding} AS BLOB)) <= ${KernelDeliverySchema.BINDING_BYTES})`, sql`length(CAST(${MessageTable.content} AS BLOB)) <= 65536`)).get()
        const historical = original ? yield* KernelDelivery.history(tx, original.message.id) : undefined
        if (historical?.kind === "retired" || historical?.kind === "reply_retired") {
          if (!historicalSender(historical, item, engine, projection.local_group_id, page.serverNow)) return yield* failure("reader_mapping_conflict", "sender-retired-history")
          continue
        }
        const originalReceipt = historical?.kind === "live" ? historical.receipt : undefined
        const originalWire = originalReceipt && original ? KernelDelivery.wireMessage(originalReceipt.binding, original.message) : undefined
        if (!original || !originalReceipt || !originalWire || originalWire.messageType !== ("messageType" in item ? item.messageType : "jg:text") || original.delivery.binding_hash !== hash(originalReceipt.binding) || original.delivery.state !== "acknowledged" || original.delivery.kernel_message_id !== item.messageId || originalReceipt.binding.messageID !== original.message.id || originalReceipt.binding.groupID !== projection.local_group_id || originalReceipt.binding.workspaceID !== engine.workspaceID || originalReceipt.binding.expiresAt !== item.expiresAt || originalReceipt.binding.conversationID !== item.targetId || originalReceipt.binding.conversationType !== item.conversationType || original.message.group_id !== projection.local_group_id || original.message.deleted_at !== null || originalWire.content !== item.content || !item.isSend || item.senderId !== engine.source.senderID || hash({ ...originalReceipt.binding.source, credentialFingerprint: engine.source.credentialFingerprint }) !== hash(engine.source)) return yield* failure("reader_mapping_conflict", "sender-recovery")
        if (originalReceipt.binding.source.credentialFingerprint === engine.source.credentialFingerprint) continue
        const mirror = readerMirror(projection.local_group_id, `imsg_kr_${hash([stored.reader_key, item.effectKey])}`, item)
        const update = { ...old, local_message_id: mirror.id, owns_message: 1, local_revision: old.local_revision + 1, updated_at: Date.now(), accounted_records: 2, accounted_bytes: 0 }
        update.accounted_bytes = accounting(update) + accounting({ ...mirror, metadata: JSON.stringify(mirror.metadata) })
        yield* reserve(tx, update.accounted_records - old.accounted_records, update.accounted_bytes - old.accounted_bytes)
        yield* tx.insert(MessageTable).values(mirror).run()
        const changedRow = yield* tx.update(IMKernelReaderMessageTable).set(update).where(and(eq(IMKernelReaderMessageTable.reader_key, old.reader_key), eq(IMKernelReaderMessageTable.effect_key, old.effect_key), eq(IMKernelReaderMessageTable.local_revision, old.local_revision))).returning().get()
        if (!changedRow) return yield* failure("reader_stale", "sender-recovery")
        changed.push(projection.local_group_id)
        continue
      }
      if (recoveryEffectKey) return yield* failure("reader_mapping_conflict", "sender-recovery")
      const receipt = item.isSend && item.senderId === engine.source.senderID ? yield* tx.select({ message: MessageTable, delivery: IMKernelDeliveryTable }).from(IMKernelDeliveryTable).innerJoin(MessageTable, eq(MessageTable.id, IMKernelDeliveryTable.message_id)).where(and(eq(IMKernelDeliveryTable.kernel_message_id, item.messageId), eq(MessageTable.group_id, GroupID.make(projection.local_group_id)), eq(IMKernelDeliveryTable.state, "acknowledged"))).get() : undefined
      const historical = receipt ? yield* KernelDelivery.history(tx, receipt.message.id) : undefined
      if (historical?.kind === "retired" || historical?.kind === "reply_retired") {
        if (!historicalSender(historical, item, engine, projection.local_group_id, page.serverNow)) return yield* failure("reader_mapping_conflict", "sender-retired-history")
        continue
      }
      const checkedReceipt = historical?.kind === "live" ? historical.receipt : undefined
      const sentWire = checkedReceipt && receipt ? KernelDelivery.wireMessage(checkedReceipt.binding, receipt.message) : undefined
      const verifiedReceipt = receipt && checkedReceipt && sentWire && sentWire.messageType === ("messageType" in item ? item.messageType : "jg:text") && sentWire.content === item.content && receipt.message.deleted_at === null && checkedReceipt.binding.messageID === receipt.message.id && checkedReceipt.binding.workspaceID === engine.workspaceID && hash({ ...checkedReceipt.binding.source, credentialFingerprint: engine.source.credentialFingerprint }) === hash(engine.source) && checkedReceipt.binding.expiresAt === item.expiresAt && checkedReceipt.binding.groupID === projection.local_group_id && checkedReceipt.binding.conversationID === item.targetId && checkedReceipt.binding.conversationType === item.conversationType ? receipt : undefined
      if (receipt && !verifiedReceipt) return yield* failure("reader_mapping_conflict", "sender-receipt")
      // A first echo after a normal credential rotation needs the same current
      // owned mirror as sender recovery. The original acknowledged send stays immutable.
      const exactReceipt = verifiedReceipt && checkedReceipt?.binding.source.credentialFingerprint === engine.source.credentialFingerprint ? verifiedReceipt : undefined
      const present = item.expiresAt > page.serverNow
      const localID = present ? exactReceipt?.message.id ?? MessageID.make(`imsg_kr_${hash([stored.reader_key, item.effectKey])}`) : null
      const message = present && !exactReceipt ? readerMirror(projection.local_group_id, localID!, item) : undefined
      const row = { ...immutable, version: 1, local_revision: 1, immutable_hash: immutableHash, local_message_id: localID, owns_message: message ? 1 : 0, body_bytes: present ? KernelReaderSchema.bytes(item.content) : 0, obligation_records: 0, obligation_bytes: 0, storage_state: present ? "present" as const : "expired" as const, created_at: Date.now(), updated_at: Date.now(), accounted_records: message ? 2 : 1, accounted_bytes: 0 }
      row.accounted_bytes = accounting(row) + (message ? accounting({ ...message, metadata: JSON.stringify(message.metadata) }) : 0)
      yield* reserve(tx, row.accounted_records, row.accounted_bytes)
      if (message) yield* tx.insert(MessageTable).values(message).run()
      yield* tx.insert(IMKernelReaderMessageTable).values(row).run()
      if (present) changed.push(projection.local_group_id)
    }
    const update = { ...projection, newer_after: !recoveryEffectKey && page.direction === "newer" ? page.nextDeliveryCursor || projection.newer_after : projection.newer_after, older_before: !recoveryEffectKey && page.direction === "older" ? page.nextDeliveryCursor || projection.older_before : projection.older_before, history_complete: !recoveryEffectKey && page.direction === "older" && page.finished ? 1 : projection.history_complete, scan_revision: projection.scan_revision, local_revision: projection.local_revision + 1, last_server_now: page.serverNow, observed_at: Date.now(), updated_at: Date.now() }
    update.accounted_bytes = accounting(update) + update.owned_group_bytes
    yield* reserve(tx, 0, update.accounted_bytes - projection.accounted_bytes)
    const updated = yield* tx.update(IMKernelReaderProjectionTable).set(update).where(and(eq(IMKernelReaderProjectionTable.reader_key, projection.reader_key), eq(IMKernelReaderProjectionTable.binding_key, projection.binding_key), eq(IMKernelReaderProjectionTable.local_revision, projection.local_revision))).returning().get()
    if (!updated) return yield* failure("reader_stale", "message-checkpoint")
    if (!recoveryEffectKey && stored.phase === "partial") {
      const continuation = KernelReaderSchema.decode(KernelReaderSchema.Continuation, stored.continuation, 8192)
      const work = continuation.projections.find((item) => item.projectionKey === page.projectionKey && item.serverRevision === page.projectionRevision && item.direction === page.direction)
      if (work) {
        // Page application and its next phase commit together. A slow finished
        // newer page must not be repeated when the dispatch slice has ended.
        // Move its remaining work to the tail so another conversation gets the
        // next bounded slice even while this conversation has more history.
        const next = { ...work, direction: page.direction === "newer" && page.finished && !projection.history_complete ? "older" as const : work.direction,
          anchor: page.direction === "newer" && page.finished && !projection.history_complete ? projection.older_before ?? "0" : page.nextDeliveryCursor || work.anchor }
        const encoded = KernelReaderSchema.encode(KernelReaderSchema.Continuation, { version: 1,
          projections: [...continuation.projections.filter((item) => item !== work), next] }, 8192)
        const checkpoint = { ...stored, continuation: encoded, local_revision: stored.local_revision + 1, updated_at: Date.now(), accounted_bytes: 0 }
        checkpoint.accounted_bytes = accounting(checkpoint, 8192 - KernelReaderSchema.bytes(encoded))
        yield* reserve(tx, 0, checkpoint.accounted_bytes - stored.accounted_bytes)
        const advanced = yield* tx.update(IMKernelReaderScopeTable).set(checkpoint).where(and(eq(IMKernelReaderScopeTable.reader_key, stored.reader_key), eq(IMKernelReaderScopeTable.local_revision, stored.local_revision))).returning().get()
        if (!advanced) return yield* failure("reader_stale", "message-checkpoint")
      }
    }
    return [...new Set(changed)]
  }), { behavior: "immediate" })
})
function historicalSender(original: Extract<Effect.Success<ReturnType<typeof KernelDelivery.history>>, {kind:"retired"|"reply_retired"}>,
  item:KernelReaderSchema.Message, engine:Engine, groupID:string, serverNow:number) {
  if (original.kind==="retired") return historicalMedia(original,item,engine,groupID,serverNow)
  const transport = original.record.transport
  if (!transport) return false
  const identity = transport.binding
  return (!("messageType" in item) || item.messageType==="jg:text") && item.isSend && item.senderId===engine.source.senderID &&
    original.receipt.state==="acknowledged" && original.receipt.kernel_message_id===item.messageId && identity.workspaceID===engine.workspaceID &&
    identity.groupID===groupID && identity.conversationType===item.conversationType && identity.conversationID===item.targetId &&
    identity.expiresAt===item.expiresAt && identity.expiresAt<=serverNow && transport.wireHash===bodyHash(item.content) &&
    hash({...identity.source,credentialFingerprint:engine.source.credentialFingerprint})===hash(engine.source)
}

/** Exact expired echo reconciliation only. It creates no Message, mirror,
 * locator or permission and cannot reinterpret a new body as old history. */
function historicalMedia(original: Extract<Effect.Success<ReturnType<typeof KernelDelivery.history>>, { kind: "retired" }>,
  item: KernelReaderSchema.Message, engine: Engine, groupID: string, serverNow: number) {
  const identity = original.record.identity
  return "messageType" in item && item.messageType === "dac:media.v1" && item.isSend && item.senderId === engine.source.senderID &&
    original.receipt.state === "acknowledged" && original.receipt.kernel_message_id === item.messageId &&
    identity.workspaceID === engine.workspaceID && identity.groupID === groupID && identity.conversationType === item.conversationType &&
    identity.conversationID === item.targetId && identity.expiresAt === item.expiresAt && identity.expiresAt <= serverNow &&
    identity.wireHash === bodyHash(item.content) && hash({ ...identity.source, credentialFingerprint: engine.source.credentialFingerprint }) === hash(engine.source)
}

function firstSeen(engine: Engine, page: MessagesPage, item: KernelReaderSchema.Message, handles?: object | readonly object[]): KernelReaderSchema.FirstSeen {
  const now = Date.now()
  const candidates = handles === undefined ? [] : Array.isArray(handles) ? handles : [handles]
  const live = candidates.flatMap((handle) => {
    const value = Schema.decodeUnknownOption(KernelReaderSchema.LiveObservation)(engine.liveObservation?.(handle), { onExcessProperty: "error" })
    return Option.isSome(value) ? [value.value] : []
  }).find((live) => live.scopeKey === page.scopeKey && live.projectionKey === page.projectionKey && live.projectionRevision === page.projectionRevision && live.sourceHash === hash(engine.source) && live.receiverID === engine.source.senderID && live.receivedAt <= now && now - live.receivedAt < 30_000 && item.expiresAt > Math.max(page.serverNow, now, live.receivedAt) && !item.isSend && (!("messageType" in item) || item.messageType === "jg:text") && live.messageID === item.messageId && live.sequence === item.sequence && live.messageTime === item.messageTime && live.senderID === item.senderId && live.conversationType === item.conversationType && live.conversationID === item.targetId && live.wireContent === item.content && (live.originalDestroyTime === undefined || live.originalDestroyTime === item.expiresAt))
  if (!live) return { version: 1, origin: "history" }
  return { version: 1, origin: "kernel_live", receiverID: live.receiverID, transportGeneration: live.transportGeneration,
    receivedAt: live.receivedAt, sourceExpiresAt: Math.min(item.expiresAt, live.receivedAt + 86_400_000),
    observationHash: hash(["deepagent.im.reader.live-observation.v1", live]), sourceHash: live.sourceHash }
}

function readerMirror(groupID: string, messageID: string, item: KernelReaderSchema.Message) {
  return { id: MessageID.make(messageID), group_id: GroupID.make(groupID), sender_id: item.senderId, sender_type: "user" as const, type: "text" as const, content: item.content, mentions: null, metadata: { type: "kernel_sync" as const, liveEligible: false }, reply_to_id: null, event_id: null, delivery_status: null, kernel_msg_id: null, client_request_id: null, created_at: item.messageTime, updated_at: item.messageTime, deleted_at: null }
}
/** A bounded identity-only recovery queue; original receipts never regain dispatch authority. */
export const senderRecovery = (runtime: Runtime, serverNow: number) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored) return []
  return yield* engine.db.select({ effectKey: IMKernelReaderMessageTable.effect_key, projectionKey: IMKernelReaderMessageTable.projection_key, deliveryCursor: IMKernelReaderMessageTable.delivery_cursor }).from(IMKernelReaderMessageTable).innerJoin(IMKernelReaderProjectionTable, and(eq(IMKernelReaderProjectionTable.reader_key, IMKernelReaderMessageTable.reader_key), eq(IMKernelReaderProjectionTable.binding_key, IMKernelReaderMessageTable.binding_key), eq(IMKernelReaderProjectionTable.projection_key, IMKernelReaderMessageTable.projection_key))).where(and(eq(IMKernelReaderMessageTable.reader_key, stored.reader_key), eq(IMKernelReaderMessageTable.owns_message, 0), eq(IMKernelReaderMessageTable.storage_state, "present"), eq(IMKernelReaderProjectionTable.visibility, "visible"), sql`${IMKernelReaderMessageTable.local_message_id} IS NOT NULL`, sql`${IMKernelReaderMessageTable.expires_at} > ${serverNow}`, sql`EXISTS(SELECT 1 FROM im_kernel_delivery d WHERE d.message_id = ${IMKernelReaderMessageTable.local_message_id} AND d.kernel_message_id = ${IMKernelReaderMessageTable.message_id} AND json_extract(d.binding, '$.source.credentialFingerprint') <> ${engine.source.credentialFingerprint})`)).orderBy(IMKernelReaderMessageTable.effect_key).limit(32).all()
})
const SchemaMessageMetadata = KernelReaderSchema.MessageMetadata
/** Only a successful current SDK response supplies this clock; GET never calls cleanup. */
export const cleanup = (runtime: Runtime, serverNow: number) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  if (Option.isNone(Schema.decodeUnknownOption(KernelReaderSchema.Time)(serverNow))) return yield* failure("reader_scope_mismatch", "cleanup-clock")
  const stored = yield* scope(runtime)
  if (!stored) return []
  return yield* engine.db.transaction((tx) => Effect.gen(function* () {
    yield* current(runtime)
    const fresh = yield* tx.select().from(IMKernelReaderScopeTable).where(eq(IMKernelReaderScopeTable.reader_key, stored.reader_key)).get()
    if (!fresh || fresh.local_revision !== stored.local_revision || fresh.binding !== stored.binding || fresh.binding_hash !== stored.binding_hash)
      return yield* failure("reader_stale", "cleanup-scope")
    const rows = yield* tx.select({ message: IMKernelReaderMessageTable, projection: IMKernelReaderProjectionTable }).from(IMKernelReaderMessageTable).innerJoin(IMKernelReaderProjectionTable, and(eq(IMKernelReaderProjectionTable.reader_key, IMKernelReaderMessageTable.reader_key), eq(IMKernelReaderProjectionTable.binding_key, IMKernelReaderMessageTable.binding_key), eq(IMKernelReaderProjectionTable.projection_key, IMKernelReaderMessageTable.projection_key))).where(and(eq(IMKernelReaderMessageTable.reader_key, stored.reader_key), eq(IMKernelReaderMessageTable.storage_state, "present"), or(sql`${IMKernelReaderMessageTable.expires_at} <= ${serverNow}`, eq(IMKernelReaderProjectionTable.visibility, "revoked")))).limit(32).all()
    const groups = [...new Set(rows.flatMap((item) => item.projection.local_group_id ? [item.projection.local_group_id] : []))]
    yield* Effect.forEach(groups, (groupID) => requireCleanupGroup(tx, engine, groupID), { discard: true })
    const changed: string[] = []
    for (const item of rows) {
      if (item.message.owns_message && item.message.local_message_id) yield* accountObligations(tx, item.message.local_message_id)
      const row = (yield* tx.select().from(IMKernelReaderMessageTable).where(and(
        eq(IMKernelReaderMessageTable.reader_key, item.message.reader_key), eq(IMKernelReaderMessageTable.effect_key, item.message.effect_key),
      )).get())!
      const mirror = row.owns_message && row.local_message_id ? yield* tx.select().from(MessageTable).where(eq(MessageTable.id, MessageID.make(row.local_message_id))).get() : undefined
      if (row.owns_message && (!mirror || mirror.group_id !== item.projection.local_group_id || bodyHash(mirror.content) !== row.body_hash || KernelReaderSchema.bytes(mirror.content) !== row.body_bytes)) return yield* failure("reader_cleanup_required", "cleanup-body")
      const retained = mirror && row.obligation_records > 0 ? { ...mirror, content: "", deleted_at: row.expires_at, updated_at: Math.max(mirror.updated_at, Date.now()) } : undefined
      const update = { ...row, storage_state: item.projection.visibility === "revoked"
        ? retained ? "redacted_obligation" : "redacted" : retained ? "expired_obligation" : "expired",
        local_message_id: retained ? row.local_message_id : null, owns_message: retained ? 1 : 0, body_bytes: 0,
        obligation_records: retained ? row.obligation_records : 0, obligation_bytes: retained ? row.obligation_bytes : 0,
        accounted_records: retained ? 2 + row.obligation_records : 1, local_revision: row.local_revision + 1, updated_at: Date.now() }
      update.accounted_bytes = accounting(update) + (retained ? accounting({ ...retained, metadata: JSON.stringify(retained.metadata) }) + row.obligation_bytes : 0)
      yield* reserve(tx, update.accounted_records - row.accounted_records, update.accounted_bytes - row.accounted_bytes)
      const updated = yield* tx.update(IMKernelReaderMessageTable).set(update).where(and(eq(IMKernelReaderMessageTable.reader_key, row.reader_key), eq(IMKernelReaderMessageTable.effect_key, row.effect_key), eq(IMKernelReaderMessageTable.local_revision, row.local_revision))).returning().get()
      if (!updated) return yield* failure("reader_stale", "cleanup")
      if (mirror) {
        if (retained) {
          const retired = yield* tx.update(MessageTable).set({ content: retained.content, deleted_at: retained.deleted_at, updated_at: retained.updated_at })
            .where(and(eq(MessageTable.id, mirror.id), eq(MessageTable.content, mirror.content), isNull(MessageTable.deleted_at)))
            .returning({ id: MessageTable.id }).get()
          if (!retired) return yield* failure("reader_cleanup_required", "cleanup-retire")
        }
        if (retained) {
          if (item.projection.local_group_id) changed.push(item.projection.local_group_id)
          continue
        }
        const removed = yield* tx.delete(MessageTable).where(eq(MessageTable.id, mirror.id)).returning({ id: MessageTable.id }).get()
        if (!removed) return yield* failure("reader_cleanup_required", "cleanup-delete")
      }
      if (item.projection.local_group_id) changed.push(item.projection.local_group_id)
    }
    yield* current(runtime)
    yield* Effect.forEach(groups, (groupID) => requireCleanupGroup(tx, engine, groupID), { discard: true })
    const settledScope = yield* tx.select().from(IMKernelReaderScopeTable).where(eq(IMKernelReaderScopeTable.reader_key, stored.reader_key)).get()
    if (!settledScope || settledScope.local_revision !== stored.local_revision || settledScope.binding !== stored.binding || settledScope.binding_hash !== stored.binding_hash)
      return yield* failure("reader_stale", "cleanup-scope")
    return [...new Set(changed)]
  }), { behavior: "immediate" })
})
function requireCleanupGroup(tx: Tx, engine: Engine, groupID: string) {
  return Effect.gen(function* () {
    const group = yield* tx.select({ id: GroupTable.id }).from(GroupTable).innerJoin(MemberTable, and(
      eq(MemberTable.group_id, GroupTable.id), eq(MemberTable.member_id, engine.userID), eq(MemberTable.member_type, "user"),
    )).where(and(eq(GroupTable.id, GroupID.make(groupID)), eq(GroupTable.workspace_id, engine.workspaceID), isNull(GroupTable.deleted_at))).get()
    if (!group) return yield* failure("reader_unavailable", "cleanup-member")
  })
}
export const checkpoint = (runtime: Runtime, completed: readonly string[], windowComplete: boolean) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored || stored.phase !== "partial") return
  const continuation = KernelReaderSchema.decode(KernelReaderSchema.Continuation, stored.continuation, 8192)
  const remaining = continuation.projections.filter((item) => !completed.includes(item.projectionKey))
  const done = remaining.length === 0 && windowComplete
  const encoded = KernelReaderSchema.encode(KernelReaderSchema.Continuation, { version: 1, projections: remaining }, 8192)
  const update = { ...stored, phase: done ? "idle" as const : "partial" as const, completed_after: done ? stored.window_upper! : stored.completed_after, window_after: done ? null : stored.window_after, window_upper: done ? null : stored.window_upper, scan_cursor: done ? null : stored.scan_cursor, scan_projection_key: done ? null : stored.scan_projection_key, page_token: done ? null : stored.page_token, continuation: encoded, local_revision: stored.local_revision + 1, updated_at: Date.now() }
  update.accounted_bytes = accounting(update, 8192 - KernelReaderSchema.bytes(encoded))
  yield* engine.db.transaction((tx) => Effect.gen(function* () { yield* reserve(tx, 0, update.accounted_bytes - stored.accounted_bytes); const changed = yield* tx.update(IMKernelReaderScopeTable).set(update).where(and(eq(IMKernelReaderScopeTable.reader_key, stored.reader_key), eq(IMKernelReaderScopeTable.local_revision, stored.local_revision))).returning().get(); if (!changed) return yield* failure("reader_stale", "checkpoint") }), { behavior: "immediate" })
})
/** A stale server revision invalidates unfinished work, never the completed cursor. */
export const discardWindow = (runtime: Runtime) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored || stored.phase === "idle") return
  const continuation = KernelReaderSchema.encode(KernelReaderSchema.Continuation, { version: 1, projections: [] }, 8192)
  const update = { ...stored, phase: "idle" as const, window_after: null, window_upper: null, scan_cursor: null, scan_projection_key: null, page_token: null, continuation, local_revision: stored.local_revision + 1, updated_at: Date.now() }
  update.accounted_bytes = accounting(update, 8192 - KernelReaderSchema.bytes(continuation))
  yield* engine.db.transaction((tx) => Effect.gen(function* () {
    yield* reserve(tx, 0, update.accounted_bytes - stored.accounted_bytes)
    const changed = yield* tx.update(IMKernelReaderScopeTable).set(update).where(and(eq(IMKernelReaderScopeTable.reader_key, stored.reader_key), eq(IMKernelReaderScopeTable.local_revision, stored.local_revision))).returning().get()
    if (!changed) return yield* failure("reader_stale", "discard-window")
  }), { behavior: "immediate" })
})
export const readIntent = (runtime: Runtime, actionID: string) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored) return undefined
  const row = yield* engine.db.select().from(IMKernelReaderReadIntentTable).where(and(eq(IMKernelReaderReadIntentTable.action_id, actionID), eq(IMKernelReaderReadIntentTable.reader_key, stored.reader_key), sql`length(CAST(${IMKernelReaderReadIntentTable.request} AS BLOB)) <= 4096`, sql`${IMKernelReaderReadIntentTable.result} IS NULL OR length(CAST(${IMKernelReaderReadIntentTable.result} AS BLOB)) <= 4096`)).get()
  return yield* Effect.try({ try: () => row ? checkedRead(row, stored, readerVersion(runtime)) : undefined, catch: () => failure("reader_mapping_conflict", "read-identity") })
})
export const readAction = (runtime: Runtime, originalActionID: string) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const stored = yield* scope(runtime)
  if (!stored) return []
  const rows = yield* engine.db.select().from(IMKernelReaderReadIntentTable).where(and(eq(IMKernelReaderReadIntentTable.reader_key, stored.reader_key), eq(IMKernelReaderReadIntentTable.original_action_id, originalActionID), sql`length(CAST(${IMKernelReaderReadIntentTable.request} AS BLOB)) <= 4096`, sql`${IMKernelReaderReadIntentTable.result} IS NULL OR length(CAST(${IMKernelReaderReadIntentTable.result} AS BLOB)) <= 4096`)).orderBy(IMKernelReaderReadIntentTable.cut_index).limit(32).all()
  return yield* Effect.try({ try: () => rows.map((row) => checkedRead(row, stored, readerVersion(runtime))), catch: () => failure("reader_mapping_conflict", "read-identity") })
})
function checkedRead(row: ReadIntent, stored: Scope, version: 1 | 2) {
  const request = KernelReaderSchema.decode(KernelReaderSchema.Request, row.request, 4096)
  if (row.reader_key !== stored.reader_key || request.version !== version || request.scopeKey !== stored.scope_key ||
      request.projectionKey !== row.projection_key || request.projectionRevision !== row.cut_revision ||
      request.throughOrdinal !== row.through_ordinal || row.request_hash !== hash([stored.binding_hash, row.request]))
    throw failure("reader_mapping_conflict", "read-identity")
  if (row.result) {
    const result = KernelReaderSchema.decode(KernelReaderSchema.Cut, row.result, 4096)
    if (result.version !== request.version || result.scopeKey !== request.scopeKey || result.projectionKey !== request.projectionKey || result.throughOrdinal !== request.throughOrdinal)
      throw failure("reader_mapping_conflict", "read-result")
  }
  return row
}
const readAdmission = (db: Reader, projection: Projection, input: { target: string; newAction?: boolean; continuing?: boolean }) => Effect.gen(function* () {
  const slots = yield* db.select({ phase: IMKernelReaderReadIntentTable.phase, target: IMKernelReaderReadIntentTable.original_target_admitted }).from(IMKernelReaderReadIntentTable).where(and(eq(IMKernelReaderReadIntentTable.reader_key, projection.reader_key), eq(IMKernelReaderReadIntentTable.binding_key, projection.binding_key), eq(IMKernelReaderReadIntentTable.projection_key, projection.projection_key!), inArray(IMKernelReaderReadIntentTable.phase, ["unknown", "prepared", "dispatched"]))).limit(9).all()
  if (slots.length >= 8) return yield* failure("reader_capacity", "read-action")
  if (slots.some((row) => row.phase !== "unknown")) return yield* failure("reader_unknown", "read-action")
  if (!input.continuing && slots.length && !input.newAction) return yield* failure("reader_unknown", "read-action")
  if (!input.continuing && input.newAction && slots.some((row) => KernelReaderSchema.compareDecimal(input.target, row.target) <= 0)) return yield* failure("reader_stale", "read-target")
})
/** The ordinary no-op path still observes outstanding original actions. */
export const validateNewRead = (runtime: Runtime, input: { groupID: string; target: string }) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const projection = (yield* projections(runtime, [input.groupID]))[0]
  if (!projection?.projection_key || projection.visibility !== "visible") return yield* failure("reader_required", "read-action")
  yield* readAdmission(engine.db, projection, input)
})
export const prepareRead = (runtime: Runtime, input: { actionID: string; groupID: string; cut: KernelReaderSchema.Cut; continue?: boolean; newAction?: boolean }) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.actionID)) return yield* failure("reader_scope_mismatch", "read-action")
  const stored = yield* scope(runtime)
  const projection = (yield* projections(runtime, [input.groupID]))[0]
  if (!stored || input.cut.version !== readerVersion(runtime) || !projection || projection.visibility !== "visible" || !projection.projection_key || projection.server_revision !== input.cut.projectionRevision || projection.projection_key !== input.cut.projectionKey || stored.scope_key !== input.cut.scopeKey) return yield* failure("reader_stale", "read-action")
  const lineage = yield* readAction(runtime, input.actionID)
  const root = lineage[0]
  const predecessor = lineage.at(-1)
  if (root && (root.projection_key !== projection.projection_key || root.binding_key !== projection.binding_key)) return yield* failure("reader_mapping_conflict", "read-action")
  if (root && (!input.continue || root.phase !== "confirmed" || predecessor?.phase !== "confirmed")) return predecessor
  if (lineage.length >= 32) return yield* failure("reader_capacity", "read-action")
  const target = root?.original_target_admitted ?? input.cut.targetAdmittedOrdinal
  const through = KernelReaderSchema.compareDecimal(input.cut.throughOrdinal, target) > 0 ? target : input.cut.throughOrdinal
  const actionID = root ? `rdcut_${hash([input.actionID, stored.reader_key, lineage.length, target])}` : input.actionID
  const request = KernelReaderSchema.encode(KernelReaderSchema.Request, { version: input.cut.version, scopeKey: input.cut.scopeKey, projectionKey: input.cut.projectionKey, projectionRevision: input.cut.projectionRevision, throughOrdinal: through }, 4096)
  const now = Date.now()
  const row = { action_id: actionID, original_action_id: input.actionID, cut_index: lineage.length, parent_action_id: root ? input.actionID : null, reader_key: stored.reader_key, binding_key: projection.binding_key, projection_key: projection.projection_key, version: 1, local_revision: 1, phase: "prepared", original_projection_revision: root?.original_projection_revision ?? input.cut.projectionRevision, original_target_admitted: target, cut_revision: input.cut.projectionRevision, through_ordinal: through, request_hash: hash([stored.binding_hash, request]), request, result: null, dispatched_at: null, settled_at: null, runtime_incarnation: null, created_at: now, updated_at: now, accounted_records: 1, accounted_bytes: 0 }
  row.accounted_bytes = accounting(row, 8192 - KernelReaderSchema.bytes(request) + 64)
  return yield* engine.db.transaction((tx) => Effect.gen(function* () {
    yield* current(runtime)
    const existing = yield* tx.select().from(IMKernelReaderReadIntentTable).where(eq(IMKernelReaderReadIntentTable.action_id, actionID)).get()
    if (existing) { if (existing.reader_key !== row.reader_key || existing.binding_key !== row.binding_key) return yield* failure("reader_mapping_conflict", "read-action"); return existing }
    const fresh = yield* tx.select().from(IMKernelReaderProjectionTable).where(and(eq(IMKernelReaderProjectionTable.reader_key, projection.reader_key), eq(IMKernelReaderProjectionTable.binding_key, projection.binding_key))).get()
    if (fresh?.local_revision !== projection.local_revision) return yield* failure("reader_stale", "read-action")
    yield* readAdmission(tx, projection, { target, newAction: input.newAction, continuing: !!root })
    yield* reserve(tx, 1, row.accounted_bytes)
    yield* tx.insert(IMKernelReaderReadIntentTable).values(row).run()
    yield* current(runtime)
    return row
  }), { behavior: "immediate" })
})
export const dispatchRead = (runtime: Runtime, actionID: string) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const row = yield* readIntent(runtime, actionID)
  if (!row || row.phase !== "prepared") return undefined
  return yield* engine.db.transaction((tx) => Effect.gen(function* () {
    yield* current(runtime)
    const changed = yield* tx.update(IMKernelReaderReadIntentTable).set({ phase: "dispatched", runtime_incarnation: runtime.incarnation, dispatched_at: Date.now(), updated_at: Date.now(), local_revision: row.local_revision + 1 }).where(and(eq(IMKernelReaderReadIntentTable.action_id, actionID), eq(IMKernelReaderReadIntentTable.phase, "prepared"), eq(IMKernelReaderReadIntentTable.local_revision, row.local_revision))).returning().get()
    yield* current(runtime)
    return changed
  }), { behavior: "immediate" })
})
/** Explicit cancellation only, before any dispatch; unknown effects remain a barrier. */
export const cancelRead = (runtime: Runtime, actionID: string) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const row = yield* readIntent(runtime, actionID)
  if (!row || row.phase !== "prepared" || row.dispatched_at !== null) return yield* failure("reader_unknown", "cancel-read")
  const cancelled = yield* engine.db.update(IMKernelReaderReadIntentTable).set({ phase: "cancelled", settled_at: Date.now(), updated_at: Date.now(), local_revision: row.local_revision + 1 }).where(and(eq(IMKernelReaderReadIntentTable.action_id, actionID), eq(IMKernelReaderReadIntentTable.reader_key, row.reader_key), eq(IMKernelReaderReadIntentTable.local_revision, row.local_revision), eq(IMKernelReaderReadIntentTable.phase, "prepared"), isNull(IMKernelReaderReadIntentTable.dispatched_at))).returning().get()
  if (!cancelled) return yield* failure("reader_stale", "cancel-read")
  return cancelled
})
export const settleRead = (runtime: Runtime, actionID: string, result?: KernelReaderSchema.Cut) => Effect.gen(function* () {
  const engine = yield* current(runtime)
  const row = yield* readIntent(runtime, actionID)
  if (!row || !["dispatched", "unknown"].includes(row.phase)) return row
  if (result && (result.version !== KernelReaderSchema.decode(KernelReaderSchema.Request, row.request, 4096).version || result.version !== readerVersion(runtime) || result.scopeKey !== engine.scopeKey || result.projectionKey !== row.projection_key || result.throughOrdinal !== row.through_ordinal || KernelReaderSchema.compareDecimal(result.readOrdinal, row.through_ordinal) < 0)) return yield* failure("reader_stale", "read-result")
  const encoded = result ? KernelReaderSchema.encode(KernelReaderSchema.Cut, result, 4096) : null
  const update = { phase: result ? "confirmed" : "unknown", result: encoded, settled_at: result ? Date.now() : null, local_revision: row.local_revision + 1, updated_at: Date.now() }
  return yield* engine.db.transaction((tx) => Effect.gen(function* () {
    yield* current(runtime)
    const changed = yield* tx.update(IMKernelReaderReadIntentTable).set(update).where(and(eq(IMKernelReaderReadIntentTable.action_id, actionID), eq(IMKernelReaderReadIntentTable.local_revision, row.local_revision))).returning().get()
    yield* current(runtime)
    return changed
  }), { behavior: "immediate" })
})
