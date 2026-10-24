import { expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer, Option, Ref, SubscriptionRef } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { eq } from "drizzle-orm"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { IMRepository, IMRepositoryLive, clientMessageID } from "@deepagent-code/core/im/repository"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { IMKernelDeliveryTable } from "@deepagent-code/core/im/kernel-delivery.sql"
import { MessageTable } from "@deepagent-code/core/im/sql"
import { SessionV2 } from "@deepagent-code/core/session"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { IMFacade } from "@/im/facade"
import { IMKernelSync } from "@/im/kernel/sync"
import { ServerAuth } from "@/server/auth"
import { Session } from "@/session/session"
import { IMApi, IMPaths } from "@/server/routes/instance/httpapi/groups/im"
import { imHandlers } from "@/server/routes/instance/httpapi/handlers/im"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { WorkspaceRouteContext, WorkspaceRoutingMiddleware } from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { ReaderInstanceFixture } from "../im/reader-instance-fixture"
import { IMReaderSDKFixture } from "./im-reader-sdk.fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const Api = HttpApi.make("deepagent-code-instance").addHttpApi(IMApi)

// Exercise the real HTTP handler, sync engine, reader proofs and file-backed
// repository. Only the platform/SDK boundary and unused Session APIs are local
// fixtures; this does not claim signed Native or live service qualification.
const run = (scenario: "slow" | "membership" | "owner" | "response-stale") => Effect.gen(function* () {
  const directory = yield* Effect.promise(async () => realpath(await mkdtemp(join(tmpdir(), "im-text-proof-http-"))))
  yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
  const sdk = IMReaderSDKFixture.make()
  sdk.publish(1, "uuid-peer", "controlled baseline")
  const control = { current: true, allowed: true, inspectDelayMs: 0, revokeOnInspect: false, inspections: 0, createCalls: 0, enqueues: 0, refuseResponse: false }
  const database = Database.layerFromPath(join(directory, "reader.sqlite"))
  const broadcaster = Layer.succeed(IMBroadcasterService, {
    broadcast: (_groupID, event) => {
      if (event.type === "message_created" && control.refuseResponse) sdk.refuseReadCuts(2)
    },
    sendToUser: () => {}, register: () => true, unregister: () => {}, getConnectionCount: () => 0, getUserConnectionCount: () => 0,
  })
  const services = Layer.mergeAll(database, IMRepositoryLive.pipe(Layer.provide(database)), ReaderInstanceFixture.layer, ReaderInstanceFixture.registry, broadcaster, Layer.mock(AgentListProviderService)({}))
  const config = { appkey: "appkey_1", navigator: "http://127.0.0.1:9", token: "controlled-token", userID: "uuid-alice", identity: { uuid: "uuid-alice", orgID: 7, name: "alice", orgAllGroupID: "org7" } }
  const context = yield* Layer.build(sdk.buildEngine(config, {
    ownerCurrent: () => control.current,
    inspectConversation: (input) => Effect.gen(function* () {
      control.inspections++
      if (control.inspectDelayMs) yield* Effect.sleep(control.inspectDelayMs)
      if (control.revokeOnInspect) control.current = false
      return { conversation_type: input.conversationType, conversation_id: input.conversationID, org_id: 7, name: input.conversationID,
        member_uuids: control.allowed ? ["uuid-alice", input.conversationID] : [input.conversationID] }
    }),
  }).pipe(Layer.provideMerge(services)))
  const engine = Context.get(context, IMKernelSync.Service)
  const store = Context.get(context, InstanceStore.Service)
  const db = Context.get(context, Database.Service).db
  yield* pollWithTimeout(SubscriptionRef.get(engine.state).pipe(Effect.map((state) => state === "connected" ? true : undefined)), "controlled SDK did not connect")
  const instance = yield* store.load({ directory })
  const acquire = () => engine.acquireReader!({ instance, workspaceID: directory, userID: "server", instanceCurrent: store.peek(directory).pipe(Effect.map((value) => value === instance)) })
  const lease = yield* acquire()
  yield* lease.reader.sync
  const projection = yield* KernelReader.projection(lease.reader.runtime, sdk.conversation(1, "uuid-peer").projectionKey)
  if (!projection?.local_group_id) return yield* Effect.die("controlled projection missing")
  const groupID = projection.local_group_id
  const facade = Layer.mock(IMFacade.Service)({
    state: yield* SubscriptionRef.make<IMFacade.State>({ kind: "active", identity: config.identity }),
    engine: yield* Ref.make(Option.some(engine)),
    withReader: (request, use) => Effect.scoped(Effect.gen(function* () {
      if (request.workspaceID !== directory || request.userID !== "server") return yield* KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease")
      const current = yield* acquire()
      return yield* use({ ...current, engine: { ...current.engine,
        createMessage: (input) => Effect.sync(() => { control.createCalls++ }).pipe(Effect.andThen(current.engine.createMessage(input))),
        send: (input) => Effect.sync(() => { control.enqueues++ }).pipe(Effect.andThen(current.engine.send(input))),
      } })
    })),
  })
  const credentials = { username: "controlled-proof-test", password: crypto.randomUUID() }
  const auth = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer({ username: credentials.username, password: Option.some(credentials.password) })))
  const middleware = Layer.mergeAll(
    Layer.succeed(InstanceContextMiddleware, InstanceContextMiddleware.of((effect) => effect.pipe(Effect.provideService(InstanceRef, instance)))),
    Layer.succeed(WorkspaceRoutingMiddleware, WorkspaceRoutingMiddleware.of((effect) => effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory })))),
  )
  const routing = HttpRouter.serve(HttpApiBuilder.layer(Api).pipe(
    Layer.provide(imHandlers), Layer.provide(Layer.succeedContext(context)), Layer.provide(facade),
    Layer.provide(RuntimeFlags.defaultLayer), Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(SessionV2.Service)({})), Layer.provide(Layer.mock(AgentListProviderService)({})),
    Layer.provide(middleware),
    // WorkspaceRoutingMiddleware declares the legacy Session tag even though
    // this fixture only uses its local pass-through and never calls Session.
    Layer.provide(Layer.mock(Session.Service)({})),
    Layer.provide(auth), Layer.provide(schemaErrorLayer),
  ), { disableListenLog: true, disableLogger: true }).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
  const serving = yield* Layer.build(routing)
  control.inspectDelayMs = scenario === "slow" ? 1100 : scenario === "response-stale" ? 50 : 0
  control.allowed = scenario !== "membership"
  control.revokeOnInspect = scenario === "owner"
  control.refuseResponse = scenario === "response-stale"
  const clientRequestID = `single-text-boundary-${scenario}`
  const messageID = clientMessageID("server", clientRequestID)
  const response = yield* HttpClientRequest.post(IMPaths.createMessage.replace(":groupId", groupID)).pipe(
    HttpClientRequest.setUrlParam("directory", directory), HttpClientRequest.setHeader("authorization", ServerAuth.header(credentials)!),
    HttpClientRequest.bodyJson({ senderType: "user", type: "text", content: `controlled ${scenario}`, clientRequestID }),
    Effect.flatMap(HttpClient.execute), Effect.flatMap((response) => response.json.pipe(Effect.map((body) => ({ status: response.status, body })))),
    Effect.provide(serving),
  )
  if (scenario === "slow") expect(response).toMatchObject({ status: 200, body: { id: messageID, content: "controlled slow" } })
  if (scenario === "response-stale") expect(response).toMatchObject({ status: 503, body: { name: "IM_READER_UNAVAILABLE", data: { code: "reader_stale", operation: "getDeliveryReadCut", wireCode: 12203 } } })
  if (scenario === "membership" || scenario === "owner") {
    expect(response.status).toBe(503)
    expect(control.createCalls).toBe(1)
    expect(control.enqueues).toBe(0)
    expect(yield* db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).all()).toHaveLength(0)
    expect(yield* db.select().from(IMKernelDeliveryTable).where(eq(IMKernelDeliveryTable.message_id, messageID)).all()).toHaveLength(0)
    expect(sdk.observed.sends).toBe(0)
    return
  }
  expect(control.createCalls).toBe(1)
  expect(control.enqueues).toBe(1)
  expect(yield* db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).all()).toHaveLength(1)
  expect(yield* db.select().from(IMKernelDeliveryTable).where(eq(IMKernelDeliveryTable.message_id, messageID)).all()).toHaveLength(1)
  yield* pollWithTimeout(Effect.sync(() => sdk.observed.sends === 1 ? true : undefined), "single admission did not dispatch exactly once", "8 seconds")
  expect(sdk.observed.sent.filter((item) => item.text === `controlled ${scenario}`)).toHaveLength(1)
  expect(control.inspections).toBeGreaterThanOrEqual(2)
})

it.live("slow protected text inspection precedes a fresh single HTTP admission and enqueue", () => run("slow"), 20000)
it.live("protected text membership refusal never admits or queues a message", () => run("membership"), 20000)
it.live("protected text owner replacement never admits or queues a message", () => run("owner"), 20000)
it.live("after-admission response cut refusal cannot repeat text admission or enqueue", () => run("response-stale"), 20000)
