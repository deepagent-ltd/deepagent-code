export * as IMRemoteTaskResult from "./remote-task-result"

import { and, eq, isNull, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "@deepagent-code/core/database/database"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { IMKernelReaderMessageTable, IMKernelReaderScopeTable } from "@deepagent-code/core/im/kernel-reader.sql"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { IMKernelDeliveryTable } from "@deepagent-code/core/im/kernel-delivery.sql"
import { GroupTable, MemberTable, MessageTable } from "@deepagent-code/core/im/sql"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { IMTaskResult } from "./task-result"

export const Tuple = Schema.Struct({
  version: Schema.Literal(1),
  realm: KernelReaderSchema.Binding.fields.realm,
  appkey: KernelReaderSchema.Binding.fields.appkey,
  orgID: KernelReaderSchema.Decimal,
  kernelMessageID: KernelReaderSchema.text(512),
  senderID: KernelReaderSchema.text(512),
  receiverID: KernelReaderSchema.text(2048),
  conversationType: Schema.Literals([1, 2]),
  conversationID: KernelReaderSchema.text(512),
})
export type Tuple = typeof Tuple.Type
const common = { version: Schema.Literal(1), messageID: Schema.String, groupID: Schema.String }
export const Locator = Schema.Union([
  Schema.Struct({ ...common, state: Schema.Literal("available"), tuple: Tuple }),
  Schema.Struct({ ...common, state: Schema.Literal("unavailable"), code: Schema.Literal("remote_result_unlinked") }),
])
export type Locator = typeof Locator.Type
export const Lookup = Schema.Union([
  IMTaskResult.Result.members[0],
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("unavailable"),
    code: Schema.Literals(["remote_result_unlinked", "result_changed", "placement_unavailable"]),
  }),
])
export type Lookup = typeof Lookup.Type
const digest = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
const unavailable = (code: Extract<Lookup, { state: "unavailable" }>["code"] = "remote_result_unlinked"): Lookup => ({
  version: 1,
  state: "unavailable",
  code,
})

/** A transport locator is an indexed hint, never a grant or a URL. Only the original
 * protected message under the current reader's Output can supply this immutable tuple. */
export const locator = Effect.fn("IMRemoteTaskResult.locator")(function* (
  db: Database.Interface["db"],
  input: IMTaskResult.ReadScope,
) {
  const predicate = yield* KernelReader.messagePredicate(db)
  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const visible = yield* tx
          .select({
            message: MessageTable,
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
              sql`${MessageTable.id}=${input.messageID}`,
              eq(GroupTable.workspace_id, input.workspaceID),
              isNull(GroupTable.deleted_at),
              isNull(MessageTable.deleted_at),
            ),
          )
          .get()
        if (!visible) return undefined
        const rejected: Locator = {
          version: 1,
          messageID: visible.message.id,
          groupID: visible.message.group_id,
          state: "unavailable",
          code: "remote_result_unlinked",
        }
        if (visible.ordinary || visible.message.type !== "text") return rejected
        const permitted = yield* tx
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(and(eq(MessageTable.id, visible.message.id), predicate))
          .get()
        if (!permitted) return rejected
        yield* KernelReader.verifyMessage(db, visible.message)
        const original = yield* tx
          .select({ message: IMKernelReaderMessageTable, scope: IMKernelReaderScopeTable })
          .from(IMKernelReaderMessageTable)
          .innerJoin(
            IMKernelReaderScopeTable,
            eq(IMKernelReaderScopeTable.reader_key, IMKernelReaderMessageTable.reader_key),
          )
          .where(eq(IMKernelReaderMessageTable.local_message_id, visible.message.id))
          .get()
        if (
          !original ||
          original.message.storage_state !== "present" ||
          original.message.owns_message !== 1 ||
          original.message.sender_id !== visible.message.sender_id ||
          original.scope.workspace_id !== input.workspaceID
        )
          return rejected
        const binding = Schema.decodeUnknownOption(Schema.fromJsonString(KernelReaderSchema.Binding), {
          onExcessProperty: "error",
        })(original.scope.binding)
        const metadata = Schema.decodeUnknownOption(Schema.fromJsonString(KernelReaderSchema.MessageMetadata), {
          onExcessProperty: "error",
        })(original.message.metadata)
        if (
          Option.isNone(binding) ||
          Option.isNone(metadata) ||
          metadata.value.isSend ||
          (metadata.value.messageType !== undefined && metadata.value.messageType !== "jg:text") ||
          digest(original.scope.binding) !== original.scope.binding_hash ||
          binding.value.workspaceID !== input.workspaceID ||
          binding.value.scopeKey !== original.scope.scope_key
        )
          return rejected
        const tuple = Schema.decodeUnknownOption(Tuple, { onExcessProperty: "error" })({
          version: 1,
          realm: binding.value.realm,
          appkey: binding.value.appkey,
          orgID: binding.value.orgID,
          kernelMessageID: original.message.message_id,
          senderID: original.message.sender_id,
          receiverID: binding.value.userID,
          conversationType: original.message.conversation_type,
          conversationID: original.message.target_id,
        })
        if (Option.isNone(tuple)) return rejected
        // The native proof window may expire during local SQL reads; never extend or refresh it.
        yield* KernelReader.verifyMessage(db, visible.message)
        return {
          version: 1 as const,
          messageID: visible.message.id,
          groupID: visible.message.group_id,
          state: "available" as const,
          tuple: tuple.value,
        }
      }),
    )
    .pipe(
      Effect.catch((error) =>
        Effect.fail(
          new IMTaskResult.StorageError({
            code: "task_result_unavailable",
            message:
              error instanceof KernelReaderSchema.Error
                ? "Current remote result visibility is unavailable"
                : "Remote result locator storage is unavailable",
          }),
        ),
      ),
    )
})

/** The selected B connection authenticates this lookup. Caller tuple bytes locate at most
 * two ACK candidates; B's original receipt, owned result and current visibility decide access. */
export const lookup = Effect.fn("IMRemoteTaskResult.lookup")(function* (
  db: Database.Interface["db"],
  input: Omit<IMTaskResult.ReadScope, "messageID"> & { tuple: Tuple },
) {
  const decoded = Schema.decodeUnknownOption(Tuple, { onExcessProperty: "error" })(input.tuple)
  if (Option.isNone(decoded)) return unavailable()
  const tuple = decoded.value
  const candidates = yield* db
    .select({ messageID: IMKernelDeliveryTable.message_id })
    .from(IMKernelDeliveryTable)
    .where(
      and(
        eq(IMKernelDeliveryTable.kernel_message_id, tuple.kernelMessageID),
        eq(IMKernelDeliveryTable.state, "acknowledged"),
      ),
    )
    .limit(2)
    .all()
    .pipe(
      Effect.mapError(
        () =>
          new IMTaskResult.StorageError({
            code: "task_result_unavailable",
            message: "Remote result receipt storage is unavailable",
          }),
      ),
    )
  if (candidates.length !== 1) return unavailable()
  const receipt = yield* KernelDelivery.read(db, candidates[0].messageID).pipe(
    Effect.mapError(
      () =>
        new IMTaskResult.StorageError({
          code: "task_result_unavailable",
          message: "Original result receipt is unavailable",
        }),
    ),
  )
  if (
    !receipt ||
    receipt.state !== "acknowledged" ||
    receipt.kernel_message_id !== tuple.kernelMessageID ||
    receipt.binding.workspaceID !== input.workspaceID ||
    receipt.binding.source.realm !== tuple.realm ||
    receipt.binding.source.appkey !== tuple.appkey ||
    receipt.binding.source.orgID === null ||
    String(receipt.binding.source.orgID) !== tuple.orgID ||
    receipt.binding.source.senderID !== tuple.senderID ||
    receipt.binding.conversationType !== tuple.conversationType ||
    receipt.binding.conversationID !== (tuple.conversationType === 1 ? tuple.receiverID : tuple.conversationID)
  )
    return unavailable()
  const result = yield* IMTaskResult.read(db, {
    messageID: receipt.message_id,
    workspaceID: input.workspaceID,
    userID: input.userID,
    directory: input.directory,
    instanceID: input.instanceID,
  })
  if (!result) return unavailable()
  return result.state === "available"
    ? result
    : unavailable(result.code === "not_task_result" ? "remote_result_unlinked" : result.code)
})
