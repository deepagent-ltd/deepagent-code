export * as KernelTaskSourceWitness from "./task-source-witness"

import { Effect } from "effect"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import type { KernelClient } from "./client"
import type { KernelSdk } from "./sdk"
import type { IMKernelExchange } from "./exchange"

export type Current = Readonly<{
  descriptor: KernelReader.TaskSourceDescriptor
  nativeMessageHash: string
  readCutServerNow: number
  messageServerNow: number
  inspectedOrgID: number
  receiverID: string
  senderID: string
}>

/** Captured by the original scoped reader factory. Inputs are its real SDK and
 * request gate, never serialized claims or a constructor accepting native facts. */
export const make = (input: {
  runtime: KernelReader.Runtime
  client: KernelClient.Interface
  request: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | KernelReaderSchema.Error>
  query: <A>(effect: Effect.Effect<A, KernelSdk.KernelError>) => Effect.Effect<A, KernelReaderSchema.Error>
  ownerCurrent: () => boolean
  inspectConversation?: (
    request: IMKernelExchange.InspectConversationInput,
  ) => Effect.Effect<IMKernelExchange.InspectConversationPayload, IMKernelExchange.ExchangeError>
}) => {
  return {
    capture: (_messageID: string): Effect.Effect<object, KernelReaderSchema.Error> => Effect.fail(KernelReaderSchema.failure("reader_unavailable", "retired-task-source")),
    read: (_handle: object): Current | undefined => undefined,
    assert: (_handle: object): Effect.Effect<void, KernelReaderSchema.Error> => Effect.fail(KernelReaderSchema.failure("reader_unavailable", "retired-task-source")),
  }
}
