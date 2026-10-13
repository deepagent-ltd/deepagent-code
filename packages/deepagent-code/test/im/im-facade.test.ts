import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Stream, SubscriptionRef } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import type { IMBroadcaster } from "@deepagent-code/core/im/websocket"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { InstanceStore } from "@/project/instance-store"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { WorkspaceRef } from "@/effect/instance-ref"
import { ReaderInstanceFixture } from "./reader-instance-fixture"
import { Auth } from "@/auth"
import { IMFacade } from "@/im/facade"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { IMKernelSync } from "@/im/kernel/sync"
import { IMKernelReader } from "@/im/kernel/reader"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import type { KernelConfig } from "@/im/kernel/config"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { pollWithTimeout, testEffect } from "../lib/effect"

// IMFacade（B2 门面运行时）的单元测试：假 HttpClient（按路径分发罐装包络）+ 真内存 sqlite
// 仓库 + 假引擎构建器（记录 config、返回固定引擎实例）。覆盖：boot 状态机四态、claim 引导
// （含热启动幂等）、rename/rebind/retryExchange、resolve 归一化、建群/私聊/邀请的本地镜像与绑定。
// 门面本身由 live 脚本联调——这里永不触网。

const it = testEffect(Layer.empty)

const FACADE_ENV = {
  DEEPAGENT_IM_FACADE_URL: "http://facade.local",
  DEEPAGENT_IM_FACADE_KEY: "sk-alice",
} as const

const payload = (name = "alice", uuid = "uuid-alice") => ({
  kernel_token: `kt_${uuid}`,
  navigator_url: "http://127.0.0.1:9002",
  appkey: "appkey_1",
  identity: { uuid, name, org_id: 7, org_all_group_id: "org7" },
  ttl: { msg_life_time_ms: 259200000 },
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const ok = (data: unknown) => json({ success: true, message: "", data })
const fail = (code: string, message: string, status: number) => json({ success: false, code, message }, status)

type Seen = { method: string; url: string; authorization: string | undefined; body?: unknown }

const httpStub = (respond: (req: { method: string; url: string; body?: unknown }) => Response, seen: Seen[]) =>
  HttpClient.make((req) =>
    Effect.sync(() => {
      const entry: Seen = { method: req.method, url: req.url, authorization: req.headers["authorization"] }
      if (req.method !== "GET") {
        const body = req.body as { readonly body?: Uint8Array }
        if (body?.body) entry.body = JSON.parse(new TextDecoder().decode(body.body))
      }
      seen.push(entry)
      return HttpClientResponse.fromWeb(req, respond(entry))
    }),
  )

const broadcaster: IMBroadcaster = {
  broadcast: () => {},
  sendToUser: () => {},
  register: () => true,
  unregister: () => {},
  getConnectionCount: () => 0,
  getUserConnectionCount: () => 0,
}

const agentProvider = Layer.succeed(AgentListProviderService, {
  listAgents: () => Effect.succeed([]),
  findByTrigger: () => Effect.succeed([]),
  findByCapability: () => Effect.succeed([]),
})

/** 内存 auth.json：rebind 持久化的断言目标。 */
const makeAuth = (initial?: Readonly<Record<string, Auth.Info>>) => {
  const store = new Map<string, Auth.Info>(Object.entries(initial ?? {}))
  return {
    service: Auth.Service.of({
      get: (id) => Effect.succeed(store.get(id)),
      all: () => Effect.succeed(Object.fromEntries(store)),
      set: (key, info) => Effect.sync(() => void store.set(key, info)),
      remove: (key) => Effect.sync(() => void store.delete(key)),
    }),
    store,
  }
}

interface Harness {
  readonly layer: Layer.Layer<IMFacade.Service | IMRepository | InstanceStore.Service, unknown, never>
  readonly engineStops: KernelConfig.Info[]
  readonly engineStarts: KernelConfig.Info[]
  readonly engineState: SubscriptionRef.SubscriptionRef<KernelClient.ConnectionState>
}

/** 每个用例一套独立图层（内存库 + 罐装 HTTP + 假引擎）。引擎构建走 Layer.unwrap 以便持有 state。 */
const makeHarness = (options: {
  env: Readonly<Record<string, string | undefined>>
  http: HttpClient.HttpClient
  auth?: Auth.Interface
  credentialRefreshInterval?: number
  engineBehavior?: (config: KernelConfig.Info) => Effect.Effect<void, unknown>
  buildEngine?: IMFacade.EngineBuilder
  protectedReader?: boolean
  readerUnavailable?: boolean
}): Effect.Effect<Harness, never, never> =>
  Effect.gen(function* () {
    const engineStarts: KernelConfig.Info[] = []
    const engineStops: KernelConfig.Info[] = []
    const engineState = yield* SubscriptionRef.make<KernelClient.ConnectionState>(options.protectedReader ? "connected" : "disconnected")
    const buildEngine: IMFacade.EngineBuilder = (config, layerOptions) =>
      Layer.unwrap(
        Effect.gen(function* () {
          engineStarts.push(config)
          yield* Effect.addFinalizer(() => Effect.sync(() => void engineStops.push(config)))
          if (options.engineBehavior) yield* options.engineBehavior(config)
          if (options.protectedReader) return IMKernelSync.layer(config, layerOptions).pipe(Layer.provide(Layer.mock(KernelClient.Service, {
            state: engineState, messages: Stream.empty,
            getDeliveryReader: () => options.readerUnavailable ? Effect.fail(new KernelSdk.KernelError({ operation: "getDeliveryReader", message: "Actual reader API is unavailable" })) : Effect.succeed({ version: 1, scopeKey: "a".repeat(64), currentCursor: "0", serverNow: Date.now(), maxPageItems: 32, maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000 }),
            getDeliveryChanges: (request) => Effect.succeed({ version: 1, scopeKey: request.scopeKey, after: request.after, upper: "0", scanCursor: "0", scanProjectionKey: "", pageToken: "", windowComplete: true, caughtUp: true, serverNow: Date.now(), items: [] }),
          })))
          const instance = IMKernelSync.Service.of({
              createMessage: () => Effect.die("unused delivery creation"),
              deliveryStatuses: () => Effect.die("unused transport statuses"),
              deliveryStatus: () => Effect.die("unused delivery receipt"),
              state: engineState,
              send: () => Effect.void,
              drainPending: Effect.void,
              recovery: yield* SubscriptionRef.make<IMKernelSync.RecoveryState>({ status: "ready" }),
              catchUp: Effect.void,
            })
          return Layer.succeed(IMKernelSync.Service, instance)
        }),
      )
    const database = Database.layerFromPath(":memory:")
    const repo = IMRepositoryLive.pipe(Layer.provide(database))
    const facade = IMFacade.layer({
      env: options.env,
      buildEngine: options.buildEngine ?? buildEngine,
      credentialRefreshInterval: options.credentialRefreshInterval,
    }).pipe(
      Layer.provide(repo),
      Layer.provide(database),
      Layer.provide(Layer.succeed(IMBroadcasterService, broadcaster)),
      Layer.provide(agentProvider),
      Layer.provide(Layer.succeed(Auth.Service, options.auth ?? makeAuth().service)),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, options.http)),
      Layer.provide(ReaderInstanceFixture.layer),
      Layer.provide(ReaderInstanceFixture.registry),
    )
    return { layer: Layer.mergeAll(facade, repo, ReaderInstanceFixture.layer), engineStarts, engineStops, engineState }
  })

const exchangeFail =
  (code: string, status: number, message = `${code} from stub`) =>
  (_: { method: string; url: string }) =>
    fail(code, message, status)

describe("IMFacade", () => {
  it.live("revokes the captured reader owner before an old native request settles during a credential switch", () => Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = { native: () => {} }
    const native = new Promise<void>((resolve) => { release.native = resolve })
    const nativeSettled = yield* Deferred.make<void>()
    const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
    const generations: (() => boolean)[] = []
    const calls = { cut: 0, mark: 0, output: 0 }
    const invalidations: string[] = []
    const scopeKey = "a".repeat(64)
    const projectionKey = "b".repeat(64)
    const harness = yield* makeHarness({ env: FACADE_ENV, http: httpStub((request) => ok(request.url.endsWith("/inspect") ? { conversation_type: 1, conversation_id: "bob", org_id: 7, member_uuids: ["uuid-alice", "bob"], name: "bob" } : payload()), []), buildEngine: (config, options) => Layer.effect(IMKernelSync.Service, Effect.gen(function* () {
      if (!options?.ownerCurrent) return yield* Effect.die("production owner was not captured")
      generations.push(options.ownerCurrent)
      if (generations.length > 1) return yield* Effect.fail("fixture build failure")
      const reader = yield* IMKernelReader.make(config, { workspaceID: "workspace", ownerCurrent: options.ownerCurrent, onOwnerRevoked: options.onOwnerRevoked, inspectConversation: options.inspectConversation }).pipe(Effect.provide(Layer.merge(Layer.mock(IMBroadcasterService, { ...broadcaster, broadcast: (groupID, event) => { if (event.type === "reader_invalidated") invalidations.push(groupID) } }), Layer.mock(KernelClient.Service, {
        state,
        getDeliveryReadCut: (request) => Effect.gen(function* () {
          calls.cut++
          yield* Deferred.succeed(started, undefined)
          const cut = yield* KernelSdk.request("getDeliveryReadCut", () => native.then(() => ({ ...request, throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: Date.now(), complete: false })))
          yield* Deferred.succeed(nativeSettled, undefined)
          return cut
        }),
        markDeliveryRead: () => Effect.sync(() => { calls.mark++; throw new Error("revoked generation dispatched a mark") }),
      }))))
      return IMKernelSync.Service.of({ createMessage: () => Effect.die("unused creation"), deliveryStatuses: () => Effect.die("unused statuses"), deliveryStatus: () => Effect.die("unused receipt"), state, send: () => Effect.void, drainPending: Effect.void, recovery: yield* SubscriptionRef.make<IMKernelSync.RecoveryState>({ status: "ready" }), catchUp: Effect.void, reader })
    })) })
    yield* Effect.gen(function* () {
      const facade = yield* IMFacade.Service
      const engine = Option.getOrThrow(yield* Ref.get(facade.engine))
      const reader = engine.reader!
      const now = Date.now()
      yield* KernelReader.bind(reader.runtime, scopeKey)
      yield* KernelReader.ensureScope(reader.runtime)
      yield* KernelReader.applyChanges(reader.runtime, { version: 1, scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: now, items: [{ visibility: "visible", projectionKey, revision: "1", cursor: "1", conversationType: 1, targetId: "bob", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: "original", latestSequence: "1", latestMessageTime: now, nextExpiryAt: now + 60000 }] })
      const groupID = (yield* KernelReader.projection(reader.runtime, projectionKey))!.local_group_id!
      reader.watchGroup(groupID)
      const output = yield* Effect.forkChild(reader.withOutput({ workspaceID: "workspace", userID: "server", groupIDs: [groupID] }, Effect.sync(() => { calls.output++; return "old body" })).pipe(Effect.result))
      yield* Deferred.await(started)
      const switching = yield* Effect.forkChild(facade.retryExchange)
      yield* pollWithTimeout(Ref.get(facade.engine).pipe(Effect.map((value) => Option.isNone(value) ? true : undefined)), "credential switch did not revoke the old engine")
      expect(generations[0]()).toBe(false)
      expect(invalidations).toEqual([groupID])
      expect((yield* Deferred.await(nativeSettled).pipe(Effect.timeoutOption("20 millis")))._tag).toBe("None")
      const current = yield* KernelReader.current(reader.runtime).pipe(Effect.result, Effect.timeoutOption("20 millis"))
      expect(current._tag).toBe("Some")
      if (current._tag === "Some") expect(current.value._tag).toBe("Failure")
      const lateGet = yield* reader.withOutput({ workspaceID: "workspace", userID: "server", groupIDs: [groupID] }, Effect.succeed("old body")).pipe(Effect.result, Effect.timeoutOption("20 millis"))
      expect(lateGet._tag).toBe("Some")
      if (lateGet._tag === "Some") expect(lateGet.value._tag).toBe("Failure")
      const read = yield* reader.read({ groupID, actionID: "revoked-read-action" }).pipe(Effect.result, Effect.timeoutOption("20 millis"))
      expect(read._tag).toBe("Some")
      if (read._tag === "Some") expect(read.value._tag).toBe("Failure")
      expect(calls).toEqual({ cut: 1, mark: 0, output: 0 })
      release.native()
      expect((yield* Fiber.join(output))._tag).toBe("Failure")
      yield* Fiber.join(switching)
      expect(generations).toHaveLength(2)
      expect(generations.every((current) => !current())).toBe(true)
      expect(Option.isNone(yield* Ref.get(facade.engine))).toBe(true)
      expect(calls).toEqual({ cut: 1, mark: 0, output: 0 })
    }).pipe(Effect.provide(harness.layer))
  }))

  it.live("no facade env and no PoC env → disabled, no engine", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ env: {}, http: httpStub(() => ok(payload()), []) })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const status = yield* facade.status
        expect(status.facade).toBe("disabled")
        expect(Option.isNone(status.identity)).toBe(true)
        expect(Option.isNone(yield* Ref.get(facade.engine))).toBe(true)
        expect(status.keyOrigin).toBe("none")
        // 门面上的操作在 disabled 下 fail-closed im_unavailable
        const error = yield* facade.claim("alice").pipe(Effect.flip)
        expect(error.code).toBe("im_unavailable")
      }).pipe(Effect.provide(harness.layer))
      expect(harness.engineStarts).toEqual([])
    }),
  )

  it.live("PoC direct env config starts the engine while the facade stays disabled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        env: {
          DEEPAGENT_IM_KERNEL_APPKEY: "appkey",
          DEEPAGENT_IM_KERNEL_NAVIGATOR: "http://127.0.0.1:9002",
          DEEPAGENT_IM_KERNEL_TOKEN: "tok",
          DEEPAGENT_IM_KERNEL_USER_ID: "u-poc",
        },
        http: httpStub(() => ok(payload()), []),
      })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        expect((yield* facade.status).facade).toBe("disabled")
        expect(Option.isSome(yield* Ref.get(facade.engine))).toBe(true)
      }).pipe(Effect.provide(harness.layer))
      expect(harness.engineStarts.length).toBe(1)
      expect(harness.engineStarts[0].userID).toBe("u-poc")
      expect(harness.engineStarts[0].identity).toBeUndefined()
    }),
  )

  it.live("boot exchange success → active + engine started with the exchanged config", () =>
    Effect.gen(function* () {
      const seen: Seen[] = []
      const harness = yield* makeHarness({ env: FACADE_ENV, http: httpStub(() => ok(payload()), seen) })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const status = yield* facade.status
        expect(status.facade).toBe("active")
        expect(Option.getOrNull(status.identity)?.name).toBe("alice")
        expect(status.keyOrigin).toBe("env")
      }).pipe(Effect.provide(harness.layer))
      expect(seen).toEqual([
        { method: "POST", url: "http://facade.local/api/im/exchange", authorization: "Bearer sk-alice", body: {} },
      ])
      expect(harness.engineStarts.length).toBe(1)
      expect(harness.engineStarts[0]).toMatchObject({ token: "kt_uuid-alice", userID: "uuid-alice" })
      expect(harness.engineStarts[0].protectedMedia).toBe(false)
      expect(harness.engineStarts[0].identity).toEqual({
        uuid: "uuid-alice",
        name: "alice",
        orgAllGroupID: "org7",
        orgID: 7,
      })
    }),
  )

  it.live("the exact construction media profile opts the single actual facade engine into typed media", () =>
    Effect.gen(function* () {
      const seen: Seen[] = []
      const harness = yield* makeHarness({ env: { ...FACADE_ENV, DEEPAGENT_IM_KERNEL_MEDIA_PROFILE: "mysql-protected-media-v1" }, http: httpStub(() => ok(payload()), seen) })
      yield* Effect.gen(function* () { yield* (yield* IMFacade.Service).status }).pipe(Effect.provide(harness.layer))
      expect(harness.engineStarts).toHaveLength(1)
      expect(harness.engineStarts[0].protectedMedia).toBe(true)
      expect(seen).toHaveLength(1)
    }),
  )

  it.live("a stored rebind key wins over the env key at boot (keyOrigin=stored)", () =>
    Effect.gen(function* () {
      const auth = makeAuth({ [IMFacade.AUTH_KEY]: new Auth.Api({ type: "api", key: "sk-stored" }) })
      const seen: Seen[] = []
      const harness = yield* makeHarness({
        env: FACADE_ENV,
        http: httpStub(() => ok(payload()), seen),
        auth: auth.service,
      })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        expect((yield* facade.status).keyOrigin).toBe("stored")
      }).pipe(Effect.provide(harness.layer))
      expect(seen[0].authorization).toBe("Bearer sk-stored")
    }),
  )

  it.live("boot 409 im_not_claimed → claim_required; claim hot-starts and safely replaces the engine", () =>
    Effect.gen(function* () {
      const seen: Seen[] = []
      let claimed = false
      const http = httpStub((req) => {
        if (req.url.endsWith("/api/im/exchange"))
          return fail("im_not_claimed", "im identity not claimed for this key", 409)
        if (req.url.endsWith("/api/im/claim")) {
          claimed = true
          return ok(payload("bob", "uuid-bob"))
        }
        return fail("http_error", "unexpected", 500)
      }, seen)
      const harness = yield* makeHarness({ env: FACADE_ENV, http })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        expect((yield* SubscriptionRef.get(facade.state)).kind).toBe("claim_required")
        expect(Option.isNone(yield* Ref.get(facade.engine))).toBe(true)

        const identity = yield* facade.claim(" Ｂｏｂ ")
        expect(identity).toEqual({ uuid: "uuid-bob", name: "bob", orgID: 7, orgAllGroupID: "org7" })
        expect((yield* facade.status).facade).toBe("active")

        // Reclaim refreshes credentials; the previous SDK scope closes before rebuilding.
        yield* facade.claim("bob")
        const engine = yield* Ref.get(facade.engine)
        expect(Option.isSome(engine)).toBe(true)
      }).pipe(Effect.provide(harness.layer))
      expect(claimed).toBe(true)
      // 认领名归一化后发送
      expect(seen.find((s) => s.url.endsWith("/api/im/claim"))?.body).toEqual({ name: "bob" })
      expect(harness.engineStarts.length).toBe(2)
      expect(harness.engineStarts[0].userID).toBe("uuid-bob")
    }),
  )

  it.live("claim rejects a rule-violating name locally without any HTTP call", () =>
    Effect.gen(function* () {
      const seen: Seen[] = []
      const http = httpStub(
        (req) => (req.url.endsWith("/api/im/exchange") ? fail("im_not_claimed", "unclaimed", 409) : ok(payload())),
        seen,
      )
      const harness = yield* makeHarness({ env: FACADE_ENV, http })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const error = yield* facade.claim("bad name!").pipe(Effect.flip)
        expect(error.code).toBe("im_invalid_name")
        expect(error.status).toBe(400)
      }).pipe(Effect.provide(harness.layer))
      expect(seen.filter((s) => s.url.endsWith("/api/im/claim"))).toEqual([])
    }),
  )

  it.live("claim name_taken keeps the claim_required state and surfaces the code", () =>
    Effect.gen(function* () {
      const http = httpStub(
        (req) =>
          req.url.endsWith("/api/im/exchange")
            ? fail("im_not_claimed", "unclaimed", 409)
            : fail("im_name_taken", "name taken in org", 409),
        [],
      )
      const harness = yield* makeHarness({ env: FACADE_ENV, http })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const error = yield* facade.claim("alice").pipe(Effect.flip)
        expect(error.code).toBe("im_name_taken")
        expect((yield* SubscriptionRef.get(facade.state)).kind).toBe("claim_required")
        expect(Option.isNone(yield* Ref.get(facade.engine))).toBe(true)
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("boot 403 im_key_invalid → blocked; retryExchange recovers to active when the facade heals", () =>
    Effect.gen(function* () {
      let healed = false
      const http = httpStub((req) => {
        if (!req.url.endsWith("/api/im/exchange")) return fail("http_error", "unexpected", 500)
        return healed ? ok(payload()) : fail("im_key_invalid", "key deleted", 403)
      }, [])
      const harness = yield* makeHarness({ env: FACADE_ENV, http })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const blocked = yield* SubscriptionRef.get(facade.state)
        expect(blocked).toEqual({ kind: "blocked", code: "im_key_invalid", message: "key deleted" })
        expect(Option.isNone(yield* Ref.get(facade.engine))).toBe(true)

        // 未愈合时 retry 仍失败且状态保持 blocked
        const again = yield* facade.retryExchange.pipe(Effect.flip)
        expect(again.code).toBe("im_key_invalid")
        expect((yield* SubscriptionRef.get(facade.state)).kind).toBe("blocked")

        healed = true
        const identity = yield* facade.retryExchange
        expect(identity.name).toBe("alice")
        expect((yield* facade.status).facade).toBe("active")
        expect(Option.isSome(yield* Ref.get(facade.engine))).toBe(true)
      }).pipe(Effect.provide(harness.layer))
      expect(harness.engineStarts.length).toBe(1)
    }),
  )

  it.live("retry re-reads a replaced stored key, closes the old connection, and exposes recovery state", () =>
    Effect.gen(function* () {
      const auth = makeAuth({ [IMFacade.AUTH_KEY]: new Auth.Api({ type: "api", key: "sk-old" }) })
      const seen: Seen[] = []
      const harness = yield* makeHarness({
        env: FACADE_ENV,
        auth: auth.service,
        http: httpStub(() => ok(payload()), seen),
      })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        auth.store.set(IMFacade.AUTH_KEY, new Auth.Api({ type: "api", key: "sk-recovered" }))
        yield* facade.retryExchange
        expect(seen.map((request) => request.authorization)).toEqual(["Bearer sk-old", "Bearer sk-recovered"])
        expect(harness.engineStarts).toHaveLength(2)
        expect(harness.engineStops).toHaveLength(1)
        expect((yield* facade.status).recovery).toEqual({ status: "ready" })
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("a rejected replacement key leaves no old connection or active identity", () =>
    Effect.gen(function* () {
      const auth = makeAuth({ [IMFacade.AUTH_KEY]: new Auth.Api({ type: "api", key: "sk-old" }) })
      const seen: Seen[] = []
      let reject = false
      const harness = yield* makeHarness({
        env: FACADE_ENV,
        auth: auth.service,
        http: httpStub(() => (reject ? fail("im_key_invalid", "key rejected", 403) : ok(payload())), seen),
      })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        reject = true
        auth.store.set(IMFacade.AUTH_KEY, new Auth.Api({ type: "api", key: "sk-invalid" }))
        expect((yield* facade.retryExchange.pipe(Effect.flip)).code).toBe("im_key_invalid")
        expect(Option.isNone(yield* Ref.get(facade.engine))).toBe(true)
        expect(harness.engineStops).toHaveLength(1)
        expect((yield* facade.status).facade).toBe("blocked")
        expect((yield* facade.resolve("bob").pipe(Effect.flip)).code).toBe("im_key_invalid")
        expect(seen.map((request) => request.authorization)).toEqual(["Bearer sk-old", "Bearer sk-invalid"])
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("renews expiring credentials before the lease ends and retires the previous SDK scope", () =>
    Effect.gen(function* () {
      const seen: Seen[] = []
      const harness = yield* makeHarness({
        env: FACADE_ENV,
        credentialRefreshInterval: 10,
        engineBehavior: () => Effect.void,
        http: httpStub(
          () =>
            ok({
              ...payload(),
              kernel_token: `lease_${seen.length}`,
              credential_expires_at: Math.floor(Date.now() / 1_000) + (seen.length === 1 ? 59 : 3600),
            }),
          seen,
        ),
      })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        yield* SubscriptionRef.set(harness.engineState, "connected")
        yield* pollWithTimeout(
          Effect.sync(() => (harness.engineStarts.length >= 2 ? true : undefined)),
          "expiring credential was not refreshed",
        )
        expect(harness.engineStarts[1].token).toBe("lease_2")
        expect(harness.engineStops).toHaveLength(1)
        expect((yield* facade.status).facade).toBe("active")
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("honors a real HTTP 429 wait window and recovers the revoked engine through original exchange", () =>
    Effect.gen(function* () {
      const received = { count: 0 }
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        received.count++
        if (received.count === 2) return new Response(null, { status: 429, headers: { "Retry-After": "1" } })
        return ok({ ...payload(), kernel_token: `rate_lease_${received.count}`,
          credential_expires_at: Math.floor(Date.now() / 1000) + 3600 })
      } })
      const harness = yield* makeHarness({ env: { ...FACADE_ENV, DEEPAGENT_IM_FACADE_URL: server.url.origin },
        credentialRefreshInterval: 10, engineBehavior: () => Effect.void,
        http: yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)) })
      yield* SubscriptionRef.set(harness.engineState, "connected")
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        expect((yield* facade.retryExchange.pipe(Effect.flip)).status).toBe(429)
        yield* pollWithTimeout(Effect.sync(() => received.count === 2 ? true : undefined), "rate limit was not observed")
        const refused = yield* facade.retryExchange.pipe(Effect.flip)
        expect(refused.status).toBe(429)
        expect(refused.retryAfterMs).toBeGreaterThan(0)
        expect(received.count).toBe(2)
        expect(Option.isNone(yield* Ref.get(facade.engine))).toBe(true)
        expect((yield* facade.status).facade).toBe("blocked")
        yield* Effect.sleep("100 millis")
        expect(received.count).toBe(2)
        yield* pollWithTimeout(Effect.sync(() => harness.engineStarts.length === 2 ? true : undefined), "original exchange did not recover after backoff")
        expect(received.count).toBe(3)
        expect(harness.engineStops).toHaveLength(1)
        expect(harness.engineStarts[1].token).toBe("rate_lease_3")
        expect((yield* facade.status).facade).toBe("active")
      }).pipe(Effect.provide(harness.layer), Effect.ensuring(Effect.sync(() => server.stop(true))))
    }),
  )

  it.live("rename replaces the engine with the new name and retires the prior credential", () =>
    Effect.gen(function* () {
      const http = httpStub((req) => {
        if (req.url.endsWith("/api/im/exchange")) return ok(payload())
        if (req.url.endsWith("/api/im/rename")) return ok(payload("alice2", "uuid-alice"))
        return fail("http_error", "unexpected", 500)
      }, [])
      const harness = yield* makeHarness({ env: FACADE_ENV, http })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const before = yield* Ref.get(facade.engine)
        const identity = yield* facade.rename(" Alice2 ")
        expect(identity).toEqual({ uuid: "uuid-alice", name: "alice2", orgID: 7, orgAllGroupID: "org7" })
        const after = yield* Ref.get(facade.engine)
        expect(Option.isSome(after) && Option.isSome(before) && after.value !== before.value).toBe(true)
        expect(harness.engineStops).toHaveLength(1)
      }).pipe(Effect.provide(harness.layer))
      expect(harness.engineStarts.length).toBe(2)
    }),
  )

  it.live("rebind persists the new key (auth.json) and switches the live source", () =>
    Effect.gen(function* () {
      const auth = makeAuth()
      const seen: Seen[] = []
      const http = httpStub((req) => {
        if (req.url.endsWith("/api/im/rebind")) return ok(payload())
        if (req.url.includes("/api/im/resolve")) return ok({ uuid: "uuid-bob", name: "bob" })
        return ok(payload())
      }, seen)
      const harness = yield* makeHarness({ env: FACADE_ENV, http, auth: auth.service })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        yield* facade.rebind(" sk-new-key ")
        expect(auth.store.get(IMFacade.AUTH_KEY)).toEqual(new Auth.Api({ type: "api", key: "sk-new-key" }))
        expect((yield* facade.status).keyOrigin).toBe("stored")
        // 后续门面调用（resolve）已用新 key
        yield* facade.resolve("bob")
      }).pipe(Effect.provide(harness.layer))
      expect(seen.find((s) => s.url.endsWith("/api/im/rebind"))).toMatchObject({
        authorization: "Bearer sk-alice",
        body: { new_key: "sk-new-key" },
      })
      expect(seen.find((s) => s.url.includes("/api/im/resolve"))?.authorization).toBe("Bearer sk-new-key")
    }),
  )

  it.live("rebind surfaces im_key_already_bound and keeps the old key", () =>
    Effect.gen(function* () {
      const auth = makeAuth()
      const http = httpStub(
        (req) =>
          req.url.endsWith("/api/im/rebind")
            ? fail("im_key_already_bound", "bound to another identity", 409)
            : ok(payload()),
        [],
      )
      const harness = yield* makeHarness({ env: FACADE_ENV, http, auth: auth.service })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const error = yield* facade.rebind("sk-taken").pipe(Effect.flip)
        expect(error.code).toBe("im_key_already_bound")
        expect(auth.store.has(IMFacade.AUTH_KEY)).toBe(false)
        expect((yield* facade.status).keyOrigin).toBe("env")
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("rebind without an active identity maps the blocked state code", () =>
    Effect.gen(function* () {
      const http = httpStub(exchangeFail("im_not_claimed", 409), [])
      const harness = yield* makeHarness({ env: FACADE_ENV, http })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const error = yield* facade.rebind("sk-new").pipe(Effect.flip)
        expect(error.code).toBe("im_not_claimed")
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("resolve normalizes the name (full-width/case fold) before hitting the facade", () =>
    Effect.gen(function* () {
      const seen: Seen[] = []
      const http = httpStub(
        (req) => (req.url.includes("/api/im/resolve") ? ok({ uuid: "uuid-bob", name: "bob" }) : ok(payload())),
        seen,
      )
      const harness = yield* makeHarness({ env: FACADE_ENV, http })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const peer = yield* facade.resolve(" Ｂｏｂ ")
        expect(peer).toEqual({ uuid: "uuid-bob", name: "bob" })
      }).pipe(Effect.provide(harness.layer))
      expect(seen.find((s) => s.url.includes("/api/im/resolve"))?.url).toContain("name=bob")
    }),
  )

  it.live("a missing SDK reader rejects protected create, direct and invite before any platform side effect", () => Effect.gen(function* () {
    const seen: Seen[] = []
    const harness = yield* makeHarness({ env: FACADE_ENV, http: httpStub(() => ok(payload()), seen), protectedReader: true, readerUnavailable: true })
    yield* InstanceStore.Service.use((store) => store.provide({ directory: "/tmp/dac-im-facade-owned-fixture", worktree: "/tmp/dac-im-facade-owned-fixture", project: ReaderInstanceFixture.project("/tmp/dac-im-facade-owned-fixture") }, Effect.gen(function* () {
      const facade = yield* IMFacade.Service
      expect(yield* facade.withReader({ workspaceID: "wrk_wrong", userID: "server" }, () => Effect.void).pipe(Effect.flip)).toMatchObject({ code: "reader_scope_mismatch" })
      expect(yield* facade.createGroup({ workspaceID: "wrk_im_facade", name: "group", memberNames: ["bob"] }).pipe(Effect.flip)).toMatchObject({ code: "im_unavailable" })
      expect(yield* facade.openDirect({ workspaceID: "wrk_im_facade", name: "bob" }).pipe(Effect.flip)).toMatchObject({ code: "im_unavailable" })
      expect(yield* facade.invite({ groupID: "missing-group", name: "bob" }).pipe(Effect.flip)).toMatchObject({ code: "im_unavailable" })
      expect(seen.filter((request) => request.url.includes("/groups") || request.url.includes("/resolve"))).toHaveLength(0)
      expect(seen).toHaveLength(1)
    }).pipe(Effect.provideService(WorkspaceRef, WorkspaceV2.ID.make("wrk_im_facade"))))).pipe(Effect.provide(harness.layer))
  }))

  it.live("createGroup inspects and persists a protected pending mapping before any projection or receipt exists", () =>
    Effect.gen(function* () {
      const http = httpStub((req) => {
        if (req.url.endsWith("/api/im/groups"))
          return ok({ group_id: "kg1", name: "设计群", member_uuids: ["uuid-bob", "uuid-carol"] })
        if (req.url.endsWith("/inspect")) return ok({ conversation_type: 2, conversation_id: "kg1", org_id: 7, member_uuids: ["uuid-alice", "uuid-bob", "uuid-carol"], name: "设计群" })
        return ok(payload())
      }, [])
      const harness = yield* makeHarness({ env: FACADE_ENV, http, protectedReader: true })
      yield* InstanceStore.Service.use((store) => store.provide({ directory: "/tmp/dac-im-facade-owned-fixture", worktree: "/tmp/dac-im-facade-owned-fixture", project: ReaderInstanceFixture.project("/tmp/dac-im-facade-owned-fixture") }, Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const repo = yield* IMRepository
        const group = yield* facade.createGroup({ workspaceID: "wrk_im_facade", name: "设计群", memberNames: ["bob", "carol"] })
        expect(group.kernelConvID?.startsWith("kr1:")).toBe(true)
        expect(group.projectID).toBeNull()
        expect(group.reader).toEqual({ mode: "protected", state: "pending", liveUnread: null })
        const reader = yield* facade.withReader({ workspaceID: "wrk_im_facade", userID: "server" }, (lease) => Effect.succeed(lease.reader))
        const listed = yield* reader.withOutput({ workspaceID: "wrk_im_facade", userID: "server", groupIDs: [group.id] }, repo.listGroups({ workspaceID: "wrk_im_facade", userID: "server" }))
        expect(listed.map((g) => g.id)).toContain(group.id)
        const bound = yield* repo.getGroupByKernelConvID(group.kernelConvID!)
        expect(bound?.id).toBe(group.id)
        expect(yield* reader.read({ groupID: group.id, actionID: "pending-no-mark" }).pipe(Effect.flip)).toMatchObject({ code: "reader_required" })
      }).pipe(Effect.provideService(WorkspaceRef, WorkspaceV2.ID.make("wrk_im_facade"))))).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("openDirect inspects, reuses its protected pending pair, and rejects self-chat", () =>
    Effect.gen(function* () {
      // resolve stub 按查询名回包：alice 解析成自己（触发自聊拒绝），其它解析成 bob。
      const http = httpStub((req) => {
        if (req.url.includes("/api/im/resolve")) {
          const name = new URL(req.url).searchParams.get("name")
          return ok(name === "alice" ? { uuid: "uuid-alice", name: "alice" } : { uuid: "uuid-bob", name: "bob" })
        }
        if (req.url.endsWith("/inspect")) return ok({ conversation_type: 1, conversation_id: "uuid-bob", org_id: 7, member_uuids: ["uuid-alice", "uuid-bob"], name: "bob" })
        return ok(payload())
      }, [])
      const harness = yield* makeHarness({ env: FACADE_ENV, http, protectedReader: true })
      yield* InstanceStore.Service.use((store) => store.provide({ directory: "/tmp/dac-im-facade-owned-fixture", worktree: "/tmp/dac-im-facade-owned-fixture", project: ReaderInstanceFixture.project("/tmp/dac-im-facade-owned-fixture") }, Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const first = yield* facade.openDirect({ workspaceID: "wrk_im_facade", name: "bob" })
        expect(first.type).toBe("direct")
        expect(first.name).toBe("bob")
        expect(first.kernelConvID?.startsWith("kr1:")).toBe(true)
        expect(first.reader).toEqual({ mode: "protected", state: "pending", liveUnread: null, peerID: "uuid-bob" })
        const second = yield* facade.openDirect({ workspaceID: "wrk_im_facade", name: "bob" })
        expect(second.id).toBe(first.id)
        const self = yield* facade.openDirect({ workspaceID: "wrk_im_facade", name: "alice" }).pipe(Effect.flip)
        expect(self).toBeInstanceOf(IMKernelExchange.ExchangeError)
        expect((self as IMKernelExchange.ExchangeError).code).toBe("invalid_request")
      }).pipe(Effect.provideService(WorkspaceRef, WorkspaceV2.ID.make("wrk_im_facade"))))).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("invite requires a kernel-bound local group and adds the member row", () =>
    Effect.gen(function* () {
      const invited: unknown[] = []
      const http = httpStub((req) => {
        if (req.url.endsWith("/api/im/groups/invite")) {
          invited.push(req.body)
          return ok({})
        }
        if (req.url.includes("/api/im/resolve")) return ok({ uuid: "uuid-carol", name: "carol" })
        if (req.url.endsWith("/api/im/groups")) return ok({ group_id: "kg1", name: "g", member_uuids: [] })
        if (req.url.endsWith("/inspect")) return ok({ conversation_type: 2, conversation_id: "kg1", org_id: 7, member_uuids: ["uuid-alice", "uuid-carol"], name: "g" })
        return ok(payload())
      }, [])
      const harness = yield* makeHarness({ env: FACADE_ENV, http, protectedReader: true })
      yield* InstanceStore.Service.use((store) => store.provide({ directory: "/tmp/dac-im-facade-owned-fixture", worktree: "/tmp/dac-im-facade-owned-fixture", project: ReaderInstanceFixture.project("/tmp/dac-im-facade-owned-fixture") }, Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        // 未绑定群 ⇒ GroupLookupError
        const repo = yield* IMRepository
        const local = yield* repo.createGroup({
          workspaceID: "wrk_im_facade",
          type: "project",
          name: "local-only",
          createdBy: "server",
        })
        const unbound = yield* facade.invite({ groupID: local.id, name: "carol" }).pipe(Effect.flip)
        expect(unbound).toBeInstanceOf(IMFacade.GroupLookupError)

        const group = yield* facade.createGroup({ workspaceID: "wrk_im_facade", name: "g", memberNames: [] })
        yield* facade.invite({ groupID: group.id, name: "carol" })
        // 重复邀请幂等（本地成员行唯一索引兜底）
        yield* facade.invite({ groupID: group.id, name: "carol" })
      }).pipe(Effect.provideService(WorkspaceRef, WorkspaceV2.ID.make("wrk_im_facade"))))).pipe(Effect.provide(harness.layer))
      expect(invited).toEqual([
        { group_id: "kg1", name: "carol" },
        { group_id: "kg1", name: "carol" },
      ])
    }),
  )
})
