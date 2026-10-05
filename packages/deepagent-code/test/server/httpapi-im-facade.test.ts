// B2 门面 HTTP 端点的端到端测试：真实 server 栈（HttpApiApp.routes 全图，含真 IMFacade 层）+
// 一个假 new-api 门面（plain node http server，beforeAll 起在 127.0.0.1 随机端口）。
//
// 拓扑说明（非显而易见处）：
// - 门面坐标走 env（DEEPAGENT_IM_FACADE_URL/KEY），IMFacade 层在 route graph 构建时读取——
//   所以 env 必须在 per-test 图层构建之前就位（beforeAll/嵌套 beforeEach，与 httpapi-im-b3 的
//   flag 模式同理）。
// - 假门面的行为由模块级 `facadeBehavior` 可变引用驱动：boot exchange 在图层构建期发生，
//   各 describe 在自己的 beforeEach 里先选好行为模式。
// - "disabled" 用例需要 env 缺席——嵌套 beforeEach 在图层构建前删掉 env，afterEach 恢复。
// - rebind 故意不在 HTTP 层测（成功路径会写真 auth.json；门面单测 test/im/im-facade.test.ts
//   已用内存 Auth 覆盖持久化语义）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import Http from "node:http"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { Database } from "@deepagent-code/core/database/database"
import * as Log from "@deepagent-code/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

// ── 假门面（new-api /api/im/*）─────────────────────────────────────────────────

type FacadeReply = { status: number; body: unknown }

const ok = (data: unknown): FacadeReply => ({ status: 200, body: { success: true, message: "", data } })
const fail = (code: string, message: string, status: number): FacadeReply => ({
  status,
  body: { success: false, code, message },
})

const payload = (name = "alice", uuid = "uuid-alice") => ({
  kernel_token: `kt_${uuid}`,
  navigator_url: "http://127.0.0.1:9002",
  appkey: "appkey_1",
  identity: { uuid, name, org_id: 7, org_all_group_id: "org7" },
  ttl: { msg_life_time_ms: 259200000 },
})

type FacadeMode = "active" | "unclaimed" | "name_taken"
let facadeMode: FacadeMode = "active"
let lastClaimBody: unknown

const facadeBehavior = (req: { method: string; pathname: string; query: URLSearchParams; body?: unknown }): FacadeReply => {
  if (req.pathname === "/api/im/exchange") {
    if (facadeMode === "active") return ok(payload())
    return fail("im_not_claimed", "im identity not claimed for this key", 409)
  }
  if (req.pathname === "/api/im/claim") {
    lastClaimBody = req.body
    if (facadeMode === "name_taken") return fail("im_name_taken", "name taken in org", 409)
    return ok(payload("bob", "uuid-bob"))
  }
  if (req.pathname === "/api/im/resolve") {
    const name = req.query.get("name")
    if (name === "bob") return ok({ uuid: "uuid-bob", name: "bob" })
    return fail("im_not_found", "no such name in org", 404)
  }
  if (req.pathname === "/api/im/groups") {
    const body = req.body as { name: string; member_names: string[] }
    return ok({ group_id: "kg1", name: body.name, member_uuids: body.member_names.map((n) => `uuid-${n}`) })
  }
  if (req.pathname === "/api/im/groups/invite") return ok({})
  return fail("http_error", `unexpected ${req.pathname}`, 500)
}

let facadeServer: Http.Server | undefined
let facadeURL = ""
const originalFacadeURL = process.env.DEEPAGENT_IM_FACADE_URL
const originalFacadeKey = process.env.DEEPAGENT_IM_FACADE_KEY

beforeAll(async () => {
  facadeServer = Http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost")
      const raw = Buffer.concat(chunks).toString("utf8")
      const reply = facadeBehavior({
        method: req.method ?? "GET",
        pathname: url.pathname,
        query: url.searchParams,
        body: raw ? JSON.parse(raw) : undefined,
      })
      res.writeHead(reply.status, { "content-type": "application/json" })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => facadeServer!.listen(0, "127.0.0.1", resolve))
  const address = facadeServer.address()
  if (!address || typeof address === "string") throw new Error("facade stub has no address")
  facadeURL = `http://127.0.0.1:${address.port}`
  process.env.DEEPAGENT_IM_FACADE_URL = facadeURL
  process.env.DEEPAGENT_IM_FACADE_KEY = "sk-test"
})

afterAll(async () => {
  if (originalFacadeURL === undefined) delete process.env.DEEPAGENT_IM_FACADE_URL
  else process.env.DEEPAGENT_IM_FACADE_URL = originalFacadeURL
  if (originalFacadeKey === undefined) delete process.env.DEEPAGENT_IM_FACADE_KEY
  else process.env.DEEPAGENT_IM_FACADE_KEY = originalFacadeKey
  await new Promise<void>((resolve) => facadeServer?.close(() => resolve()))
})

// ── 真实 server 栈（与 httpapi-im-b3 同一 harness）─────────────────────────────

const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

// 同 b3：env 在 per-test 图层构建时读取，ConfigProvider 必须每次构建重新快照 live env。
const freshEnvProvider = Layer.suspend(() => ConfigProvider.layer(ConfigProvider.fromEnv()))

const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(freshEnvProvider)),
)

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function requestRaw(path: string, init?: RequestInit) {
  return request(path, init).pipe(
    Effect.flatMap((response) => response.json.pipe(Effect.map((body) => ({ status: response.status, body })))),
  )
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(
    Effect.flatMap((response: HttpClientResponse.HttpClientResponse) =>
      response.status === 200
        ? response.json.pipe(Effect.map((value) => value as T))
        : response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(`HTTP ${response.status}: ${text}`)))),
    ),
  )
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

interface StatusBody {
  facade: string
  identity: { uuid: string; name: string; orgID: number; orgAllGroupID: string } | null
  blocked: { code: string; message: string } | null
  kernel: string | null
  keyOrigin: string
}

afterEach(async () => {
  process.env.DEEPAGENT_IM_FACADE_URL = facadeURL
  process.env.DEEPAGENT_IM_FACADE_KEY = "sk-test"
  facadeMode = "active"
  await disposeAllInstances()
  await resetDatabase()
})

describe("IM B2 facade HttpApi", () => {
  describe("facade unconfigured (env removed before the layer builds)", () => {
    beforeEach(() => {
      delete process.env.DEEPAGENT_IM_FACADE_URL
      delete process.env.DEEPAGENT_IM_FACADE_KEY
    })

    it.live("status reports disabled; mutations fail-closed im_unavailable", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const q = `directory=${encodeURIComponent(directory)}`
        const status = yield* requestJson<StatusBody>(`/api/v1/im/status?${q}`)
        expect(status.facade).toBe("disabled")
        expect(status.identity).toBeNull()
        expect(status.keyOrigin).toBe("none")

        const claim = yield* requestRaw(`/api/v1/im/facade/claim?${q}`, post({ name: "alice" }))
        expect(claim.status).toBe(502)
        expect(claim.body).toMatchObject({
          name: "IM_FACADE_UNAVAILABLE",
          data: { code: "im_unavailable" },
        })
      }),
    )
  })

  describe("unclaimed key → claim flow", () => {
    beforeEach(() => {
      facadeMode = "unclaimed"
    })

    it.live("boot 409 lands claim_required; claim normalizes the name and activates", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const q = `directory=${encodeURIComponent(directory)}`

        const boot = yield* requestJson<StatusBody>(`/api/v1/im/status?${q}`)
        expect(boot.facade).toBe("claim_required")

        // 重名：409 + 业务码透传
        facadeMode = "name_taken"
        const taken = yield* requestRaw(`/api/v1/im/facade/claim?${q}`, post({ name: "alice" }))
        expect(taken.status).toBe(409)
        expect(taken.body).toMatchObject({ data: { code: "im_name_taken" } })
        const stillUnclaimed = yield* requestJson<StatusBody>(`/api/v1/im/status?${q}`)
        expect(stillUnclaimed.facade).toBe("claim_required")

        // 换名成功：归一化（全半角+大小写折叠+trim）后发送；状态进 active
        facadeMode = "unclaimed"
        const identity = yield* requestJson<{ uuid: string; name: string; orgID: number; orgAllGroupID: string }>(
          `/api/v1/im/facade/claim?${q}`,
          post({ name: " Ｂｏｂ " }),
        )
        expect(identity).toEqual({ uuid: "uuid-bob", name: "bob", orgID: 7, orgAllGroupID: "org7" })
        expect(lastClaimBody).toEqual({ name: "bob" })

        const active = yield* requestJson<StatusBody>(`/api/v1/im/status?${q}`)
        expect(active.facade).toBe("active")
        expect(active.identity?.name).toBe("bob")
        expect(active.keyOrigin).toBe("env")
      }),
    )

    it.live("local name-rule violations fail 400 without touching the facade", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const q = `directory=${encodeURIComponent(directory)}`
        const result = yield* requestRaw(`/api/v1/im/facade/claim?${q}`, post({ name: "bad name!" }))
        expect(result.status).toBe(400)
        expect(result.body).toMatchObject({ data: { code: "im_invalid_name" } })
      }),
    )
  })

  describe("active identity", () => {
    beforeEach(() => {
      facadeMode = "active"
    })

    it.live("boot exchange activates; resolve hits the directory with a normalized name", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const q = `directory=${encodeURIComponent(directory)}`

        const status = yield* requestJson<StatusBody>(`/api/v1/im/status?${q}`)
        expect(status.facade).toBe("active")
        expect(status.identity?.name).toBe("alice")

        const resolved = yield* requestJson<{ uuid: string; name: string }>(
          `/api/v1/im/facade/resolve?${q}&name=${encodeURIComponent(" Ｂｏｂ ")}`,
        )
        expect(resolved).toEqual({ uuid: "uuid-bob", name: "bob" })

        const missing = yield* requestRaw(`/api/v1/im/facade/resolve?${q}&name=nobody`)
        expect(missing.status).toBe(404)
        expect(missing.body).toMatchObject({ data: { code: "im_not_found" } })
      }),
    )

    it.live("openDirect binds k:1:<uuid>; facade groups mirror locally with k:2: and accept invites", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const q = `directory=${encodeURIComponent(directory)}`

        const direct = yield* requestJson<{ id: string; type: string; kernelConvID: string | null }>(
          `/api/v1/im/facade/direct?${q}`,
          post({ name: "bob" }),
        )
        expect(direct.type).toBe("direct")
        expect(direct.kernelConvID).toBe("k:1:uuid-bob")

        const created = yield* requestJson<{ id: string; name: string; kernelConvID: string | null }>(
          `/api/v1/im/facade/groups?${q}`,
          post({ name: "设计群", memberNames: ["bob"] }),
        )
        expect(created.name).toBe("设计群")
        expect(created.kernelConvID).toBe("k:2:kg1")

        const invited = yield* requestRaw(`/api/v1/im/facade/groups/${created.id}/invite?${q}`, post({ name: "bob" }))
        expect(invited.status).toBe(200)
        expect(invited.body).toEqual({ ok: true })

        // 群列表把绑定透出（GUI 徽标的数据源）；本地镜像对 server 操作者可见。
        const groups = yield* requestJson<Array<{ id: string; kernelConvID: string | null }>>(`/api/v1/im/groups?${q}`)
        expect(groups.find((g) => g.id === created.id)?.kernelConvID).toBe("k:2:kg1")
        expect(groups.find((g) => g.id === direct.id)?.kernelConvID).toBe("k:1:uuid-bob")
      }),
    )

    it.live("retry after a facade outage recovers to active (engine hot-start path)", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const q = `directory=${encodeURIComponent(directory)}`
        // boot 已 active；retry 幂等再换一轮坐标。
        const identity = yield* requestJson<{ name: string }>(`/api/v1/im/facade/retry?${q}`, post({}))
        expect(identity.name).toBe("alice")
      }),
    )
  })
})
