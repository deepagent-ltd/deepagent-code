import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { HttpClientResponse } from "effect/unstable/http"
import { Workspace } from "@/control-plane/workspace"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayerWithRuntimeFlags, requestInDirectory } from "./httpapi-layer"

const instance = InstanceStore.defaultLayer.pipe(
  Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
)
const workspace = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const it = testEffect(
  Layer.mergeAll(
    instance,
    workspace,
    Project.defaultLayer,
    Session.defaultLayer,
    Database.defaultLayer,
    IMRepositoryLive.pipe(Layer.provide(Database.defaultLayer)),
    httpApiLayerWithRuntimeFlags(RuntimeFlags.layer({})),
  ),
)
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

type Message = { id: string; transport?: { state: "prepared" | "acknowledged" | "unknown"; reason?: string } }
const json = <T>(response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.map((text) => {
      expect(response.status, text).toBe(200)
      return JSON.parse(text) as T
    }),
  )
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

it.live("actual HTTP keeps transport observation readonly and local admission separate from remote ACK", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const group = yield* requestInDirectory(
      "/api/v1/im/groups",
      directory,
      post({ type: "project", name: "Private delivery fixture" }),
    ).pipe(Effect.flatMap(json<{ id: string }>))
    const local = yield* requestInDirectory(
      `/api/v1/im/groups/${group.id}/messages`,
      directory,
      post({ senderType: "user", type: "text", content: "legacy outbound", clientRequestID: "legacy" }),
    ).pipe(Effect.flatMap(json<Message>))
    expect(local.transport).toBeUndefined()
    const repo = yield* IMRepository
    const db = (yield* Database.Service).db
    yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: "k:1:bob" })
    const authority = KernelDelivery.runtime({
      realm: "http://127.0.0.1:9/",
      appkey: "fixture",
      orgID: 1,
      senderID: "alice",
      credentialFingerprint: "a".repeat(64),
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(authority)))
    const prepared = yield* KernelDelivery.withCreation(
      authority,
      group.id,
      repo.createMessage({
        groupID: group.id,
        senderID: "server",
        senderType: "user",
        type: "text",
        content: "prepared",
        clientRequestID: "prepared",
      }),
    )
    const acknowledged = yield* KernelDelivery.withCreation(
      authority,
      group.id,
      repo.createMessage({
        groupID: group.id,
        senderID: "server",
        senderType: "user",
        type: "text",
        content: "acknowledged",
        clientRequestID: "acknowledged",
      }),
    )
    const dispatch = yield* KernelDelivery.withVerification(
      authority,
      { conversationType: 1, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] },
      repo.claimKernelDelivery(authority, acknowledged.id),
    )
    expect(yield* repo.acknowledgeKernelDelivery(authority, dispatch!, "kernel-acknowledged")).toBe(true)
    const inbound = yield* repo.createMessage({
      groupID: group.id,
      senderID: "bob",
      senderType: "user",
      type: "text",
      content: "inbound",
      kernelMsgID: "kernel-inbound",
    })
    const denied = yield* requestInDirectory(
      `/api/v1/im/groups/${group.id}/messages`,
      directory,
      post({ senderType: "user", type: "text", content: "no active identity", clientRequestID: "unavailable" }),
    )
    expect(denied.status).toBe(400)
    const before = yield* db.all("SELECT * FROM im_kernel_delivery ORDER BY message_id")
    yield* Effect.addFinalizer(() => db.run("PRAGMA query_only=OFF").pipe(Effect.orDie))
    yield* db.run("PRAGMA query_only=ON")
    const page = yield* requestInDirectory(`/api/v1/im/groups/${group.id}/messages?limit=100`, directory).pipe(
      Effect.flatMap(json<{ messages: Message[] }>),
    )
    const states = Object.fromEntries(page.messages.map((message) => [message.id, message.transport]))
    expect(states[local.id]).toEqual({ state: "unknown", reason: "legacy_missing_receipt" })
    // This HTTP fixture has no active kernel engine; it cannot promise the old prepared identity is usable.
    expect(states[prepared.id]).toEqual({ state: "unknown", reason: "delivery_identity_or_expiry_changed" })
    expect(states[acknowledged.id]).toEqual({ state: "acknowledged" })
    expect(states[inbound.id]).toBeUndefined()
    const detail = yield* requestInDirectory(`/api/v1/im/messages/${acknowledged.id}`, directory).pipe(
      Effect.flatMap(json<Message>),
    )
    expect(detail.transport).toEqual({ state: "acknowledged" })
    expect(JSON.stringify(page)).not.toContain("credentialFingerprint")
    expect(JSON.stringify(page)).not.toContain("dispatch_owner")
    expect(yield* db.all("SELECT * FROM im_kernel_delivery ORDER BY message_id")).toEqual(before)
    expect(yield* db.get("SELECT count(*) AS n FROM im_messages")).toEqual({ n: 4 })
    expect(yield* db.get("SELECT count(*) AS n FROM session_input")).toEqual({ n: 0 })
    yield* db.run("PRAGMA query_only=OFF")
  }),
)
