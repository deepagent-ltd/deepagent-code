export * as KernelTaskSnapshot from "./kernel-task-snapshot"

import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { WorkAuthority } from "../session/work-authority"
import { Hash } from "../util/hash"
import { KernelReader } from "./kernel-reader"
import { KernelReaderSchema } from "./kernel-reader.schema"
import { IMKernelReaderMessageTable, IMKernelReaderProjectionTable, IMKernelReaderScopeTable } from "./kernel-reader.sql"
import { KernelReceiverMapping } from "./kernel-receiver-mapping"
import { IMTaskAuthoritySchema } from "./task-authority.schema"
import { GroupTable, MemberTable, MessageTable } from "./sql"

const unavailable = () => new IMTaskAuthoritySchema.Error({
  code: "IM_TASK_SOURCE_UNAVAILABLE", message: "Original kernel reader source or receiver enrollment is unavailable or changed",
})

/** Called only after the existing Authority verified this source with its current native witness.
 * This transaction checks durable facts; it performs no native query or permission renewal. */
export const read = Effect.fn("KernelTaskSnapshot.read")(function* (
  tx: WorkAuthority.Transaction,
  message: typeof MessageTable.$inferSelect,
  group: typeof GroupTable.$inferSelect,
  proof: IMTaskAuthoritySchema.SourceProof,
) {
  const reader = proof.reader
  if (!reader || proof.origin !== "kernel_live" || !proof.realmID || !proof.appkeyID || !proof.orgID ||
    !proof.kernelMessageID || proof.intentID !== null || proof.conversationType === "local" ||
    message.kernel_msg_id !== null || message.event_id !== null || group.workspace_id !== reader.workspaceID ||
    group.kernel_conv_id !== `kr1:${reader.bindingKey}`)
    return yield* unavailable()
  const row = yield* tx.select({ source: IMKernelReaderMessageTable, projection: IMKernelReaderProjectionTable,
    scope: IMKernelReaderScopeTable }).from(IMKernelReaderMessageTable)
    .innerJoin(IMKernelReaderProjectionTable, and(eq(IMKernelReaderProjectionTable.reader_key, IMKernelReaderMessageTable.reader_key),
      eq(IMKernelReaderProjectionTable.binding_key, IMKernelReaderMessageTable.binding_key),
      eq(IMKernelReaderProjectionTable.projection_key, IMKernelReaderMessageTable.projection_key)))
    .innerJoin(IMKernelReaderScopeTable, eq(IMKernelReaderScopeTable.reader_key, IMKernelReaderMessageTable.reader_key))
    .where(and(eq(IMKernelReaderMessageTable.reader_key, reader.readerKey), eq(IMKernelReaderMessageTable.effect_key, reader.effectKey),
      eq(IMKernelReaderMessageTable.local_message_id, message.id))).get().pipe(Effect.orDie)
  if (!row || row.source.storage_state !== "present" || row.source.owns_message !== 1 ||
    row.source.binding_key !== reader.bindingKey || row.source.projection_key !== reader.projectionKey ||
    row.source.immutable_hash !== reader.immutableHash || row.source.message_id !== proof.kernelMessageID ||
    row.source.sender_id !== proof.senderID || row.source.target_id !== proof.conversationID ||
    String(row.source.conversation_type) !== proof.conversationType || row.source.message_time !== message.created_at ||
    row.source.body_hash !== Hash.sha256(message.content) || row.source.body_bytes !== KernelReaderSchema.bytes(message.content) ||
    row.projection.visibility !== "visible" || row.projection.local_group_id !== group.id ||
    row.projection.target_id !== proof.conversationID || String(row.projection.conversation_type) !== proof.conversationType ||
    row.scope.scope_key !== reader.scopeKey || row.scope.workspace_id !== reader.workspaceID ||
    row.scope.binding_hash !== KernelReader.hash(row.scope.binding) ||
    row.scope.reader_key !== KernelReader.hash(["deepagent.im.reader.v1", row.scope.binding]))
    return yield* unavailable()
  const decoded = yield* Effect.try({ try: () => ({
    binding: KernelReaderSchema.decode(KernelReaderSchema.Binding, row.scope.binding, 8192),
    projection: KernelReaderSchema.decode(KernelReaderSchema.Visible, row.projection.metadata, 4096),
    metadata: KernelReaderSchema.decode(KernelReaderSchema.MessageMetadata, row.source.metadata, 2048),
  }), catch: unavailable })
  const first = decoded.metadata.firstSeen
  if (!first || first.origin !== "kernel_live" || !first.sourceHash || first.sourceHash !== reader.sourceHash ||
    first.observationHash !== reader.observationHash || first.receiverID !== proof.receiverID ||
    first.transportGeneration !== proof.generation || first.sourceExpiresAt <= Date.now() ||
    first.sourceExpiresAt > row.source.expires_at || decoded.metadata.isSend ||
    (decoded.metadata.messageType ?? "jg:text") !== "jg:text" || decoded.binding.userID !== proof.receiverID ||
    decoded.binding.realm !== proof.realmID || decoded.binding.appkey !== proof.appkeyID ||
    decoded.binding.orgID !== proof.orgID || decoded.binding.workspaceID !== reader.workspaceID ||
    decoded.binding.scopeKey !== reader.scopeKey || decoded.projection.projectionKey !== reader.projectionKey ||
    decoded.projection.revision !== row.projection.server_revision || decoded.projection.targetId !== proof.conversationID ||
    String(decoded.projection.conversationType) !== proof.conversationType ||
    row.projection.metadata_hash !== KernelReader.hash(row.projection.metadata) ||
    row.source.immutable_hash !== KernelReader.hash({ reader_key: row.source.reader_key, effect_key: row.source.effect_key,
      binding_key: row.source.binding_key, projection_key: row.source.projection_key, message_id: row.source.message_id,
      sequence: row.source.sequence, delivery_cursor: row.source.delivery_cursor, message_time: row.source.message_time,
      expires_at: row.source.expires_at, sender_id: row.source.sender_id, target_id: row.source.target_id,
      conversation_type: row.source.conversation_type, body_hash: row.source.body_hash, metadata: row.source.metadata }))
    return yield* unavailable()
  yield* Effect.try({ try: () => KernelReaderSchema.wireContent(message.content, "jg:text", row.source.expires_at), catch: unavailable })
  const mapping = yield* KernelReceiverMapping.requireCurrent(tx, { targetID: reader.targetID, workspaceID: reader.workspaceID,
    localUserID: reader.localUserID, source: { realm: proof.realmID, appkey: proof.appkeyID, orgID: Number(proof.orgID), senderID: proof.receiverID } }).pipe(Effect.mapError(unavailable))
  if (mapping.mapping.id !== reader.mappingID || mapping.recordHash !== reader.mappingHash ||
    mapping.principal.instanceID !== proof.instanceID || mapping.principal.revision !== proof.revision ||
    mapping.registered.target.scope.securityNamespaceID !== proof.securityNamespaceID ||
    mapping.registered.namespaceBindingHash !== proof.namespaceBindingHash ||
    proof.expiresAt !== Math.min(first.sourceExpiresAt, mapping.mapping.expiresAt))
    return yield* unavailable()
  const viewer = yield* tx.select().from(MemberTable).where(and(eq(MemberTable.group_id, group.id),
    eq(MemberTable.member_type, "user"), eq(MemberTable.member_id, reader.localUserID))).get().pipe(Effect.orDie)
  if (!viewer) return yield* unavailable()
  return {
    message: { id: message.id, groupID: message.group_id, senderID: message.sender_id, senderType: message.sender_type,
      type: message.type, content: message.content, mentions: message.mentions, metadata: message.metadata,
      kernelMessageID: proof.kernelMessageID, eventID: null, createdAt: message.created_at },
    group: { id: group.id, workspaceID: group.workspace_id, projectID: group.project_id, type: group.type,
      kernelConversationID: group.kernel_conv_id },
    membership: [{ memberID: viewer.member_id, memberType: viewer.member_type, role: viewer.role, joinedAt: viewer.joined_at }],
    intent: null, event: null,
    reader: { ...reader, sequence: row.source.sequence, deliveryCursor: row.source.delivery_cursor,
      receivedAt: first.receivedAt, sourceExpiresAt: first.sourceExpiresAt },
  }
})
