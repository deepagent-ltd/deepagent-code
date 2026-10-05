// Manual live check for the facade (B2) path — NOT part of the test suite. Bob side: connects to
// the kernel with the FACADE-issued kernel token (POST /api/im/claim), posts to the org all-group,
// mentions alice's agent, and waits for the [Agent·auto] reply to arrive back over the kernel.
// (@auto, not @general: in the V2 roster `general` is mode=subagent — filtered out of mentionable
// visible agents, so it lands the no-declarer receipt; `auto` is the mentionable default primary.)
//
//   env: JUGGLE_APPKEY JUGGLE_NAVIGATOR BOB_KERNEL_TOKEN BOB_UUID ALICE_UUID ORG_GROUP_ID
//   bun script/im-facade-live-bob.ts
//
// Exit 0 = the org-group message acked AND the agent reply (nonce-tagged) arrived from alice.

const need = (key: string): string => {
  const value = process.env[key]
  if (!value) throw new Error(`missing env ${key}`)
  return value
}

const appkey = need("JUGGLE_APPKEY")
const navigator = need("JUGGLE_NAVIGATOR")
const token = need("BOB_KERNEL_TOKEN")
const aliceID = need("ALICE_UUID")
const groupID = need("ORG_GROUP_ID")

await import("../src/im/kernel/shims")
const JuggleIM = (await import("jugglechat-websdk")).default
const im = JuggleIM.init({ appkey, navList: [navigator] })

const fromAlice: string[] = []
im.on(JuggleIM.Event.MESSAGE_RECEIVED, (payload: unknown) => {
  const msg = payload as { sender?: { id?: unknown }; content?: { content?: unknown } }
  if (msg.sender?.id !== aliceID) return
  if (typeof msg.content?.content !== "string") return
  fromAlice.push(msg.content.content)
  console.log(`bob_received text=${JSON.stringify(msg.content.content)}`)
})

const send = async (text: string) => {
  // d.ts 把 conversationType 错标成枚举对象类型（协议实际是 number）——与 sdk.ts 同一处收窄。
  const ack = (await im.sendMessage({
    conversationType: 2,
    conversationId: groupID,
    name: JuggleIM.MessageType.TEXT,
    content: { content: text },
  } as unknown as Parameters<typeof im.sendMessage>[0])) as { messageId?: string }
  console.log(`bob_sent text=${JSON.stringify(text)}`)
  console.log(`bob_ack:${ack.messageId}`)
}

await im.connect({ token })
console.log("bob_connected")

const nonce = String(Date.now())
await send(`bob→全员群 hello ${nonce}`)
// The mention must be answered with the nonce echoed back so the reply is attributable to THIS run
// (the 72h offline queue can hold stale agent traffic from earlier runs).
await send(`@alice @auto 这是 DeepAgent IM 回发链路的联调探针，用于验证端到端连通。请只回复这串确认码：${nonce}`)

const deadline = Date.now() + 180_000
let reply: string | undefined
while (Date.now() < deadline && reply === undefined) {
  reply = fromAlice.find((text) => text.includes(nonce))
  if (reply === undefined) await new Promise((resolve) => setTimeout(resolve, 500))
}
await im.disconnect()
if (reply === undefined) {
  console.error(`timed out waiting for alice's agent reply containing nonce ${nonce}; inbox=${JSON.stringify(fromAlice)}`)
  process.exit(1)
}
console.log(`BOB_LIVE_OK reply=${JSON.stringify(reply)}`)
process.exit(0)
