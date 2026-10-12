export * as IMRemoteDeliveryLocator from "./remote-delivery-locator"

import { and, eq } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "@deepagent-code/core/database/database"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { IMKernelDeliveryTable } from "@deepagent-code/core/im/kernel-delivery.sql"
import { IMRemoteTaskResult } from "./remote-task-result"

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("IMRemoteDeliveryLocator.StorageError", {
  code: Schema.Literal("remote_delivery_unavailable"),
  message: Schema.String,
}) {}

/** This is only an indexed receipt locator. The selected connection must separately
 * authenticate the caller and read its original resource under current visibility. */
export const resolveMessage = Effect.fn("IMRemoteDeliveryLocator.resolveMessage")(function* (
  db: Database.Interface["db"], input: { workspaceID: string; tuple: IMRemoteTaskResult.Tuple },
) {
  const decoded = Schema.decodeUnknownOption(IMRemoteTaskResult.Tuple, { onExcessProperty: "error" })(input.tuple)
  if (Option.isNone(decoded)) return undefined
  const tuple = decoded.value
  // A direct message is addressed by its sender in the receiving conversation.
  if (tuple.conversationType === 1 && tuple.conversationID !== tuple.senderID) return undefined
  const candidates = yield* db.select({ messageID: IMKernelDeliveryTable.message_id }).from(IMKernelDeliveryTable)
    .where(and(eq(IMKernelDeliveryTable.kernel_message_id, tuple.kernelMessageID),
      eq(IMKernelDeliveryTable.state, "acknowledged"))).limit(2).all().pipe(Effect.mapError(() =>
      new StorageError({ code: "remote_delivery_unavailable", message: "Original delivery index is unavailable" })))
  if (candidates.length !== 1) return undefined
  const receipt = yield* KernelDelivery.read(db, candidates[0].messageID).pipe(Effect.mapError(() =>
    new StorageError({ code: "remote_delivery_unavailable", message: "Original delivery receipt is unavailable" })))
  if (!receipt || receipt.state !== "acknowledged" || receipt.binding.version !== 1 ||
    receipt.kernel_message_id !== tuple.kernelMessageID || receipt.binding.workspaceID !== input.workspaceID ||
    receipt.binding.source.realm !== tuple.realm || receipt.binding.source.appkey !== tuple.appkey ||
    receipt.binding.source.orgID === null || String(receipt.binding.source.orgID) !== tuple.orgID ||
    receipt.binding.source.senderID !== tuple.senderID || receipt.binding.conversationType !== tuple.conversationType ||
    receipt.binding.conversationID !== (tuple.conversationType === 1 ? tuple.receiverID : tuple.conversationID)) return undefined
  return receipt.message_id
})
