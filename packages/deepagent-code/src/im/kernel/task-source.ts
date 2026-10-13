export * as KernelTaskSource from "./task-source"

import { Context, Effect, Layer } from "effect"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import type { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import type { LocalTaskAuth } from "@deepagent-code/core/im/local-task-auth"
import type { KernelReceiverMapping } from "@deepagent-code/core/im/kernel-receiver-mapping"
import type { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import type { IMFacade } from "../facade"

const unavailable = () => LocalOperator.failure("LOCAL_TASK_SOURCE_UNAVAILABLE", "Restricted IM task sources are retired")
const verifier: NonNullable<Context.Service.Shape<typeof LocalTaskAuth.KernelSource>> = { verify: () => unavailable() }

/** Compatibility types for historical readers. No reader capture or permission witness exists. */
export const make = Effect.succeed({
  verifier,
  bindFacade: (_facade: Pick<IMFacade.Interface, "engine">) => Effect.void,
  prepareMessage: (_input: { messageID: string; workspaceID?: string; fresh?: boolean }): Effect.Effect<void, LocalOperatorSchema.Error> => unavailable(),
  prepareWork: (_work: WorkAuthority.Work, _options?: { readonly fresh?: boolean }): Effect.Effect<void, LocalOperatorSchema.Error> => unavailable(),
  conversationTarget: (_tx: WorkAuthority.Transaction, _input: { groupID: string; workspaceID: string }):
    Effect.Effect<Effect.Success<ReturnType<typeof KernelReceiverMapping.requireCurrent>>, LocalOperatorSchema.Error> => unavailable(),
})
export type Interface = Effect.Success<typeof make>
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/im/kernel/TaskSource") {}
export const layer = Layer.effect(Service, make)
