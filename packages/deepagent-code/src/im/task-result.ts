export * as IMTaskResult from "./task-result"

import { and, eq, isNull, sql } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import type { Database } from "@deepagent-code/core/database/database"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "@deepagent-code/core/context-federation/sql"
import { SessionActivityTable } from "@deepagent-code/core/context-federation/session-sql"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { IMKernelReaderMessageTable, IMKernelReaderProjectionTable, IMKernelReaderScopeTable } from "@deepagent-code/core/im/kernel-reader.sql"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { GroupTable, MemberTable, MessageTable } from "@deepagent-code/core/im/sql"
import { IMTaskAuthoritySchema } from "@deepagent-code/core/im/task-authority.schema"
import { IMTaskGrantTable, IMTaskRequestTable, IMTaskSourceTable } from "@deepagent-code/core/im/task-authority.sql"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkExecutionTable } from "@deepagent-code/core/session/work-authority.sql"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { IMReplyOutbox } from "./im-reply-outbox"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const common = { version: Schema.Literal(1), messageID: Text, groupID: Text }
export const Result = Schema.Union([
  Schema.Struct({
    ...common,
    state: Schema.Literal("available"),
    placement: Schema.Struct({
      instanceID: Text,
      securityNamespaceID: Text,
      projectID: Text,
      directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
      workspaceID: Schema.NullOr(Text),
      sessionID: Text,
    }),
    attempt: Schema.Struct({
      requestID: Text,
      workID: Text,
      inputID: Text,
      ordinal: Schema.Literal(1),
      outcome: Schema.Literals(["succeeded", "failed"]),
    }),
  }),
  Schema.Struct({
    ...common,
    state: Schema.Literal("unavailable"),
    code: Schema.Literals(["not_task_result", "remote_result_unlinked", "result_changed", "placement_unavailable"]),
  }),
])
export type Result = typeof Result.Type
export class StorageError extends Schema.ErrorClass<StorageError>("IMTaskResult.StorageError")({
  code: Schema.Literal("task_result_unavailable"),
  message: Schema.String,
}) {}

export type ReadScope = {
  messageID: string
  workspaceID: string
  userID: string
  directory: string
  instanceID: string
}

const candidate = Schema.Struct({ type: Schema.Literal("agent_run"), sessionID: Text })
const sourceSnapshot = Schema.Struct({ message: Schema.Unknown, group: Schema.Unknown,
  reader: Schema.optional(Schema.Struct({ ...IMTaskAuthoritySchema.ReaderSource.fields,
    sequence: KernelReaderSchema.Positive, deliveryCursor: KernelReaderSchema.Positive,
    receivedAt: KernelReaderSchema.Time, sourceExpiresAt: KernelReaderSchema.Time })),
})
const digest = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))

/** The authenticated HTTP owner supplies this scope; metadata supplies only an indexed candidate.
 * History visibility is independent of an expired execution grant. No execution service is used. */
export const read = Effect.fn("IMTaskResult.read")(function* (db: Database.Interface["db"], input: ReadScope) {
  const visibleMessage = yield* KernelReader.messagePredicate(db)
  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const visible = yield* tx
          .select({
            message: MessageTable,
            group: GroupTable,
            ordinary: sql<number>`CASE WHEN ${KernelReader.ordinaryGroup} THEN 1 ELSE 0 END`,
          })
          .from(MessageTable)
          .innerJoin(GroupTable, eq(GroupTable.id, MessageTable.group_id))
          .innerJoin(
            MemberTable,
            and(
              eq(MemberTable.group_id, GroupTable.id),
              eq(MemberTable.member_id, input.userID),
              eq(MemberTable.member_type, "user"),
            ),
          )
          .where(
            and(
              sql`${MessageTable.id} = ${input.messageID}`,
              eq(GroupTable.workspace_id, input.workspaceID),
              isNull(GroupTable.deleted_at),
              isNull(MessageTable.deleted_at),
            ),
          )
          .get()
        if (!visible) return undefined
        const unavailable = (code: Extract<Result, { state: "unavailable" }>["code"]): Result => ({
          version: 1,
          messageID: visible.message.id,
          groupID: visible.group.id,
          state: "unavailable",
          code,
        })
        if (!visible.ordinary) {
          const permitted = yield* tx.select({ id: MessageTable.id }).from(MessageTable)
            .where(and(eq(MessageTable.id, visible.message.id), visibleMessage)).get()
          if (!permitted) return unavailable("remote_result_unlinked")
          yield* KernelReader.verifyMessage(db, visible.message)
        }
        if (visible.message.sender_type !== "agent" || visible.message.type !== "text")
          return unavailable(visible.ordinary ? "not_task_result" : "remote_result_unlinked")
        const hint = Schema.decodeUnknownOption(candidate)(visible.message.metadata)
        if (Option.isNone(hint)) return unavailable(visible.ordinary ? "not_task_result" : "remote_result_unlinked")

        // Both joins use existing unique indices. Old messages are not restricted to a recent page.
        const matches = yield* tx
          .select({
            outbox: IMReplyOutbox.IMReplyOutboxTable,
            grant: IMTaskGrantTable,
            request: IMTaskRequestTable,
            source: IMTaskSourceTable,
            work: WorkExecutionTable,
          })
          .from(WorkExecutionTable)
          .innerJoin(IMTaskGrantTable, eq(IMTaskGrantTable.work_id, WorkExecutionTable.work_id))
          .innerJoin(IMTaskRequestTable, eq(IMTaskRequestTable.request_id, IMTaskGrantTable.request_id))
          .innerJoin(IMTaskSourceTable, eq(IMTaskSourceTable.source_id, IMTaskRequestTable.source_id))
          .innerJoin(
            IMReplyOutbox.IMReplyOutboxTable,
            eq(IMReplyOutbox.IMReplyOutboxTable.id, IMTaskGrantTable.result_key),
          )
          .where(eq(WorkExecutionTable.session_id, hint.value.sessionID))
          .limit(2)
          .all()
        if (matches.length !== 1) return unavailable(visible.ordinary ? "not_task_result" : "remote_result_unlinked")
        const result = matches[0]
        if (!visible.ordinary && visible.message.id !== `imsg_reply_${contentDigest(result.outbox.id).slice(0, 40)}`)
          return unavailable("remote_result_unlinked")
        if (!resultIdentity(visible.message, visible.group, result)) return unavailable("result_changed")
        const binding = WorkAuthorityPolicy.validateBinding(result.work.binding)
        const proof = Schema.decodeUnknownOption(IMTaskAuthoritySchema.SourceProof, { onExcessProperty: "error" })(
          result.source.proof,
        )
        const target = Schema.decodeUnknownOption(IMTaskAuthoritySchema.Target, { onExcessProperty: "error" })(
          result.request.target,
        )
        const principal = Schema.decodeUnknownOption(IMTaskAuthoritySchema.Principal, { onExcessProperty: "error" })(
          result.grant.principal,
        )
        const targetProof = Schema.decodeUnknownOption(IMTaskAuthoritySchema.TargetProof, {
          onExcessProperty: "error",
        })(result.grant.target_proof)
        const snapshot = Schema.decodeUnknownOption(sourceSnapshot)(result.source.snapshot)
        if (
          !binding.ok ||
          Option.isNone(proof) ||
          Option.isNone(target) ||
          Option.isNone(principal) ||
          Option.isNone(targetProof) ||
          Option.isNone(snapshot) ||
          !historyIdentity(result, binding.value, proof.value, target.value)
        )
          return unavailable("result_changed")
        if (visible.ordinary ? proof.value.origin !== "local" : proof.value.origin !== "kernel_live" || !proof.value.reader)
          return unavailable("remote_result_unlinked")

        const original = yield* tx
          .select()
          .from(MessageTable)
          .where(sql`${MessageTable.id} = ${result.source.message_id}`)
          .get()
        if (
          !original ||
          original.deleted_at !== null ||
          original.sender_type !== "user" ||
          original.type !== "text" ||
          original.reply_to_id !== null ||
          original.group_id !== visible.group.id ||
          original.sender_id !== proof.value.senderID ||
          digest(snapshot.value.message) !==
            digest({
              id: original.id,
              groupID: original.group_id,
              senderID: original.sender_id,
              senderType: original.sender_type,
              type: original.type,
              content: original.content,
              mentions: original.mentions,
              metadata: original.metadata,
              kernelMessageID: visible.ordinary ? original.kernel_msg_id : proof.value.kernelMessageID,
              eventID: original.event_id,
              createdAt: original.created_at,
            }) ||
          digest(snapshot.value.group) !==
            digest({
              id: visible.group.id,
              workspaceID: visible.group.workspace_id,
              projectID: visible.group.project_id,
              type: visible.group.type,
              kernelConversationID: visible.group.kernel_conv_id,
            })
        )
          return unavailable("result_changed")

        if (!visible.ordinary && !(yield* kernelHistoryIdentity(tx, original, visible.group, visible.message, proof.value, snapshot.value)))
          return unavailable("result_changed")

        const placed = yield* tx
          .select({
            session: SessionTable,
            namespace: SecurityNamespaceTable,
            location: LocationIdentityTable,
            project: ProjectScopeIdentityTable,
            input: SessionInputTable,
          })
          .from(SessionTable)
          .innerJoin(SecurityNamespaceTable, eq(SecurityNamespaceTable.id, binding.value.scope.securityNamespaceID))
          .innerJoin(
            ProjectScopeIdentityTable,
            and(
              eq(ProjectScopeIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
              eq(ProjectScopeIdentityTable.project_scope_key, binding.value.scope.projectScopeKey),
            ),
          )
          .innerJoin(
            LocationIdentityTable,
            and(
              eq(LocationIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
              eq(LocationIdentityTable.project_scope_key, ProjectScopeIdentityTable.project_scope_key),
              sql`${LocationIdentityTable.canonical_root} = ${binding.value.location.directory}`,
            ),
          )
          .innerJoin(
            SessionInputTable,
            and(
              sql`${SessionInputTable.id} = ${result.work.input_id}`,
              eq(SessionInputTable.session_id, SessionTable.id),
            ),
          )
          .where(sql`${SessionTable.id} = ${result.work.session_id}`)
          .get()
        if (!placed || !placementIdentity(input, result, binding.value, proof.value, target.value, placed))
          return unavailable("placement_unavailable")
        const activities = yield* tx
          .select()
          .from(SessionActivityTable)
          .where(
            and(
              eq(SessionActivityTable.session_id, placed.session.id),
              eq(SessionActivityTable.trigger_input_id, placed.input.id),
            ),
          )
          .limit(2)
          .all()
        const outcome = result.work.outcome
        if (activities.length !== 1 || (outcome !== "succeeded" && outcome !== "failed"))
          return unavailable("result_changed")
        const activity = activities[0]
        if (
          result.outbox.reply_message_id !== (activity.final_message_id ?? result.grant.result_key) ||
          activity.settled_at === null ||
          (result.work.outcome === "succeeded"
            ? activity.state !== "settled" || !activity.final_message_id
            : !["failed", "settled"].includes(activity.state))
        )
          return unavailable("result_changed")
        if (result.work.outcome === "succeeded") {
          const final = yield* tx
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                sql`${SessionMessageTable.id} = ${activity.final_message_id}`,
                eq(SessionMessageTable.session_id, placed.session.id),
              ),
            )
            .get()
          const assistant = Schema.decodeUnknownOption(SessionMessage.Assistant)(
            final && {
              ...final.data,
              id: final.id,
              type: final.type,
            },
          )
          if (
            Option.isNone(assistant) ||
            assistant.value.error ||
            assistant.value.content
              .filter((part) => part.type === "text")
              .map((part) => part.text.trim())
              .filter(Boolean)
              .join("\n\n")
              .trim() !== result.outbox.reply_text
          )
            return unavailable("result_changed")
        }
        if (
          result.work.outcome === "failed" &&
          result.outbox.reply_text !== "任务执行已结束，结果为失败；没有可交付的成功回复。"
        )
          return unavailable("result_changed")
        return {
          version: 1,
          messageID: visible.message.id,
          groupID: visible.group.id,
          state: "available",
          placement: {
            instanceID: input.instanceID,
            securityNamespaceID: placed.namespace.id,
            projectID: placed.session.project_id,
            directory: placed.session.directory,
            workspaceID: placed.session.workspace_id,
            sessionID: placed.session.id,
          },
          attempt: {
            requestID: result.request.request_id,
            workID: result.work.work_id,
            inputID: result.work.input_id,
            ordinal: 1,
            outcome,
          },
        } satisfies Result
      }),
    )
    .pipe(
      Effect.tap(() => KernelReader.assertOutput(db)),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(Cause.fromReasons(cause.reasons.filter(Cause.isInterruptReason)))
          : Effect.fail(
              new StorageError({ code: "task_result_unavailable", message: "Task result storage is unavailable" }),
            ),
      ),
    )
})

type Joined = {
  outbox: typeof IMReplyOutbox.IMReplyOutboxTable.$inferSelect
  grant: typeof IMTaskGrantTable.$inferSelect
  request: typeof IMTaskRequestTable.$inferSelect
  source: typeof IMTaskSourceTable.$inferSelect
  work: typeof WorkExecutionTable.$inferSelect
}

function resultIdentity(
  message: typeof MessageTable.$inferSelect,
  group: typeof GroupTable.$inferSelect,
  result: Joined,
) {
  return (
    message.id === `imsg_reply_${contentDigest(result.outbox.id).slice(0, 40)}` &&
    result.outbox.status === "delivered" &&
    result.outbox.time_delivered !== null &&
    result.outbox.session_id === result.grant.session_id &&
    result.outbox.group_id === group.id &&
    result.outbox.agent_id === message.sender_id &&
    result.outbox.agent_id === result.work.agent_id &&
    result.outbox.reply_text === message.content &&
    message.reply_to_id === null &&
    result.outbox.trigger_message_id === result.source.message_id &&
    result.request.result_key === result.outbox.id &&
    result.grant.result_key === result.outbox.id
  )
}

function historyIdentity(
  result: Joined,
  binding: typeof WorkExecutionTable.$inferSelect.binding,
  proof: IMTaskAuthoritySchema.SourceProof,
  target: IMTaskAuthoritySchema.Target,
) {
  const stable = digest([result.request.instance_id, result.request.request_id, 1])
  return (
    result.source.proof_hash === digest(result.source.proof) &&
    result.source.snapshot_hash === digest(result.source.snapshot) &&
    result.source.source_id ===
      `imsource_${digest([result.source.instance_id, result.source.message_id, result.source.proof_hash])}` &&
    result.request.audited_text_hash === Hash.sha256(result.request.audited_text) &&
    result.request.request_hash ===
      digest({
        sourceID: result.request.source_id,
        sourceProofHash: result.source.proof_hash,
        sourceSnapshotHash: result.source.snapshot_hash,
        instanceID: result.request.instance_id,
        actorID: result.request.actor_id,
        auditedText: result.request.audited_text,
        target: result.request.target,
        expiresAt: result.request.expires_at,
        resultKey: result.request.result_key,
      }) &&
    result.grant.record_hash ===
      digest({
        grantID: result.grant.grant_id,
        requestID: result.grant.request_id,
        principal: result.grant.principal,
        targetProof: result.grant.target_proof,
        sourceProofHash: result.grant.source_proof_hash,
        sourceSnapshotHash: result.grant.source_snapshot_hash,
        requestHash: result.grant.request_hash,
        binding: result.grant.binding,
        acceptRequestID: result.grant.accept_request_id,
        acceptExpectedRevision: result.grant.accept_expected_revision,
        createdAt: result.grant.created_at,
        expiresAt: result.grant.expires_at,
      }) &&
    result.grant.ordinal === 1 &&
    result.request.request_id ===
      `imreq_${digest([result.request.instance_id, result.request.actor_id, result.request.client_request_id])}` &&
    result.request.result_key === `imresult_${digest([result.request.request_id, 1])}` &&
    result.grant.grant_id === `imgrant_${digest([result.request.request_id, 1])}` &&
    result.grant.source_proof_hash === result.source.proof_hash &&
    result.grant.source_snapshot_hash === result.source.snapshot_hash &&
    result.grant.request_hash === result.request.request_hash &&
    result.grant.instance_id === result.request.instance_id &&
    result.source.instance_id === result.request.instance_id &&
    proof.instanceID === result.source.instance_id &&
    result.grant.principal.instanceID === result.grant.instance_id &&
    result.grant.actor_id === result.request.actor_id &&
    result.grant.principal.actorID === result.request.actor_id &&
    target.scope.actorID === result.request.actor_id &&
    digest(target) === result.grant.target_proof.targetHash &&
    result.request.state === "accepted" &&
    digest(binding) === digest(result.grant.binding) &&
    result.work.binding_hash === WorkAuthorityPolicy.fingerprint(binding) &&
    binding.source.kind === "server_operator" &&
    binding.source.authorityRevision === 1 &&
    binding.source.authorityID === result.grant.grant_id &&
    binding.source.authorityRevision === result.work.source_revision &&
    binding.source.sourceID === result.source.source_id &&
    binding.source.requestID === result.request.request_id &&
    binding.source.requestHash === result.request.request_hash &&
    result.work.authority_id === result.grant.grant_id &&
    result.work.source_record_hash === result.grant.record_hash &&
    result.work.source_request_id === result.request.request_id &&
    result.work.source_kind === "server_operator" &&
    result.work.session_id === result.grant.session_id &&
    result.work.input_id === result.grant.input_id &&
    binding.sessionID === result.grant.session_id &&
    binding.inputID === result.grant.input_id &&
    binding.workID === result.grant.work_id &&
    binding.workID === result.work.work_id &&
    binding.workID === `imwork_${stable}` &&
    binding.sessionID === `ses_imtask_${stable}` &&
    binding.inputID === `msg_imtask_${stable}` &&
    binding.attemptKey === `imattempt_${stable}` &&
    binding.rootWorkID === binding.workID &&
    result.work.root_work_id === binding.workID &&
    result.work.parent_work_id === null &&
    result.work.admission_state === "ready" &&
    binding.auditedText.hash === result.request.audited_text_hash &&
    binding.auditedText.utf8Bytes === Buffer.byteLength(result.request.audited_text) &&
    digest(binding.location) === digest(target.location) &&
    digest(binding.scope) === digest(target.scope) &&
    binding.agentID === target.agentID &&
    binding.agentID === result.work.agent_id &&
    digest(binding.profile) === digest(target.profile) &&
    digest(binding.provider) === digest(target.provider) &&
    digest(binding.budget) === digest(target.budget) &&
    binding.deadline === result.grant.expires_at &&
    (!("version" in target) ||
      (binding.schemaVersion === "work-execution.v2" &&
        digest(binding.projectScope) === digest(target.projectScope) &&
        digest(binding.contextPolicy) === digest(target.contextPolicy) &&
        digest(binding.toolPolicy) === digest(target.toolPolicy) &&
        digest(binding.childPolicy) === digest(target.childPolicy))) &&
    (proof.origin === "local" ?
      proof.conversationType === "local" && proof.conversationID === result.outbox.group_id &&
      proof.kernelMessageID === null && proof.realmID === null && proof.appkeyID === null && proof.orgID === null :
      proof.origin === "kernel_live" && !!proof.reader && proof.conversationType !== "local" &&
      proof.kernelMessageID !== null && proof.realmID !== null && proof.appkeyID !== null && proof.orgID !== null)
  )
}

/** Historical fixed identity only. Current reader output authenticates visibility independently;
 * this does not renew the old source, enrollment, grant, or execution permission. */
function kernelHistoryIdentity(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  original: typeof MessageTable.$inferSelect,
  group: typeof GroupTable.$inferSelect,
  message: typeof MessageTable.$inferSelect,
  proof: IMTaskAuthoritySchema.SourceProof,
  snapshot: typeof sourceSnapshot.Type,
) {
  return Effect.gen(function* () {
    const reader = proof.reader
    if (!reader || !snapshot.reader || proof.intentID !== null || original.kernel_msg_id !== null ||
      original.event_id !== null || group.kernel_conv_id !== `kr1:${reader.bindingKey}` ||
      group.workspace_id !== reader.workspaceID || original.sender_id !== proof.senderID ||
      digest(snapshot.reader) !== digest({ ...reader, sequence: snapshot.reader.sequence,
        deliveryCursor: snapshot.reader.deliveryCursor, receivedAt: snapshot.reader.receivedAt,
        sourceExpiresAt: snapshot.reader.sourceExpiresAt })) return false
    const row = yield* tx.select({ source: IMKernelReaderMessageTable, projection: IMKernelReaderProjectionTable,
      scope: IMKernelReaderScopeTable }).from(IMKernelReaderMessageTable)
      .innerJoin(IMKernelReaderProjectionTable, and(eq(IMKernelReaderProjectionTable.reader_key, IMKernelReaderMessageTable.reader_key),
        eq(IMKernelReaderProjectionTable.binding_key, IMKernelReaderMessageTable.binding_key),
        eq(IMKernelReaderProjectionTable.projection_key, IMKernelReaderMessageTable.projection_key)))
      .innerJoin(IMKernelReaderScopeTable, eq(IMKernelReaderScopeTable.reader_key, IMKernelReaderMessageTable.reader_key))
      .where(and(eq(IMKernelReaderMessageTable.reader_key, reader.readerKey),
        eq(IMKernelReaderMessageTable.effect_key, reader.effectKey), eq(IMKernelReaderMessageTable.local_message_id, original.id))).get()
    if (!row || row.source.storage_state !== "present" || row.source.owns_message !== 1 ||
      row.source.binding_key !== reader.bindingKey || row.source.projection_key !== reader.projectionKey ||
      row.source.immutable_hash !== reader.immutableHash || row.source.message_id !== proof.kernelMessageID ||
      row.source.sender_id !== proof.senderID || row.source.target_id !== proof.conversationID ||
      String(row.source.conversation_type) !== proof.conversationType || row.source.message_time !== original.created_at ||
      row.source.body_hash !== Hash.sha256(original.content) || row.source.body_bytes !== KernelReaderSchema.bytes(original.content) ||
      row.source.sequence !== snapshot.reader.sequence || row.source.delivery_cursor !== snapshot.reader.deliveryCursor ||
      row.projection.visibility !== "visible" || row.projection.local_group_id !== group.id ||
      row.projection.target_id !== proof.conversationID || String(row.projection.conversation_type) !== proof.conversationType ||
      row.scope.scope_key !== reader.scopeKey || row.scope.workspace_id !== reader.workspaceID ||
      row.scope.binding_hash !== KernelReader.hash(row.scope.binding) ||
      row.scope.reader_key !== KernelReader.hash(["deepagent.im.reader.v1", row.scope.binding]) ||
      row.source.immutable_hash !== KernelReader.hash({ reader_key: row.source.reader_key, effect_key: row.source.effect_key,
        binding_key: row.source.binding_key, projection_key: row.source.projection_key, message_id: row.source.message_id,
        sequence: row.source.sequence, delivery_cursor: row.source.delivery_cursor, message_time: row.source.message_time,
        expires_at: row.source.expires_at, sender_id: row.source.sender_id, target_id: row.source.target_id,
        conversation_type: row.source.conversation_type, body_hash: row.source.body_hash, metadata: row.source.metadata })) return false
    const binding = Schema.decodeUnknownOption(Schema.fromJsonString(KernelReaderSchema.Binding))(row.scope.binding)
    const metadata = Schema.decodeUnknownOption(Schema.fromJsonString(KernelReaderSchema.MessageMetadata))(row.source.metadata)
    if (Option.isNone(binding) || Option.isNone(metadata)) return false
    const first = metadata.value.firstSeen
    if (!first || first.origin !== "kernel_live" || first.sourceHash !== reader.sourceHash ||
      first.observationHash !== reader.observationHash || first.receiverID !== proof.receiverID ||
      first.transportGeneration !== proof.generation || first.receivedAt !== snapshot.reader.receivedAt ||
      first.sourceExpiresAt !== snapshot.reader.sourceExpiresAt || first.sourceExpiresAt > row.source.expires_at ||
      metadata.value.isSend || (metadata.value.messageType ?? "jg:text") !== "jg:text" ||
      binding.value.realm !== proof.realmID || binding.value.appkey !== proof.appkeyID || binding.value.orgID !== proof.orgID ||
      binding.value.userID !== proof.receiverID || binding.value.workspaceID !== reader.workspaceID ||
      binding.value.scopeKey !== reader.scopeKey) return false
    const delivery = yield* KernelDelivery.read(tx, message.id)
    return !!delivery && delivery.state === "acknowledged" && delivery.kernel_message_id !== null && message.kernel_msg_id === null &&
      delivery.binding.version === 1 && delivery.binding.groupID === group.id &&
      delivery.binding.workspaceID === reader.workspaceID && delivery.binding.source.realm === proof.realmID &&
      delivery.binding.source.appkey === proof.appkeyID && String(delivery.binding.source.orgID) === proof.orgID &&
      delivery.binding.source.senderID === proof.receiverID &&
      String(delivery.binding.conversationType) === proof.conversationType && delivery.binding.conversationID === proof.conversationID &&
      KernelDelivery.wireMessage(delivery.binding, message) !== undefined
  })
}

function placementIdentity(
  input: ReadScope,
  result: Joined,
  binding: typeof WorkExecutionTable.$inferSelect.binding,
  proof: IMTaskAuthoritySchema.SourceProof,
  target: IMTaskAuthoritySchema.Target,
  placed: {
    session: typeof SessionTable.$inferSelect
    namespace: typeof SecurityNamespaceTable.$inferSelect
    location: typeof LocationIdentityTable.$inferSelect
    project: typeof ProjectScopeIdentityTable.$inferSelect
    input: typeof SessionInputTable.$inferSelect
  },
) {
  return (
    input.instanceID === result.request.instance_id &&
    placed.session.v2_authority &&
    placed.session.directory === input.directory &&
    placed.session.directory === binding.location.directory &&
    binding.scope.workspaceID === input.workspaceID &&
    placed.session.workspace_id === (binding.location.workspaceID ?? null) &&
    placed.session.agent === binding.agentID &&
    placed.session.model?.id === binding.provider.modelID &&
    placed.session.model.providerID === binding.provider.providerID &&
    input.workspaceID === (placed.session.workspace_id ?? placed.session.directory) &&
    placed.namespace.id === proof.securityNamespaceID &&
    placed.namespace.binding_hash === proof.namespaceBindingHash &&
    placed.namespace.retired_at === null &&
    placed.project.retired_at === null &&
    placed.location.retired_at === null &&
    placed.project.observed_project_id === placed.session.project_id &&
    placed.location.observed_project_id === placed.session.project_id &&
    placed.location.workspace_binding === null &&
    placed.namespace.kind === "implicit_local" &&
    placed.input.promoted_seq !== null &&
    placed.input.delivery === "queue" &&
    placed.input.prompt.text === result.request.audited_text &&
    placed.input.admitted_seq === result.work.admitted_seq &&
    result.work.security_namespace_id === placed.namespace.id &&
    (!("version" in target) || target.projectScope.projectID === placed.session.project_id)
  )
}
