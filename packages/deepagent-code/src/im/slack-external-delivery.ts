export * as SlackExternalDelivery from "./slack-external-delivery"

import { IMExternalDelivery } from "@deepagent-code/core/im/external-delivery"
import { Effect, Layer, Option, Schema } from "effect"

const SlackResponse = Schema.Struct({ ok: Schema.Boolean })
const decodeResponse = Schema.decodeUnknownOption(SlackResponse)

export const layer = Layer.succeed(
  IMExternalDelivery.Service,
  IMExternalDelivery.Service.of({
    send: (input) => {
      const token = process.env.SLACK_BOT_TOKEN
      if (!token)
        return Effect.fail(new IMExternalDelivery.DeliveryFailed({ provider: "slack", reason: "token_unavailable" }))

      return Effect.tryPromise({
        try: async () => {
          const response = await fetch("https://slack.com/api/chat.postMessage", {
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
