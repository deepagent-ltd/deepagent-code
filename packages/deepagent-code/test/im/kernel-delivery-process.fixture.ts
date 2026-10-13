import { mock } from "bun:test"
import fs from "node:fs"
import { createHash } from "node:crypto"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { IMKernelSync } from "@/im/kernel/sync"
import { clientMessageID } from "@deepagent-code/core/im/repository"
import { InstanceRegistry } from "@/effect/instance-registry"

const root = process.env.IM_DELIVERY_ORACLE_ROOT!
const mode = process.argv[2]!
const scenario = process.argv[3]!
const clockAdvanceMS = mode === "p2" && ["lost", "ack-write"].includes(scenario) ? 660_000 : 0
const now = Date.now
Date.now = () => now() + clockAdvanceMS
const filename = `${root}/authority.sqlite`
const wire: Array<{ tid: string; clientMsgId: string; text: string }> = []
const file = () => {
  const stat = fs.statSync(filename)
  return { path: fs.realpathSync(filename), dev: stat.dev, inode: stat.ino }
}
await import("@/im/kernel/shims")
const installed = await Bun.file(new URL(import.meta.resolve("jugglechat-websdk"))).text()
const bundle = await import(
  `data:text/javascript;base64,${Buffer.from(`${installed}\nexport { Message$1 as AuditMessage };`).toString("base64")}`
)
let networks = 0
globalThis.fetch = Object.assign(
  () => {
    networks++
    throw new Error("external network forbidden")
  },
  {
    preconnect: () => {
      throw new Error("external preconnect forbidden")
    },
  },
)
const handlers = new Map<string, (value: unknown) => void>()
const messages = bundle.AuditMessage(
  {
    on: () => {},
    getCurrentUser: () => ({ id: "alice" }),
    isConnected: () => true,
    getConfig: () => ({ isPC: true }),
    emit: () => {},
    sendCommand: (
      _command: unknown,
      input: { tid: string; clientMsgId: string; content: { content: string } },
      callback: (ack: unknown) => void,
    ) => {
      wire.push({ tid: input.tid, clientMsgId: input.clientMsgId, text: input.content.content })
      fs.appendFileSync(`${root}/receiver.jsonl`, `${JSON.stringify(wire.at(-1))}\n`)
      if (mode === "p1" && scenario === "lost") {
        fs.writeFileSync(
          `${root}/ready.json`,
          JSON.stringify({ pid: process.pid, file: file(), wire, state: "remote_captured_ack_not_returned" }),
        )
        return
      }
      callback({ code: 0, messageId: `kernel-${input.clientMsgId}`, sentTime: Date.now(), msgIndex: 1 })
    },
  },
  { emit: () => {} },
  { info: () => {} },
)
mock.module("jugglechat-websdk", () => ({
  default: {
    Event: { STATE_CHANGED: "state", MESSAGE_RECEIVED: "message" },
    MessageType: { TEXT: "jg:text" },
    MessageOrder: { FORWARD: 1 },
    init: () => ({
      on: (key: string, callback: (value: unknown) => void) => handlers.set(key, callback),
      connect: async () => handlers.get("state")?.({ state: mode === "p1" && scenario === "identity" ? 2 : 0 }),
      disconnect: async () => {},
      sendMessage: messages.sendMessage,
      getMessages: async () => ({ messages: [], isFinished: true }),
      getConversations: async () => ({ conversations: [], isFinished: true }),
    }),
  },
}))
const database = Database.layerFromPath(filename)
const repo = IMRepositoryLive.pipe(Layer.provide(database))
const config = {
  appkey: "fixture",
  navigator: "http://127.0.0.1:9",
  token: mode === "p2" && scenario === "identity" ? "new-fixture-credential" : "fixture-credential",
  userID: "alice",
  ...(scenario === "missing-identity"
    ? {}
    : { identity: { uuid: "alice", orgID: 1, name: "Alice", orgAllGroupID: "org1" } }),
}
const sdk = KernelSdk.liveFromConfig(config)
const client = KernelClient.layer.pipe(Layer.provide(sdk))
const sync = IMKernelSync.layer(config, {
  workspaceID: root,
  inspectConversation: (input) =>
    Effect.succeed({
      conversation_type: input.conversationType,
      conversation_id: input.conversationID,
      org_id: 1,
      name: "fixture",
      member_uuids: scenario === "denied" ? ["mallory"] : ["alice", "bob"],
    }),
}).pipe(
  Layer.provide(repo),
  Layer.provide(database),
  Layer.provide(InstanceRegistry.layer),
  Layer.provide(client),
  Layer.provide(
    Layer.succeed(IMBroadcasterService, {
      broadcast: () => {},
      sendToUser: () => {},
      register: () => true,
      unregister: () => {},
      getConnectionCount: () => 0,
      getUserConnectionCount: () => 0,
    }),
  ),
)
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const repository = yield* IMRepository
    const engine = yield* IMKernelSync.Service
    const messageID = clientMessageID("server", "stable-request")
    if (mode === "p1") {
      const group = yield* repository.createGroup({
        workspaceID: root,
        name: "fixture",
        type: "direct",
        createdBy: "server",
      })
      yield* repository.bindKernelConversation({ groupID: group.id, kernelConvID: "k:1:bob" })
      if (scenario === "ack-write")
        yield* db.run(
          "CREATE TRIGGER reject_delivery_ack BEFORE UPDATE OF kernel_msg_id ON im_messages BEGIN SELECT RAISE(ABORT, 'isolated ack failure'); END",
        )
      const message = yield* engine.createMessage({
        groupID: group.id,
        clientRequestID: "stable-request",
        senderID: "server",
        senderType: "user",
        type: "text",
        content: "one durable message",
      })
      if (scenario === "identity")
        return { pid: process.pid, file: file(), wire, status: yield* engine.deliveryStatus(message.id), networks }
      yield* engine.send({ groupID: group.id, messageID: message.id, content: message.content })
      if (scenario === "lost") return yield* Effect.never
      if (["denied", "missing-identity"].includes(scenario)) yield* engine.drainPending
      for (let n = 0; n < 100 && !["denied", "missing-identity"].includes(scenario); n++) {
        const state = yield* engine.deliveryStatus(message.id)
        if (state.state === (scenario === "ack-write" ? "unknown" : "acknowledged")) break
        yield* Effect.sleep("20 millis")
      }
      if (scenario === "ack-write") yield* db.run("DROP TRIGGER reject_delivery_ack")
      const retry = yield* engine.createMessage({
        groupID: group.id,
        clientRequestID: "stable-request",
        senderID: "server",
        senderType: "user",
        type: "text",
        content: "one durable message",
      })
      if (retry.id !== message.id) return yield* Effect.die("exact retry changed message identity")
      yield* engine
        .createMessage({
          groupID: group.id,
          clientRequestID: "stable-request",
          senderID: "server",
          senderType: "user",
          type: "text",
          content: "changed body",
        })
        .pipe(Effect.flip)
    }
    // Both the process and actual SDK Message instance are new in p2. Reads never issue sends.
    const before = yield* db.all(
      "SELECT message_id,state,wire_id,dispatch_owner,kernel_message_id FROM im_kernel_delivery ORDER BY message_id",
    )
    yield* engine.drainPending
    const after = yield* db.all(
      "SELECT message_id,state,wire_id,dispatch_owner,kernel_message_id FROM im_kernel_delivery ORDER BY message_id",
    )
    return {
      pid: process.pid,
      file: file(),
      wire,
      status: yield* engine.deliveryStatus(messageID),
      before,
      after,
      messages: yield* db.all("SELECT id,content,kernel_msg_id FROM im_messages ORDER BY id"),
      networks,
      clockAdvanceMS,
      sdkSHA256: createHash("sha256").update(installed).digest("hex"),
      sessionInputs: yield* db.get("SELECT count(*) AS n FROM session_input"),
      providerAttempts: yield* db.get("SELECT count(*) AS n FROM session_provider_attempt"),
    }
  }).pipe(Effect.provide(Layer.mergeAll(database, repo, sync)), Effect.scoped),
)
process.stdout.write(`KERNEL_DELIVERY_RESULT ${JSON.stringify(result)}\n`)
