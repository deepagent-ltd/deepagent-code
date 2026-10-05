// Manual live check for the JuggleIM kernel B1 path — NOT part of the test suite (needs the aly
// tunnel + the PoC env). Two modes in one file:
//
//   set -a; source /tmp/juggle-im-poc/server.env; set +a
//   bun script/im-kernel-live.ts        # alice side: real IMKernelSync stack, spawns the bob child
//   bun script/im-kernel-live.ts bob    # bob side: raw jugglechat-websdk (spawned by the alice side)
//
// alice seeds a group bound to k:1:<bob kernel id>, waits for the kernel link, then the bob child
// sends her a direct message. Asserts: bob's message lands in the local store with the kernel
// message id bob got in his ack; alice's local reply is acked (kernel_msg_id write-back) and bob
// receives it. Exit code 0 = all assertions held.

import { Effect, Layer, SubscriptionRef } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { IMKernelSync } from "@/im/kernel/sync"
import type { KernelConfig } from "@/im/kernel/config"

const need = (key: string): string => {
  const value = process.env[key]
  if (!value) throw new Error(`missing env ${key} — source /tmp/juggle-im-poc/server.env first`)
  return value
}

const poll = async <A>(label: string, timeoutMs: number, probe: () => Promise<A | undefined>): Promise<A> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const runBob = async () => {
  const appkey = need("JUGGLE_APPKEY")
  const navigator = need("JUGGLE_NAVIGATOR")
  const token = need("JUGGLE_TOKEN_BOB")
  const aliceID = need("JUGGLE_ALICE_ID")
  // Session nonce: the 72h offline queue can hold traffic from earlier runs — only this run's
  // nonce-tagged messages count.
  const nonce = process.argv[3]
  if (!nonce) throw new Error("bob mode needs the session nonce as argv[3]")

  await import("../src/im/kernel/shims")
  const JuggleIM = (await import("jugglechat-websdk")).default
  const im = JuggleIM.init({ appkey, navList: [navigator] })

  const fromAlice: Array<{ text: string }> = []
  im.on(JuggleIM.Event.MESSAGE_RECEIVED, (payload: unknown) => {
    const msg = payload as { sender?: { id?: unknown }; content?: { content?: unknown } }
    if (msg.sender?.id !== aliceID) return
    if (typeof msg.content?.content === "string") fromAlice.push({ text: msg.content.content })
  })

  await im.connect({ token })
  const text = `hello from bob ${nonce}`
  // d.ts 把 conversationType 错标成枚举对象类型（协议实际是 number）——与 sdk.ts 同一处收窄。
  const ack = (await im.sendMessage({
    conversationType: 1,
    conversationId: aliceID,
    name: JuggleIM.MessageType.TEXT,
    content: { content: text },
  } as unknown as Parameters<typeof im.sendMessage>[0])) as { messageId?: string }
  console.log(`bob_sent text=${JSON.stringify(text)}`)
  console.log(`bob_ack:${ack.messageId}`)

  const received = await poll("alice's reply", 90_000, async () =>
    fromAlice.find((msg) => msg.text.endsWith(` ${nonce}`)),
  )
  console.log(`bob_received text=${JSON.stringify(received.text)}`)
  await im.disconnect()
}

const runAlice = () => {
  const config: KernelConfig.Info = {
    appkey: need("JUGGLE_APPKEY"),
    navigator: need("JUGGLE_NAVIGATOR"),
    token: need("JUGGLE_TOKEN_ALICE"),
    userID: need("JUGGLE_ALICE_ID"),
  }
  const bobID = need("JUGGLE_BOB_ID")

  const database = Database.layerFromPath(":memory:")
  const repoLayer = IMRepositoryLive.pipe(Layer.provide(database))
  const syncLayer = IMKernelSync.layerFromConfig(config).pipe(
    Layer.provide(repoLayer),
    Layer.provide(IMBroadcasterLive),
  )
  const layer = Layer.mergeAll(database, repoLayer, syncLayer)

  const program = Effect.gen(function* () {
    const sync = yield* IMKernelSync.Service
    const repo = yield* IMRepository
    const group = yield* repo.createGroup({
      workspaceID: "ws_live",
      type: "project",
      name: "kernel-live-bob",
      createdBy: "alice-local",
    })
    yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: `k:1:${bobID}` })

    yield* Effect.promise(() =>
      poll("kernel link connected", 30_000, async () => {
        const state = await Effect.runPromise(SubscriptionRef.get(sync.state))
        return state === "connected" ? true : undefined
      }),
    )
    console.log("alice_connected")

    const nonce = String(Date.now())
    const child = Bun.spawn(["bun", import.meta.path, "bob", nonce], {
      env: process.env,
      stdout: "pipe",
      stderr: "inherit",
    })

    // Only THIS session's nonce-tagged message counts: bob's 72h offline queue can deliver stale
    // traffic from earlier runs (it did — proof the catch-up path works).
    const inbound = yield* Effect.promise(() =>
      poll("bob's inbound message", 90_000, async () => {
        const page = await Effect.runPromise(repo.listMessages({ groupID: group.id, limit: 50 }))
        return page.messages.find((msg) => msg.senderID === bobID && msg.content === `hello from bob ${nonce}`)
      }),
    )
    console.log(
      `alice_inbound kernelMsgID=${inbound.kernelMsgID} content=${JSON.stringify(inbound.content)} createdAt=${inbound.createdAt}`,
    )

    // bob is online right now (he just sent) — the reply exercises the online route.
    const replyText = `hello from alice ${nonce}`
    const local = yield* repo.createMessage({
      groupID: group.id,
      senderID: "alice-local",
      senderType: "user",
      type: "text",
      content: replyText,
    })
    yield* sync.send({ groupID: group.id, messageID: local.id, content: replyText })
    const acked = yield* Effect.promise(() =>
      poll("kernel ack write-back", 30_000, async () => {
        const row = await Effect.runPromise(repo.getMessage(local.id))
        return row?.kernelMsgID ? row : undefined
      }),
    )
    console.log(`alice_ack kernelMsgID=${acked.kernelMsgID}`)

    const [exitCode, childStdout] = yield* Effect.promise(() =>
      Promise.all([child.exited, new Response(child.stdout).text()]),
    )
    console.log(childStdout.trim())
    if (exitCode !== 0) throw new Error(`bob child exited ${exitCode}`)

    const bobAck = /bob_ack:(\S+)/.exec(childStdout)?.[1]
    if (!bobAck) throw new Error("bob child never printed its ack messageId")
    if (inbound.kernelMsgID !== bobAck)
      throw new Error(`inbound kernel_msg_id ${inbound.kernelMsgID} !== bob's ack ${bobAck}`)
    const bobReceived = /bob_received text=(.*)/.exec(childStdout)?.[1]
    if (bobReceived !== JSON.stringify(replyText))
      throw new Error(`bob received ${bobReceived ?? "<nothing>"} instead of alice's reply`)
    console.log("LIVE TEST OK: bob→kernel→落库 + alice→kernel ack回写 + bob收到回包 全部成立")
  })

  return Effect.runPromise(
    program.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<void, unknown, never>,
  )
}

const mode = process.argv[2] ?? "alice"
const run = mode === "bob" ? runBob : runAlice
run().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
