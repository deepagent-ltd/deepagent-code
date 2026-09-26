export * as SlackExternalDelivery from "./slack-external-delivery"

import { IMExternalDelivery } from "@deepagent-code/core/im/external-delivery"
import { Effect, Layer, Option, Schema } from "effect"

const SlackResponse = Schema.Struct({ ok: Schema.Boolean })
const decodeResponse = Schema.decodeUnknownOption(SlackResponse)
const decodeBindings = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      workspaceID: Schema.String.check(Schema.isMinLength(1)),
      groupID: Schema.String.check(Schema.isMinLength(1)),
      channelID: Schema.String.check(Schema.isMinLength(1)),
      agent: Schema.String.check(Schema.isMinLength(1)),
    }),
  ),
)

export const layerWith = (request: (url: string, init: RequestInit) => Promise<Response> = globalThis.fetch) =>
  Layer.succeed(
    IMExternalDelivery.Service,
    IMExternalDelivery.Service.of({
      send: (input) => {
        // The Slack bot's current allowlist is authoritative even when an old workspace-config
        // channel mapping remains in the durable store after an operator removes a binding.
        const configured = process.env.SLACK_IM_BINDINGS
        if (configured !== undefined) {
          const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(configured))
          const bindings = Option.getOrUndefined(decodeBindings(parsed))
          if (
            !bindings?.some(
              (entry) => entry.groupID === input.target.groupID && entry.channelID === input.target.channelID,
            )
          )
            return Effect.fail(
              new IMExternalDelivery.DeliveryFailed({ provider: "slack", reason: "binding_not_configured" }),
            )
        }

        const token = process.env.SLACK_BOT_TOKEN
        if (!token)
          return Effect.fail(new IMExternalDelivery.DeliveryFailed({ provider: "slack", reason: "token_unavailable" }))

        return Effect.tryPromise({
          try: async () => {
            const response = await request("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({
                channel: input.target.channelID,
                text: input.text,
                parse: "none",
                link_names: false,
              }),
              signal: AbortSignal.timeout(10_000),
            })
            if (!response.ok || !Option.getOrUndefined(decodeResponse(await response.json()))?.ok)
              throw new Error("Slack rejected the message")
          },
          catch: () => new IMExternalDelivery.DeliveryFailed({ provider: "slack", reason: "request_failed" }),
        })
      },
    }),
  )

export const layer = layerWith()
