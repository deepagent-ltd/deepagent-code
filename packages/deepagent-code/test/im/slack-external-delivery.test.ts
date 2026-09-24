import { expect, test } from "bun:test"
import { IMExternalDelivery } from "@deepagent-code/core/im/external-delivery"
import { Effect } from "effect"
import { SlackExternalDelivery } from "../../src/im/slack-external-delivery"

test("revoking every bot binding rejects a stale persisted Slack target before network access", async () => {
  const bindings = process.env.SLACK_IM_BINDINGS
  const token = process.env.SLACK_BOT_TOKEN
  process.env.SLACK_IM_BINDINGS = "[]"
  delete process.env.SLACK_BOT_TOKEN
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const delivery = yield* IMExternalDelivery.Service
        return yield* delivery.send({
          target: { provider: "slack", groupID: "img_old", channelID: "C_OLD" },
          messageID: "imsg_old",
          text: "do not publish after revocation",
        })
      }).pipe(
        Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "sent" }),
        Effect.provide(SlackExternalDelivery.layer),
      ),
    )
    expect(result).toBe("binding_not_configured")
  } finally {
    if (bindings === undefined) delete process.env.SLACK_IM_BINDINGS
    else process.env.SLACK_IM_BINDINGS = bindings
    if (token === undefined) delete process.env.SLACK_BOT_TOKEN
    else process.env.SLACK_BOT_TOKEN = token
  }
})

test("outbound projection follows the current bot channel binding", async () => {
  const bindings = process.env.SLACK_IM_BINDINGS
  const token = process.env.SLACK_BOT_TOKEN
  const calls: string[] = []
  const layer = SlackExternalDelivery.layerWith(async (_url, init) => {
    calls.push(String(init?.body))
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
  })
  const send = (channelID: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const delivery = yield* IMExternalDelivery.Service
        return yield* delivery.send({
          target: { provider: "slack", groupID: "img_team", channelID },
          messageID: "imsg_team",
          text: "safe update",
        })
      }).pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "sent" }), Effect.provide(layer)),
    )
  process.env.SLACK_BOT_TOKEN = "test-token"
  process.env.SLACK_IM_BINDINGS = JSON.stringify([
    { workspaceID: "wrk_team", groupID: "img_team", channelID: "C_NEW", agent: "build" },
  ])
  try {
    expect(await send("C_OLD")).toBe("binding_not_configured")
    expect(calls).toHaveLength(0)
    expect(await send("C_NEW")).toBe("sent")
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0] ?? "{}")).toMatchObject({ channel: "C_NEW", text: "safe update" })

    process.env.SLACK_IM_BINDINGS = "[]"
    expect(await send("C_NEW")).toBe("binding_not_configured")
    expect(calls).toHaveLength(1)
  } finally {
    if (bindings === undefined) delete process.env.SLACK_IM_BINDINGS
    else process.env.SLACK_IM_BINDINGS = bindings
    if (token === undefined) delete process.env.SLACK_BOT_TOKEN
    else process.env.SLACK_BOT_TOKEN = token
  }
})
