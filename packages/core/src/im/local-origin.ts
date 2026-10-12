export * as LocalOrigin from "./local-origin"

import { eq, sql } from "drizzle-orm"
import { Effect, Option } from "effect"
import type { WorkAuthority } from "../session/work-authority"
import type { IMTaskAuthoritySchema } from "./task-authority.schema"
import { LocalOperator } from "./local-operator"
import { LocalTaskPolicy } from "./local-task-policy"
import { LocalOriginReceiptTable } from "./local-operator.sql"
import { MessageTable } from "./sql"

type Tx = WorkAuthority.Transaction
type Message = typeof MessageTable.$inferSelect
const DAY = 86_400_000

/** Called by IMRepository inside the same transaction as a NEW local text row. No retry backfill. */
export const commit = Effect.fn("LocalOrigin.commit")(function* (
  tx: Tx,
  message: Message,
  inserted: boolean,
  now: number,
) {
  const mode = yield* LocalTaskPolicy.lookup(tx, message.group_id)
  if (!mode || !inserted || message.sender_type !== "user" || message.type !== "text" || message.reply_to_id !== null)
    return
  if (Option.isNone(yield* Effect.serviceOption(LocalOperator.Mutation))) return
  const operator = yield* LocalOperator.requireMutation(tx)
  const conversation = yield* LocalTaskPolicy.requireConversation(tx, message.group_id)
  if (message.sender_id !== "server" || message.kernel_msg_id !== null || message.created_at !== now)
    return yield* LocalOperator.failure(
      "LOCAL_TASK_SOURCE_UNAVAILABLE",
      "Only a new authenticated local text message can receive an origin receipt",
    )
  const raw = snapshot(message)
  const values = {
    message_id: message.id,
    instance_id: operator.instance_id,
    operator_id: operator.operator_id,
    operator_revision: operator.revision,
    credential_generation: operator.credential_generation,
    group_id: message.group_id,
    conversation_revision: conversation.revision,
    raw_snapshot: raw,
    raw_snapshot_hash: LocalOperator.hash(raw),
    proof: proofFor(operator, conversation, message),
    origin: "authenticated_local_text" as const,
    received_at: message.created_at,
    expires_at: message.created_at + DAY,
  }
  yield* tx
    .insert(LocalOriginReceiptTable)
    .values({ ...values, receipt_hash: LocalOperator.hash(values) })
    .run()
    .pipe(Effect.orDie)
})

export const verify = Effect.fn("LocalOrigin.verify")(function* (tx: Tx, messageID: string) {
  const operator = yield* LocalOperator.requireCurrent(tx)
  const receipt = yield* tx
    .select()
    .from(LocalOriginReceiptTable)
    .where(eq(LocalOriginReceiptTable.message_id, messageID))
    .get()
    .pipe(Effect.orDie)
  const message = yield* tx
    .select()
    .from(MessageTable)
    .where(sql`${MessageTable.id} = ${messageID}`)
    .get()
    .pipe(Effect.orDie)
  if (
    !receipt ||
    !message ||
    message.deleted_at !== null ||
    message.sender_type !== "user" ||
    message.sender_id !== "server" ||
    message.type !== "text" ||
    message.reply_to_id !== null ||
    message.kernel_msg_id !== null ||
    receipt.instance_id !== operator.instance_id ||
    receipt.operator_id !== operator.operator_id ||
    receipt.operator_revision !== operator.revision ||
    receipt.credential_generation !== operator.credential_generation ||
    receipt.group_id !== message.group_id ||
    receipt.expires_at <= Date.now() ||
    receipt.received_at !== message.created_at ||
    receipt.expires_at !== receipt.received_at + DAY ||
    receipt.origin !== "authenticated_local_text"
  )
    return yield* LocalOperator.failure(
      "LOCAL_TASK_SOURCE_UNAVAILABLE",
      "No current authenticated local origin receipt exists for this message",
    )
  const conversation = yield* LocalTaskPolicy.requireConversation(tx, message.group_id)
  const values = {
    message_id: receipt.message_id,
    instance_id: receipt.instance_id,
    operator_id: receipt.operator_id,
    operator_revision: receipt.operator_revision,
    credential_generation: receipt.credential_generation,
    group_id: receipt.group_id,
    conversation_revision: receipt.conversation_revision,
    raw_snapshot: receipt.raw_snapshot,
    raw_snapshot_hash: receipt.raw_snapshot_hash,
    proof: receipt.proof,
    origin: receipt.origin,
    received_at: receipt.received_at,
    expires_at: receipt.expires_at,
  }
  if (
    receipt.conversation_revision !== conversation.revision ||
    receipt.raw_snapshot_hash !== LocalOperator.hash(snapshot(message)) ||
    receipt.raw_snapshot_hash !== LocalOperator.hash(receipt.raw_snapshot) ||
    receipt.receipt_hash !== LocalOperator.hash(values) ||
    LocalOperator.hash(receipt.proof) !== LocalOperator.hash(proofFor(operator, conversation, message))
  )
    return yield* LocalOperator.failure(
      "LOCAL_TASK_SOURCE_UNAVAILABLE",
      "Local origin receipt, source or conversation policy changed",
    )
  return receipt.proof
})

function snapshot(message: Message) {
  return {
    messageID: message.id,
    groupID: message.group_id,
    senderID: message.sender_id,
    senderType: message.sender_type,
    type: message.type,
    content: message.content,
    mentions: message.mentions,
    metadata: message.metadata,
    replyToID: message.reply_to_id,
    kernelMessageID: message.kernel_msg_id,
    eventID: message.event_id,
    clientRequestID: message.client_request_id,
    createdAt: message.created_at,
  }
}
function proofFor(
  operator: LocalOperator.Record,
  conversation: LocalTaskPolicy.Conversation,
  message: Message,
): IMTaskAuthoritySchema.SourceProof {
  return {
    instanceID: operator.instance_id,
    securityNamespaceID: conversation.target.scope.securityNamespaceID,
    namespaceBindingHash: conversation.namespace_binding_hash,
    realmID: null,
    appkeyID: null,
    orgID: null,
    senderID: "server",
    receiverID: "server",
    conversationType: "local",
    conversationID: message.group_id,
    kernelMessageID: null,
    intentID: null,
    origin: "local",
    revision: operator.revision,
    generation: operator.credential_generation,
    expiresAt: message.created_at + DAY,
    proofHash: LocalOperator.hash({
      version: "authenticated-local-origin.v1",
      operator: LocalOperator.principal(operator),
      conversationID: conversation.group_id,
      conversationRevision: conversation.revision,
      targetHash: conversation.target_hash,
      raw: snapshot(message),
    }),
  }
}
