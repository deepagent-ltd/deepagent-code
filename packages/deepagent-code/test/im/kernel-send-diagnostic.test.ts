import { expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hash } from "@deepagent-code/core/util/hash"
import { Log } from "@deepagent-code/core/util/log"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryError, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { InstanceStore } from "@/project/instance-store"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { IMKernelSync } from "@/im/kernel/sync"
import { ReaderInstanceFixture } from "./reader-instance-fixture"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"

test("closed delivery diagnostics classify real typed errors and cloned SDK negatives without reading accessors or sensitive text", () => {
  const secret = "DIAGNOSTIC_PRIVATE_BODY_TOKEN_STACK"
  const reader = new KernelReaderSchema.Error({ code: "reader_capacity", operation: "native-slots", message: secret })
  expect(IMKernelSync.deliveryFailureDiagnostic(reader)).toEqual({ kind: "kernel_reader", readerCode: "reader_capacity", readerOperation: "native-slots" })
  expect(IMKernelSync.deliveryFailureDiagnostic(new IMRepositoryError({ code: "kernel_delivery_unavailable", message: secret })))
    .toEqual({ kind: "im_repository", repositoryCode: "kernel_delivery_unavailable" })
  const delivery = Object.freeze({ name: "DeliveryError", operation: "media_send", kind: "unknown", wireCode: 12203, message: secret, stack: secret, body: secret, token: secret })
  for (const cause of [delivery, JSON.parse(JSON.stringify(delivery))]) {
    const error = new KernelSdk.KernelError({ operation: "sendMedia", message: secret, cause })
    expect(IMKernelSync.deliveryFailureDiagnostic(error)).toEqual({ kind: "kernel_sdk", sdkOperation: "sendMedia", deliveryOperation: "media_send", deliveryKind: "unknown", wireCode: 12203 })
    expect(JSON.stringify(IMKernelSync.deliveryFailureDiagnostic(error))).not.toContain(secret)
  }
  expect(IMKernelSync.deliveryFailureDiagnostic(new KernelSdk.KernelError({ operation: "sendMedia", message: secret,
    cause: { name: "DeliveryError", operation: secret, kind: secret, wireCode: 99999, code: 12203 } })))
    .toEqual({ kind: "kernel_sdk", sdkOperation: "sendMedia" })
  const reads = { count: 0 }
  const accessor = Object.defineProperties({}, Object.fromEntries(["name", "operation", "kind", "wireCode", "cause", "message", "stack"].map((key) => [key, { get() { reads.count++; throw new Error(secret) } }])))
  expect(IMKernelSync.deliveryFailureDiagnostic(new KernelSdk.KernelError({ operation: "sendMessage", message: secret, cause: accessor })))
    .toEqual({ kind: "kernel_sdk", sdkOperation: "sendMessage" })
  expect(IMKernelSync.deliveryFailureDiagnostic(accessor)).toEqual({ kind: "unclassified" })
  expect(reads.count).toBe(0)
  expect(IMKernelSync.deliveryFailureDiagnostic(new Proxy({}, { ownKeys() { throw new Error(secret) } }))).toEqual({ kind: "unclassified" })
})

const wait = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) => Effect.gen(function* () {
  for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
    const value = yield* effect
    if (value !== undefined) return value
    if (attempt === 199) return yield* Effect.die(new Error("bounded original delivery observation timed out"))
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die(new Error("unreachable delivery observation"))
})

test("actual SDK/native WS and file DB preserve unknown without resend, separating SDK failure from a real late-ACK false", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dac-kernel-send-diagnostic-"))
  const previousLevel = Log.getLevel()
  const mode = { value: "sdk_failure" as "sdk_failure" | "ack_false" }
  const sent = { count: 0 }
  const stage = { value: "connect" }
  const results: { mode: string; publishes: number; state: string; messageHash: string }[] = []
  const native = KernelLiveFirstSeenFixture.make({
    response(topic, _request, original) {
      if (topic === "qry_delivery_capabilities") return { name: "DeliveryCapabilities", value: {
        version: 1, profile: "mysql-receipt-v1", maxLifetimeMs: 259200000,
        maxContentBytes: mode.value === "sdk_failure" ? 0 : 65536, eventualDelivery: false,
      } }
      return original
    },
    outboundPublish(request, message) {
      sent.count++
      expect(message.msgContent instanceof Uint8Array).toBe(true)
      const content = JSON.parse(new TextDecoder().decode(message.msgContent as Uint8Array)) as { content: string }
      const requestHash = Hash.sha256(JSON.stringify(["dac.delivery.request.v1", 1, request.targetId, message.clientUid,
        "jg:text", content.content, 10, Number(String(message.deliveryExpiresAt))])
        .replace(/[<>&\u2028\u2029]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")))
      return { code: 0, msgId: "original-ack", timestamp: Date.now(), msgIndex: 1,
        clientMsgId: message.clientUid, deliveryVersion: 1, deliveryExpiresAt: Number(String(message.deliveryExpiresAt)),
        deliveryRequestHash: requestHash }
    },
  })
  try {
    await Log.init({ print: false, level: "DEBUG", dev: true })
    const logfile = Log.file()
    const config = { appkey: `private-diagnostic-${native.server.port}`, navigator: native.server.url.origin,
      token: "private-first-seen-token", userID: "receiver",
      identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
    const database = Database.layerFromPath(join(directory, "original.sqlite"))
    const actualRepository = IMRepositoryLive.pipe(Layer.provide(database))
    // The real late ACK arrives after the original dispatch has already been marked
    // uncertain. Both transitions use the actual repository and the same file DB;
    // acknowledge must return false, never overwrite unknown with an ACK.
    const repository = Layer.effect(IMRepository, Effect.gen(function* () {
      const repo = yield* IMRepository
      return IMRepository.of({ ...repo,
        acknowledgeKernelDelivery: (runtime, dispatch, kernelMessageID) => Effect.suspend(() => mode.value === "ack_false"
          ? repo.uncertainKernelDelivery(runtime, dispatch).pipe(Effect.andThen(repo.acknowledgeKernelDelivery(runtime, dispatch, kernelMessageID)))
          : repo.acknowledgeKernelDelivery(runtime, dispatch, kernelMessageID)),
      })
    })).pipe(Layer.provide(actualRepository))
    const client = KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config)))
    const services = Layer.mergeAll(database, repository, client, IMBroadcasterLive, ReaderInstanceFixture.layer, ReaderInstanceFixture.registry)
    const engine = IMKernelSync.layer(config, { inspectConversation: (input) => Effect.succeed({
      conversation_type: input.conversationType, conversation_id: input.conversationID, org_id: 1,
      name: "Sender", member_uuids: ["receiver", "sender"],
    }) }).pipe(Layer.provide(services))
    await Effect.runPromise(Effect.gen(function* () {
      const actualClient = yield* KernelClient.Service
      yield* wait(SubscriptionRef.get(actualClient.state).pipe(Effect.map((state) => state === "connected" ? true : undefined)))
      stage.value = "current-reader"
      const store = yield* InstanceStore.Service
      const instance = yield* store.load({ directory })
      const lease = yield* (yield* IMKernelSync.Service).acquireReader!({ instance, workspaceID: instance.directory, userID: "server",
        instanceCurrent: store.peek(instance.directory).pipe(Effect.map((current) => current === instance)) })
      const groupID = yield* lease.reader.pending({ conversationType: 1, conversationID: "sender", name: "Sender" })
      for (const selected of ["sdk_failure", "ack_false"] as const) {
        mode.value = selected
        stage.value = `create-${selected}`
        const message = yield* lease.engine.createMessage({ groupID, clientRequestID: `original-diagnostic-${selected}`,
          senderID: "server", senderType: "user", type: "text", content: "PRIVATE_ORIGINAL_CONTENT_MUST_NOT_BE_LOGGED" })
        stage.value = `send-${selected}`
        yield* lease.engine.send({ groupID, messageID: message.id, content: message.content })
        const original = yield* wait(lease.engine.deliveryStatus(message.id).pipe(Effect.map((value) => value?.state === "unknown" ? value : undefined)))
        expect(original).toMatchObject({ state: "unknown", kernelMessageID: null, reason: "delivery_outcome_unknown" })
        expect(sent.count).toBe(selected === "sdk_failure" ? 0 : 1)
        // Explicit caller duplicate and pending drain still cannot re-dispatch the
        // original unknown. This assertion exercises the real durable claim gate.
        yield* lease.engine.send({ groupID, messageID: message.id, content: message.content })
        yield* lease.engine.drainPending
        yield* Effect.sleep("50 millis")
        expect(sent.count).toBe(selected === "sdk_failure" ? 0 : 1)
        expect(yield* lease.engine.deliveryStatus(message.id)).toEqual(original)
        results.push({ mode: selected, publishes: sent.count, state: original.state,
          messageHash: Hash.sha256(JSON.stringify({ messageID: message.id })) })
      }
    }).pipe(Effect.onError(() => Effect.sync(() => console.error({ diagnosticStage: stage.value }))),
      Effect.provide(Layer.mergeAll(services, engine)), Effect.scoped))
    await Log.init({ print: true, level: previousLevel })
    const logged = (await Bun.file(logfile).text()).split("\n").filter((line) => line.includes("protected delivery observation"))
    for (const result of results) {
      const lines = logged.filter((line) => line.includes(`messageHash=${result.messageHash} `))
      expect(lines).toHaveLength(3 + (result.mode === "ack_false" ? 1 : 0))
      expect(lines.filter((line) => line.includes("event=begin") || line.includes("event=gate_settled") || line.includes("event=send_settled"))
        .every((line) => line.startsWith("DEBUG "))).toBe(true)
      expect(lines.every((line) => /messageHash=[a-f0-9]{64} lane=foreground/.test(line))).toBe(true)
      expect(lines.join("\n")).not.toContain("PRIVATE_ORIGINAL_CONTENT_MUST_NOT_BE_LOGGED")
      expect(lines.join("\n")).not.toContain(config.token)
      if (result.mode === "sdk_failure") {
        expect(lines.at(-1)).toMatch(/^WARN .*stage=sdk_send event=failure kind=kernel_sdk sdkOperation=sendMessage deliveryOperation=capabilities deliveryKind=invalid_response /)
        expect(lines.join("\n")).not.toContain("event=send_settled")
      }
      if (result.mode === "ack_false") {
        expect(lines.at(-1)).toMatch(/^WARN .*stage=ack_write event=ack_false /)
        expect(lines.join("\n")).not.toContain("event=failure")
      }
    }
    expect(results.map(({ mode, publishes, state }) => ({ mode, publishes, state }))).toEqual([
      { mode: "sdk_failure", publishes: 0, state: "unknown" },
      { mode: "ack_false", publishes: 1, state: "unknown" },
    ])
  } finally {
    native.server.stop(true)
    await Log.init({ print: true, level: previousLevel })
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
