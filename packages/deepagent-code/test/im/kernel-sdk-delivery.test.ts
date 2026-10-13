import { expect, test } from "bun:test"

await import("@/im/kernel/shims")
const installed = await Bun.file(new URL(import.meta.resolve("jugglechat-websdk"))).text()
// Execute the installed package implementation, exposing its private constructor only in this test module.
const sdk = await import(
  `data:text/javascript;base64,${Buffer.from(`${installed}\nexport { Message$1 as AuditMessage };`).toString("base64")}`
)

test("installed SDK preserves an explicit durable wire ID after successful ACK and in a fresh client", async () => {
  const received: Array<{ tid: string; clientMsgId: string }> = []
  const client = () =>
    sdk.AuditMessage(
      {
        on: () => {},
        getCurrentUser: () => ({ id: "alice" }),
        isConnected: () => true,
        getConfig: () => ({ isPC: true }),
        emit: () => {},
        sendCommand: (
          _command: unknown,
          input: { tid: string; clientMsgId: string },
          callback: (ack: unknown) => void,
        ) => {
          received.push({ tid: input.tid, clientMsgId: input.clientMsgId })
          callback({ code: 0, messageId: "kernel-fixture", sentTime: Date.now(), msgIndex: 1 })
        },
      },
      { emit: () => {} },
      { info: () => {} },
    ) as { sendMessage: (input: unknown) => Promise<unknown> }
  const message = {
    tid: "imsg_complete-persisted-message-id",
    clientMsgId: "dac_persisted-wire-id",
    conversationType: 1,
    conversationId: "bob",
    name: "jg:text",
    content: { content: "fixture" },
    lifeTime: 60000,
  }
  const first = client()
  await first.sendMessage({ ...message })
  await first.sendMessage({ ...message })
  await client().sendMessage({ ...message })
  expect(received).toEqual(Array.from({ length: 3 }, () => ({ tid: message.tid, clientMsgId: message.clientMsgId })))
  // Wire identity stability is not a durable remote receipt: the SDK still emits every requested send.
  expect(received).toHaveLength(3)
})
