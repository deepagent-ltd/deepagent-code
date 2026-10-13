export * as IMTaskStatusDispatch from "./task-status-dispatch"

import { Effect, Layer } from "effect"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { KernelDeliverySchema } from "@deepagent-code/core/im/kernel-delivery.schema"

const unavailable = () => Effect.fail(new KernelDeliverySchema.Error({ code: "KERNEL_DELIVERY_UNAVAILABLE", message: "Restricted IM status dispatch is retired" }))

/** Historical interface only. No notice capture, disclosure or send is performed. */
export const make = Effect.succeed({
  prepare: (_binding, _owner) => unavailable(),
  verify: (_tx, _input) => unavailable(),
} satisfies KernelDelivery.TaskStatusDispatch)
export const layer = Layer.effect(KernelDelivery.TaskStatusDispatch, make)
