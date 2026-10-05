import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Ref, SubscriptionRef } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import type { IMBroadcaster } from "@deepagent-code/core/im/websocket"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { Auth } from "@/auth"
import { IMFacade } from "@/im/facade"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { IMKernelSync } from "@/im/kernel/sync"
import type { KernelConfig } from "@/im/kernel/config"
import type { KernelClient } from "@/im/kernel/client"
import { testEffect } from "../lib/effect"

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
  readonly layer: Layer.Layer<IMFacade.Service | IMRepository, unknown, never>
  readonly engineStarts: KernelConfig.Info[]
  readonly engineState: SubscriptionRef.SubscriptionRef<KernelClient.ConnectionState>
}

/** 每个用例一套独立图层（内存库 + 罐装 HTTP + 假引擎）。引擎构建走 Layer.unwrap 以便持有 state。 */
const makeHarness = (options: {
  env: Readonly<Record<string, string | undefined>>
  http: HttpClient.HttpClient
  auth?: Auth.Interface
  engineBehavior?: (config: KernelConfig.Info) => Effect.Effect<void, unknown>
}): Effect.Effect<Harness, never, never> =>
  Effect.gen(function* () {
    const engineStarts: KernelConfig.Info[] = []
    const engineState = yield* SubscriptionRef.make<KernelClient.ConnectionState>("disconnected")
    const buildEngine = (config: KernelConfig.Info) =>
      Layer.unwrap(
        Effect.gen(function* () {
          engineStarts.push(config)
          if (options.engineBehavior) yield* options.engineBehavior(config)
          return Layer.succeed(
            IMKernelSync.Service,
            IMKernelSync.Service.of({
              state: engineState,
              send: () => Effect.void,
              drainPending: Effect.void,
              recovery: yield* SubscriptionRef.make<IMKernelSync.RecoveryState>({ status: "ready" }),
              catchUp: Effect.void,
            }),
          )
        }),
      )
    const database = Database.layerFromPath(":memory:")
    const repo = IMRepositoryLive.pipe(Layer.provide(database))
    const facade = IMFacade.layer({ env: options.env, buildEngine }).pipe(
      Layer.provide(repo),
      Layer.provide(Layer.succeed(IMBroadcasterService, broadcaster)),
      Layer.provide(agentProvider),
      Layer.provide(Layer.succeed(Auth.Service, options.auth ?? makeAuth().service)),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, options.http)),
    )
    return { layer: Layer.mergeAll(facade, repo), engineStarts, engineState }
  })

const exchangeFail =
  (code: string, status: number, message = `${code} from stub`) =>
  (_: { method: string; url: string }) =>
    fail(code, message, status)

describe("IMFacade", () => {
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
      expect(harness.engineStarts[0].identity).toEqual({
        uuid: "uuid-alice",
        name: "alice",
        orgAllGroupID: "org7",
        orgID: 7,
      })
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

  it.live("boot 409 im_not_claimed → claim_required; claim hot-starts the engine once", () =>
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

        // 同 key 重认领幂等：引擎不会被第二次构建（进程单例防呆）。
        yield* facade.claim("bob")
        const engine = yield* Ref.get(facade.engine)
        expect(Option.isSome(engine)).toBe(true)
      }).pipe(Effect.provide(harness.layer))
      expect(claimed).toBe(true)
      // 认领名归一化后发送
      expect(seen.find((s) => s.url.endsWith("/api/im/claim"))?.body).toEqual({ name: "bob" })
      expect(harness.engineStarts.length).toBe(1)
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

  it.live("rename updates the identity without rebuilding the engine", () =>
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
        expect(Option.isSome(after) && Option.isSome(before) && after.value === before.value).toBe(true)
      }).pipe(Effect.provide(harness.layer))
      expect(harness.engineStarts.length).toBe(1)
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

  it.live("createGroup mirrors the kernel group locally with members + binding", () =>
    Effect.gen(function* () {
      const http = httpStub((req) => {
        if (req.url.endsWith("/api/im/groups"))
          return ok({ group_id: "kg1", name: "设计群", member_uuids: ["uuid-bob", "uuid-carol"] })
        return ok(payload())
      }, [])
      const harness = yield* makeHarness({ env: FACADE_ENV, http })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const repo = yield* IMRepository
        const group = yield* facade.createGroup({ workspaceID: "ws", name: "设计群", memberNames: ["bob", "carol"] })
        expect(group.kernelConvID).toBe("k:2:kg1")
        // server 操作者坐 creator ⇒ listGroups 可见；成员含解析 uuid + 本身份 uuid
        const listed = yield* repo.listGroups({ workspaceID: "ws", userID: "server" })
        expect(listed.map((g) => g.id)).toContain(group.id)
        const bound = yield* repo.getGroupByKernelConvID("k:2:kg1")
        expect(bound?.id).toBe(group.id)
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("openDirect resolves, reuses the direct pair, and binds k:1:<uuid>", () =>
    Effect.gen(function* () {
      // resolve stub 按查询名回包：alice 解析成自己（触发自聊拒绝），其它解析成 bob。
      const http = httpStub((req) => {
        if (req.url.includes("/api/im/resolve")) {
          const name = new URL(req.url).searchParams.get("name")
          return ok(name === "alice" ? { uuid: "uuid-alice", name: "alice" } : { uuid: "uuid-bob", name: "bob" })
        }
        return ok(payload())
      }, [])
      const harness = yield* makeHarness({ env: FACADE_ENV, http })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        const first = yield* facade.openDirect({ workspaceID: "ws", name: "bob" })
        expect(first.type).toBe("direct")
        expect(first.name).toBe("bob")
        expect(first.kernelConvID).toBe("k:1:uuid-bob")
        const second = yield* facade.openDirect({ workspaceID: "ws", name: "bob" })
        expect(second.id).toBe(first.id)
        const self = yield* facade.openDirect({ workspaceID: "ws", name: "alice" }).pipe(Effect.flip)
        expect(self).toBeInstanceOf(IMKernelExchange.ExchangeError)
        expect((self as IMKernelExchange.ExchangeError).code).toBe("invalid_request")
      }).pipe(Effect.provide(harness.layer))
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
        return ok(payload())
      }, [])
      const harness = yield* makeHarness({ env: FACADE_ENV, http })
      yield* Effect.gen(function* () {
        const facade = yield* IMFacade.Service
        // 未绑定群 ⇒ GroupLookupError
        const repo = yield* IMRepository
        const local = yield* repo.createGroup({
          workspaceID: "ws",
          type: "project",
          name: "local-only",
          createdBy: "server",
        })
        const unbound = yield* facade.invite({ groupID: local.id, name: "carol" }).pipe(Effect.flip)
        expect(unbound).toBeInstanceOf(IMFacade.GroupLookupError)

        const group = yield* facade.createGroup({ workspaceID: "ws", name: "g", memberNames: [] })
        yield* facade.invite({ groupID: group.id, name: "carol" })
        // 重复邀请幂等（本地成员行唯一索引兜底）
        yield* facade.invite({ groupID: group.id, name: "carol" })
      }).pipe(Effect.provide(harness.layer))
      expect(invited).toEqual([
        { group_id: "kg1", name: "carol" },
        { group_id: "kg1", name: "carol" },
      ])
    }),
  )
})
