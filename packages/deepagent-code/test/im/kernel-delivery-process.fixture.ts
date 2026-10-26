import fs from "node:fs"
import path from "node:path"
import { Effect, Layer, Option, Schema, SubscriptionRef } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive, clientMessageID } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { InstanceStore } from "@/project/instance-store"
import { IMDeviceStore } from "@/im/device-store"
import { IMDeviceTransport } from "@/im/device-transport"
import { IMDeviceProof } from "@/im/device-proof"
import { SecretStore } from "@/mcp/secret-store"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { KernelConfig } from "@/im/kernel/config"
import { IMKernelSync } from "@/im/kernel/sync"
import { ReaderInstanceFixture } from "./reader-instance-fixture"

const root = process.env.IM_DELIVERY_ORACLE_ROOT!
if (
  !path.isAbsolute(root) ||
  !path.basename(path.dirname(root)).startsWith("im-kernel-delivery-cold-") ||
  fs.realpathSync(root) !== root
)
  throw new Error("Owned cold authority required")
const mode = process.argv[2]!
const scenario = process.argv[3]!
const filename = path.join(root, "authority.sqlite")
const connection = Schema.decodeUnknownSync(
  Schema.Struct({
    origin: Schema.String,
    publicJwk: Schema.Struct({
      kty: Schema.Literal("EC"),
      crv: Schema.Literal("P-256"),
      x: Schema.String,
      y: Schema.String,
    }),
    jkt: Schema.String,
    deviceDirectory: Schema.String,
    backendFile: Schema.String,
  }),
)(await Bun.file(path.join(root, "connection.json")).json())
const token = mode === "p2" && scenario === "identity" ? "daim2.delivery-cold-rebound" : "daim2.delivery-cold-original"
const device = IMDeviceStore.make({
  directory: connection.deviceDirectory,
  backend: SecretStore.fileBackend(connection.backendFile),
})
const http = await Effect.runPromise(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)))
const transport = IMDeviceTransport.make({ store: device, http })
const config: KernelConfig.Info = {
  appkey: "delivery-cold-owned",
  navigator: connection.origin,
  token,
  userID: "receiver",
  protectedMedia: true,
  ...(mode === "p2" && scenario === "missing-identity"
    ? {}
    : { identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }),
  protectedDeviceAuth: {
    profile: IMDeviceProof.profile,
    publicJwk: connection.publicJwk,
    jkt: connection.jkt,
    entitlementID: "e".repeat(32),
    bindingVersion: 1,
    socketAudience: connection.origin.replace(/^https:/, "wss:") + "/im",
    signConnect: (challenge, input) =>
      Effect.runPromise(
        device.socket(challenge, {
          audience: input.audience,
          appkey: "delivery-cold-owned",
          token: input.token,
          entitlementID: "e".repeat(32),
          bindingVersion: 1,
        }),
      ),
    signHttp: (request) =>
      Effect.runPromise(
        transport.headers({
          realm: connection.origin,
          kernelRealm: connection.origin,
          method: request.method,
          url: request.url,
          purpose: "kernel-http",
          credential: request.credential,
          requestHash: IMDeviceProof.digest([
            "dac.im.kernel-http.v1",
            connection.origin,
            IMDeviceProof.sha256(token),
            connection.jkt,
          ]),
        }),
      ),
  },
}
const originalFetch = globalThis.fetch
const external = { count: 0 }
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== connection.origin) {
      external.count++
      throw new Error("Cold fixture refuses external network")
    }
    return originalFetch(input, init)
  },
  { preconnect: () => {} },
)
const file = () => {
  const stat = fs.statSync(filename)
  return { path: fs.realpathSync(filename), dev: stat.dev, inode: stat.ino }
}
const wire = () =>
  fs.existsSync(path.join(root, "receiver.jsonl"))
    ? fs
        .readFileSync(path.join(root, "receiver.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.stage === mode)
    : []
const membership = { allowed: mode === "p1" || scenario !== "denied" }
const observed = { ackFailed: false, deniedInspections: 0 }
const database = Database.layerFromPath(filename)
const originalRepository = IMRepositoryLive.pipe(Layer.provide(database))
const repository = Layer.effect(
  IMRepository,
  Effect.gen(function* () {
    const repo = yield* IMRepository
    return {
      ...repo,
      acknowledgeKernelDelivery: (...input: Parameters<typeof repo.acknowledgeKernelDelivery>) =>
        repo.acknowledgeKernelDelivery(...input).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              observed.ackFailed = true
            }),
          ),
        ),
    }
  }),
).pipe(Layer.provide(originalRepository))
const client = KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config)))
const services = Layer.mergeAll(
  database,
  repository,
  client,
  ReaderInstanceFixture.layer,
  ReaderInstanceFixture.registry,
  IMBroadcasterLive,
)
const sync = IMKernelSync.layer(config, {
  inspectConversation: (input) =>
    Effect.sync(() => {
      if (!membership.allowed) observed.deniedInspections++
      return {
        conversation_type: input.conversationType,
        conversation_id: input.conversationID,
        org_id: 1,
        name: "Sender",
        member_uuids: membership.allowed ? ["receiver", "sender"] : ["mallory"],
      }
    }),
}).pipe(Layer.provide(services))
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const repo = yield* IMRepository
    const currentClient = yield* KernelClient.Service
    for (const attempt of Array.from({ length: 500 }, (_, index) => index)) {
      if ((yield* SubscriptionRef.get(currentClient.state)) === "connected") break
      if (attempt === 499) return yield* Effect.die(new Error("Original device SDK did not connect"))
      yield* Effect.sleep("10 millis")
    }
    const engine = yield* IMKernelSync.Service
    const store = yield* InstanceStore.Service
    const directory = path.join(root, "workspace")
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const instance = yield* store.load({ directory })
    const acquired = yield* engine.acquireReader!({
      instance,
      workspaceID: directory,
      userID: "server",
      instanceCurrent: store.peek(directory).pipe(Effect.map((current) => current === instance)),
    }).pipe(Effect.option)
    if (mode === "p1" && Option.isNone(acquired))
      return yield* Effect.die(new Error("Original current reader was not admitted"))
    const lease = Option.getOrUndefined(acquired)
    const authority = KernelDelivery.runtime(KernelConfig.deliverySource(config))
    yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(authority)))
    const messageID = clientMessageID("server", "stable-request")
    const clockAdvanceMS = mode === "p2" && ["lost", "ack-write"].includes(scenario) ? 660000 : 0
    const now = Date.now
    Date.now = () => now() + clockAdvanceMS
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Date.now = now
      }),
    )
    if (mode === "p1") {
      const groupID = yield* lease!.reader.pending({ conversationType: 1, conversationID: "sender", name: "Sender" })
      if (scenario === "ack-write")
        yield* db.run(
          "CREATE TRIGGER reject_delivery_ack BEFORE UPDATE OF kernel_msg_id ON im_messages BEGIN SELECT RAISE(ABORT, 'isolated ack failure'); END",
        )
      const message = yield* lease!.engine.createMessage({
        groupID,
        clientRequestID: "stable-request",
        senderID: "server",
        senderType: "user",
        type: "text",
        content: "one durable message",
      })
      if (scenario === "denied") membership.allowed = false
      if (scenario === "missing-identity") {
        yield* store.dispose(instance)
        yield* lease!.engine.send({ groupID, messageID: message.id, content: message.content })
      }
      if (!["identity", "missing-identity"].includes(scenario))
        yield* lease!.engine.send({ groupID, messageID: message.id, content: message.content })
      if (scenario === "lost") return yield* Effect.never
      if (["success", "ack-write"].includes(scenario)) {
        for (const attempt of Array.from({ length: 250 }, (_, index) => index)) {
          if (
            scenario === "ack-write"
              ? observed.ackFailed
              : (yield* repo.kernelDeliveryStatus(message.id, authority)).state === "acknowledged"
          )
            break
          if (attempt === 249) return yield* Effect.die(new Error("Original send/ACK SQL boundary did not settle"))
          yield* Effect.sleep("10 millis")
        }
      }
      if (scenario === "ack-write") yield* db.run("DROP TRIGGER reject_delivery_ack")
      if (!["denied", "missing-identity"].includes(scenario)) {
        const retry = yield* lease!.engine.createMessage({
          groupID,
          clientRequestID: "stable-request",
          senderID: "server",
          senderType: "user",
          type: "text",
          content: "one durable message",
        })
        if (retry.id !== message.id) return yield* Effect.die(new Error("Exact retry changed identity"))
        yield* lease!.engine
          .createMessage({
            groupID,
            clientRequestID: "stable-request",
            senderID: "server",
            senderType: "user",
            type: "text",
            content: "changed body",
          })
          .pipe(Effect.flip)
      }
    }
    const before = yield* db.all(
      "SELECT message_id,state,wire_id,dispatch_owner,kernel_message_id FROM im_kernel_delivery ORDER BY message_id",
    )
    if (mode !== "p1" || scenario !== "identity") yield* engine.drainPending
    const after = yield* db.all(
      "SELECT message_id,state,wire_id,dispatch_owner,kernel_message_id FROM im_kernel_delivery ORDER BY message_id",
    )
    return {
      pid: process.pid,
      file: file(),
      wire: wire(),
      status: yield* repo.kernelDeliveryStatus(messageID, authority),
      before,
      after,
      messages: yield* db.all("SELECT id,content,kernel_msg_id FROM im_messages ORDER BY id"),
      networks: external.count,
      clockAdvanceMS,
      ackSQLFailureObserved: observed.ackFailed,
      readerAdmitted: lease !== undefined,
      deniedInspections: observed.deniedInspections,
      sessionInputs: yield* db.get("SELECT count(*) AS n FROM session_input"),
      providerAttempts: yield* db.get("SELECT count(*) AS n FROM session_provider_attempt"),
    }
  }).pipe(Effect.provide(Layer.mergeAll(services, sync)), Effect.scoped),
)
process.stdout.write(`KERNEL_DELIVERY_RESULT ${JSON.stringify(result)}\n`)
