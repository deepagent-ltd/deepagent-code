// Manual live check for kernel offline pull — NOT part of the test suite. Bob side: connects with
// the FACADE-issued kernel token, sends NOTHING, and pulls the group's hismsgs to prove that a
// message alice posted (via her local API → org all-group → kernel, kernel_msg_id acked) while bob
// was disconnected is redeliverable on reconnect (design §9 hismsgs channel, 72h TTL).
//
//   env: JUGGLE_APPKEY JUGGLE_NAVIGATOR BOB_KERNEL_TOKEN ALICE_UUID ORG_GROUP_ID PROBE_NONCE
//   bun script/im-facade-live-bob-offline.ts
//
// Exit 0 = hismsgs contains an alice message carrying PROBE_NONCE.

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
const probe = need("PROBE_NONCE")

await import("../src/im/kernel/shims")
const JuggleIM = (await import("jugglechat-websdk")).default
const im = JuggleIM.init({ appkey, navList: [navigator] })

const live: string[] = []
im.on(JuggleIM.Event.MESSAGE_RECEIVED, (payload: unknown) => {
  const msg = payload as { sender?: { id?: unknown }; content?: { content?: unknown } }
  if (msg.sender?.id !== aliceID) return
  if (typeof msg.content?.content !== "string") return
  live.push(msg.content.content)
  console.log(`bob_live_received text=${JSON.stringify(msg.content.content)}`)
})

await im.connect({ token })
console.log("bob_connected")
await new Promise((resolve) => setTimeout(resolve, 2000))

const result = (await im.getMessages({ conversationId: groupID, conversationType: 2 } as Parameters<
  typeof im.getMessages
>[0])) as { messages?: unknown[] }
const texts = (Array.isArray(result.messages) ? result.messages : []).flatMap((raw) => {
  const msg = raw as { sender?: { id?: unknown }; content?: { content?: unknown } }
  return typeof msg.sender?.id === "string" && typeof msg.content?.content === "string"
    ? [{ sender: msg.sender.id, text: msg.content.content }]
    : []
})
console.log(`bob_hismsgs count=${texts.length}`)
const fromAlice = texts.filter((msg) => msg.sender === aliceID)
for (const msg of fromAlice) console.log(`bob_hismsgs_received text=${JSON.stringify(msg.text)}`)

await im.disconnect()
const hit = fromAlice.find((msg) => msg.text.includes(probe))
if (!hit) {
  console.error(`offline probe ${probe} not in hismsgs; fromAlice=${JSON.stringify(fromAlice)} live=${JSON.stringify(live)}`)
  process.exit(1)
}
console.log(`BOB_OFFLINE_OK text=${JSON.stringify(hit.text)}`)
process.exit(0)
