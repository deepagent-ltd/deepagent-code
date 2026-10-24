// The full HTTP graph uses an owned DeviceStore and real HTTPS/DPoP transport.
// The controlled platform implements current activation/login; it is not Native qualification.
import { afterEach, beforeEach, describe, expect } from "bun:test"
import path from "node:path"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { IMDeviceStore } from "@/im/device-store"
import { SecretStore } from "@/mcp/secret-store"
import { Database } from "@deepagent-code/core/database/database"
import { init } from "@deepagent-code/core/util/log"
import { sql } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { IMDeviceRuntimeFixture } from "./im-device-runtime.fixture"
import { IMReaderSDKFixture } from "./im-reader-sdk.fixture"

void init({ print: false })

type FacadeMode = "active" | "unclaimed" | "name_taken" | "disabled" | "outage" | "recoverable"
let facadeMode: FacadeMode = "active"
let lastNameBody: unknown
let platformMutations = 0
let activationPurchases = 0

const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
)
const servedRoutes: Layer.Layer<never, unknown, HttpServer.HttpServer> = Layer.unwrap(
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: false })
    const name = { value: "alice" }
    const uuid = "a".repeat(32)
    const platform =
      facadeMode === "disabled"
        ? undefined
        : yield* IMDeviceRuntimeFixture.make({
            directory: path.join(directory, "platform"),
            uuid,
            bound: facadeMode !== "unclaimed",
            async fetch(request, identity) {
              const url = new URL(request.url)
              const body = request.method === "POST" ? await request.json() : undefined
              const ok = (data: unknown) => Response.json({ success: true, message: "", data })
              const legacy = () => ({
                kernel_token: "daim2.facade-fixture",
                navigator_url: "https://127.0.0.1:9",
                appkey: "appkey_1",
                identity: { uuid, name: name.value, org_id: 7, org_all_group_id: "org7" },
                ttl: { msg_life_time_ms: 259200000 },
                device: {
                  profile: "dac-im-device-v1",
                  entitlementID: "e".repeat(32),
                  deviceJkt: identity.jkt,
                  bindingVersion: 1,
                  credentialGeneration: 1,
                  socketAudience: "wss://127.0.0.1:9/im",
                },
              })
              if (url.pathname === "/api/im/login" && facadeMode === "outage")
                return Response.json(
                  { success: false, code: "im_unavailable", message: "Controlled platform outage" },
                  { status: 503 },
                )
              if (url.pathname === "/api/im/login")
                return ok({
                  profile: "dac-im-device-v1",
                  entitlementID: "e".repeat(32),
                  deviceJkt: identity.jkt,
                  bindingVersion: 1,
                  identity: legacy().identity,
                  kernel: {
                    appkey: "appkey_1",
                    navigator: "https://127.0.0.1:9",
                    socket_audience: "wss://127.0.0.1:9/im",
                    token: "daim2.facade-fixture",
                    user_id: uuid,
                    credential_expires_at: Math.floor(Date.now() / 1000) + 3600,
                    credential_generation: 1,
                    device_profile: "dac-im-device-v1",
                  },
                })
              if (url.pathname === "/api/im/activation/quote")
                return ok({
                  quoteID: "owned-quote",
                  priceCredits: 1,
                  quotaCost: 1,
                  expiresAt: Date.now() + 60000,
                  entitlementExpiresAt: null,
                })
              if (url.pathname === "/api/im/activation") {
                activationPurchases++
                name.value = body.name
                return ok({
                  profile: "dac-im-device-v1",
                  transactionID: body.transactionID,
                  method: body.method,
                  state: "succeeded",
                  chargedCredits: 1,
                  entitlementExpiresAt: null,
                  entitlementID: "e".repeat(32),
                  deviceJkt: identity.jkt,
                  bindingVersion: 1,
                  imCredential: `iml2.${"a".repeat(64)}`,
                  identity: legacy().identity,
                })
              }
              if (url.pathname === "/api/im/rename") {
                lastNameBody = body
                if (facadeMode === "name_taken")
                  return Response.json(
                    { success: false, code: "im_name_taken", message: "name taken in org" },
                    { status: 409 },
                  )
                name.value = body.name
                return ok(legacy())
              }
              if (url.pathname === "/api/im/resolve")
                return url.searchParams.get("name") === "bob"
                  ? ok({ uuid: "uuid-bob", name: "bob" })
                  : Response.json(
                      { success: false, code: "im_not_found", message: "no such name in org" },
                      { status: 404 },
                    )
              if (url.pathname === "/api/im/groups") {
                platformMutations++
                return ok({
                  group_id: "kg1",
                  name: body.name,
                  member_uuids: body.member_names.map((value: string) => `uuid-${value}`),
                })
              }
              if (url.pathname === "/api/im/groups/invite") {
                platformMutations++
                return ok({})
              }
              return Response.json(
                { success: false, code: "http_error", message: "Unexpected controlled platform path" },
                { status: 500 },
              )
            },
          })
    yield* IMDeviceRuntimeFixture.profile(platform?.url ?? null)
    const device =
      platform?.deviceLayer ??
      Layer.succeed(
        IMDeviceStore.Service,
        IMDeviceStore.make({
          directory: path.join(directory, "device"),
          backend: SecretStore.fileBackend(path.join(directory, "custody.json")),
        }),
      )
    const sdk =
      facadeMode === "outage" || facadeMode === "recoverable"
        ? IMReaderSDKFixture.make({ version: 2, userID: uuid })
        : undefined
    const runtime = HttpApiApp.createIMRuntimeLayer({ env: {}, buildEngine: sdk?.buildEngine }, device)
    const imRuntime = platform ? runtime.pipe(Layer.provide(platform.httpLayer)) : runtime
    return HttpRouter.serve(HttpApiApp.createRoutes(undefined, undefined, { imRuntime }), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(Layer.provide(layerWebSocketConstructorGlobal))
  }),
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
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
  facadeMode = "active"
  activationPurchases = 0
  lastNameBody = undefined
  await disposeAllInstances()
  await resetDatabase()
})

describe("IM B2 facade HttpApi", () => {
  describe("facade explicitly disabled in the global profile", () => {
    beforeEach(() => {
      facadeMode = "disabled"
    })

    it.live("plans and entitlement GET routes expose unknown without bootstrapping an identity or mutation", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const q = `directory=${encodeURIComponent(directory)}`
        const mutations = platformMutations
        const plans = yield* requestRaw(`/api/v1/im/plans?${q}`)
        const entitlement = yield* requestRaw(`/api/v1/im/entitlement?${q}`)
        expect(plans).toEqual({ status: 200, body: { state: "unknown", reason: "service_unconfigured" } })
        expect(entitlement).toEqual({ status: 200, body: { state: "unknown", reason: "service_unconfigured" } })
        expect(platformMutations).toBe(mutations)
      }),
    )

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

  describe("explicit device activation and retired claim boundary", () => {
    beforeEach(() => {
      facadeMode = "unclaimed"
    })

    it.live(
      "explicit activation stores the original device login; retired claim stays denied and rename normalizes names",
      () =>
        Effect.gen(function* () {
          const directory = yield* tmpdirScoped({ git: true })
          const q = `directory=${encodeURIComponent(directory)}`
          expect(yield* requestRaw(`/api/v1/im/status?${q}`)).toMatchObject({
            status: 200,
            body: { facade: "blocked", blocked: { code: "im_activation_required" } },
          })
          const quote = yield* requestJson<{ quoteID: string }>(`/api/v1/im/activation/quote?${q}`)
          const activated = yield* requestRaw(
            `/api/v1/im/activation?${q}`,
            post({
              transactionID: "owned_activation_0001",
              name: "alice",
              method: "api_key",
              credential: "sk-owned-fixture",
              quoteID: quote.quoteID,
            }),
          )
          expect(activated).toMatchObject({
            status: 200,
            body: { state: "succeeded", chargedCredits: 1, credentialStored: true },
          })
          expect(activationPurchases).toBe(1)
          const retired = yield* requestRaw(`/api/v1/im/facade/claim?${q}`, post({ name: "bob" }))
          expect(retired).toMatchObject({ status: 409, body: { data: { code: "im_activation_required" } } })
          facadeMode = "name_taken"
          const taken = yield* requestRaw(`/api/v1/im/facade/rename?${q}`, post({ name: "bob" }))
          expect(taken).toMatchObject({ status: 409, body: { data: { code: "im_name_taken" } } })
          facadeMode = "active"
          const renamed = yield* requestJson<{ uuid: string; name: string }>(
            `/api/v1/im/facade/rename?${q}`,
            post({ name: " Ｂｏｂ " }),
          )
          expect(renamed).toMatchObject({ uuid: "a".repeat(32), name: "bob" })
          expect(lastNameBody).toEqual({ name: "bob" })
          expect(activationPurchases).toBe(1)
          expect(yield* requestRaw(`/api/v1/im/status?${q}`)).toMatchObject({
            status: 503,
            body: { name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable", operation: "current" } },
          })
        }),
    )

    it.live("local activation name-rule violations fail 400 without touching the platform", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const q = `directory=${encodeURIComponent(directory)}`
        const before = activationPurchases
        const result = yield* requestRaw(
          `/api/v1/im/activation?${q}`,
          post({
            transactionID: "owned_invalid_name_01",
            name: "bad name!",
            method: "api_key",
            credential: "sk-owned-fixture",
            quoteID: "owned-quote",
          }),
        )
        expect(result).toMatchObject({
          status: 400,
          body: { name: "IM_FACADE_BAD_REQUEST", data: { code: "im_activation_invalid" } },
        })
        expect(activationPurchases).toBe(before)
        expect(platformMutations).toBe(0)
      }),
    )
  })

  describe("active identity", () => {
    beforeEach(() => {
      facadeMode = "active"
      platformMutations = 0
    })

    it.live(
      "boot exchange permits directory resolve with a normalized name while the unreachable reader fails current status",
      () =>
        Effect.gen(function* () {
          const directory = yield* tmpdirScoped({ git: true })
          const q = `directory=${encodeURIComponent(directory)}`

          expect(yield* requestRaw(`/api/v1/im/status?${q}`)).toMatchObject({
            status: 503,
            body: { name: "IM_READER_UNAVAILABLE", data: { code: "reader_unavailable", operation: "current" } },
          })

          const resolved = yield* requestJson<{ uuid: string; name: string }>(
            `/api/v1/im/facade/resolve?${q}&name=${encodeURIComponent(" Ｂｏｂ ")}`,
          )
          expect(resolved).toEqual({ uuid: "uuid-bob", name: "bob" })

          const missing = yield* requestRaw(`/api/v1/im/facade/resolve?${q}&name=nobody`)
          expect(missing.status).toBe(404)
          expect(missing.body).toMatchObject({ data: { code: "im_not_found" } })
        }),
    )

    it.live(
      "an unreachable protected reader rejects direct, group and invite before platform mutation or local projection",
      () =>
        Effect.gen(function* () {
          const directory = yield* tmpdirScoped({ git: false })
          const q = `directory=${encodeURIComponent(directory)}`
          for (const [path, body] of [
            ["/api/v1/im/facade/direct", { name: "bob" }],
            ["/api/v1/im/facade/groups", { name: "设计群", memberNames: ["bob"] }],
            ["/api/v1/im/facade/groups/no-protected-group/invite", { name: "bob" }],
          ] as const) {
            expect(yield* requestRaw(`${path}?${q}`, post(body))).toMatchObject({
              status: 502,
              body: { name: "IM_FACADE_UNAVAILABLE", data: { code: "im_unavailable" } },
            })
          }
          expect(platformMutations).toBe(0)
          const db = (yield* Database.Service).db
          expect(
            (yield* db.get<{ count: number }>(
              sql`SELECT count(*) AS count FROM im_groups WHERE kernel_conv_id IS NOT NULL`,
            ))?.count,
          ).toBe(0)
          expect(
            (yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM im_kernel_reader_message`))?.count,
          ).toBe(0)
          expect(
            (yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM im_kernel_reader_read_intent`))?.count,
          ).toBe(0)
        }),
    )

    describe("controlled platform recovery", () => {
      beforeEach(() => {
        facadeMode = "outage"
      })
      it.live("retry after a facade outage recovers the actual connected protected reader", () =>
        Effect.gen(function* () {
          const directory = yield* tmpdirScoped({ git: true })
          const q = `directory=${encodeURIComponent(directory)}`
          expect(yield* requestRaw(`/api/v1/im/status?${q}`)).toMatchObject({
            status: 200,
            body: { facade: "blocked", blocked: { code: "im_unavailable" } },
          })
          facadeMode = "recoverable"
          const identity = yield* requestJson<{ name: string }>(`/api/v1/im/facade/retry?${q}`, post({}))
          expect(identity.name).toBe("alice")
          expect(yield* requestRaw(`/api/v1/im/status?${q}`)).toMatchObject({
            status: 200,
            body: { facade: "active", identity: { name: "alice" }, kernel: "connected" },
          })
          const db = (yield* Database.Service).db
          expect((yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session_input`))?.count).toBe(0)
        }),
      )
    })
  })
})
