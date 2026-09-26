export * as IMExternalDelivery from "./external-delivery"

import { Context, Effect, Layer, Schema } from "effect"

export const Target = Schema.Struct({
  provider: Schema.Literal("slack"),
  groupID: Schema.String,
  channelID: Schema.String.check(Schema.isMinLength(1)),
})
export type Target = typeof Target.Type

export class DeliveryFailed extends Schema.TaggedErrorClass<DeliveryFailed>()("IMExternalDelivery.DeliveryFailed", {
  provider: Schema.Literal("slack"),
  reason: Schema.String,
}) {}

export interface Interface {
  readonly send: (input: {
    readonly target: Target
    readonly messageID: string
    readonly text: string
  }) => Effect.Effect<void, DeliveryFailed>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/IMExternalDelivery") {}

// A configured binding without a host adapter is an explicit failed external delivery.
export const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    send: (input) =>
      Effect.fail(new DeliveryFailed({ provider: input.target.provider, reason: "adapter_unavailable" })),
  }),
)
