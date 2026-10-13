export * as IMTaskResultDispatch from "./task-result-dispatch"

import { Effect, Layer } from "effect"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { KernelDeliverySchema } from "@deepagent-code/core/im/kernel-delivery.schema"

const unavailable = () => Effect.fail(new KernelDeliverySchema.Error({ code: "KERNEL_DELIVERY_UNAVAILABLE", message: "Restricted IM result dispatch is retired" }))

/** Historical interface only. Old results never create a transport authorization. */
export const make = Effect.succeed({
  prepare: (_binding, _owner) => unavailable(),
  verify: (_tx, _input) => unavailable(),
} satisfies KernelDelivery.TaskResultDispatch)
export const layer = Layer.effect(KernelDelivery.TaskResultDispatch, make)
