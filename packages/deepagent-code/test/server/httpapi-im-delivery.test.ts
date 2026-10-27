import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createServer } from "node:http"
import { seedRipgrep } from "../lib/seed-ripgrep"
import type { IMFacade } from "@/im/facade"
import type { IMKernelSync } from "@/im/kernel/sync"
import type { Database } from "@deepagent-code/core/database/database"
import type { IMRepositoryInterface } from "@deepagent-code/core/im/repository"
import { makeNativeV2Peer } from "../im/fixture/kernel-native-v2-peer"

type Message = { id: string; transport?: { state: "prepared" | "acknowledged" | "unknown"; reason?: string } }

async function run(directory: string) {
  process.env.DEEPAGENT_CODE_TEST_HOME = directory
  process.env.DEEPAGENT_CODE_HOME = path.join(directory, ".deepagent", "code")
  process.env.DEEPAGENT_CODE_DB = path.join(directory, "http.sqlite")
  const project = path.join(directory, "workspace")
  await fs.mkdir(project, { mode: 0o700 })
  await seedRipgrep(directory)
  const { Effect, Layer, ConfigProvider, Stream, SubscriptionRef, Option } = await import("effect")
  const { NodeHttpServer, NodeServices } = await import("@effect/platform-node")
  const { HttpRouter } = await import("effect/unstable/http")
  const { layerWebSocketConstructorGlobal } = await import("effect/unstable/socket/Socket")
  const { Database } = await import("@deepagent-code/core/database/database")
  const { Flag } = await import("@deepagent-code/core/flag/flag")
  Flag.DEEPAGENT_CODE_DB = process.env.DEEPAGENT_CODE_DB
  const { IMRepository } = await import("@deepagent-code/core/im/repository")
  const { KernelDelivery } = await import("@deepagent-code/core/im/kernel-delivery")
  const { KernelSdk } = await import("@/im/kernel/sdk")
  const { KernelClient } = await import("@/im/kernel/client")
  const { IMKernelSync } = await import("@/im/kernel/sync")
  const { HttpApiApp } = await import("@/server/routes/instance/httpapi/server")
  const { RuntimeFlags } = await import("@/effect/runtime-flags")
  const { IMDeviceRuntimeFixture } = await import("./im-device-runtime.fixture")
  const captured: {
    engine?: IMKernelSync.Interface
    lease?: IMFacade.ReaderLease
    database?: Database.Interface
    repository?: IMRepositoryInterface
  } = {}
  const peers: ReturnType<typeof makeNativeV2Peer>[] = []
  const stage = { value: "device" }
  await Effect.runPromise(
    Effect.gen(function* () {
      const certificatePath = path.join(directory, "tls", "ca.pem")
      const platform = yield* IMDeviceRuntimeFixture.make({
        directory: path.join(directory, "platform"),
        uuid: "receiver",
        certificate: {
          ca: yield* Effect.promise(() => Bun.file(certificatePath).text()),
          keyPath: path.join(directory, "tls", "ca-key.pem"),
          certificatePath,
        },
        protectedPath: (pathname) => pathname.startsWith("/navigator/"),
        listen: (transport) => {
          const peer = makeNativeV2Peer({
            userID: "receiver",
            targetID: "sender",
            token: "daim2.http-delivery-owned",
            tls: transport.tls,
            device: { publicJwk: transport.identity.publicJwk, appkey: "http-delivery-owned" },
            fetch(request) {
              const pathname = new URL(request.url).pathname
              return pathname === "/health" || pathname === "/im" ? undefined : transport.fetch(request)
            },
          })
          peer.addMessage("kernel-inbound", { content: "original reader inbound" })
          peers.push(peer)
          return peer.server
        },
        async fetch(request, identity): Promise<Response> {
          const pathname = new URL(request.url).pathname
          const ok = (data: unknown) =>
            Response.json({ success: true, data }, { headers: { "cache-control": "no-store" } })
          if (pathname === "/navigator/general")
            return Response.json(
              { code: 0, data: { user_id: "receiver", servers: [platform.url] } },
              { headers: { "cache-control": "no-store" } },
            )
          if (pathname.endsWith("/login"))
            return ok({
              profile: "dac-im-device-v1",
              entitlementID: "e".repeat(32),
              deviceJkt: identity.jkt,
              bindingVersion: 1,
              identity: { uuid: "receiver", name: "Receiver", org_id: 1, org_all_group_id: "unused" },
              kernel: {
                token: "daim2.http-delivery-owned",
                navigator: platform.url,
                appkey: "http-delivery-owned",
                user_id: "receiver",
                socket_audience: platform.url.replace(/^https:/, "wss:") + "/im",
                credential_expires_at: Math.floor(Date.now() / 1000) + 3600,
                credential_generation: 1,
                device_profile: "dac-im-device-v1",
              },
            })
          if (pathname.endsWith("/resolve")) return ok({ uuid: "sender", name: "Sender" })
          if (pathname.endsWith("/inspect"))
            return ok({
              conversation_type: 1,
              conversation_id: "sender",
              org_id: 1,
              member_uuids: ["receiver", "sender"],
              name: "Sender",
            })
          return new Response(null, { status: 404 })
        },
      })
      yield* IMDeviceRuntimeFixture.profile(platform.url)
      const buildEngine: IMFacade.EngineBuilder = (config, options) =>
        Layer.effect(
          IMKernelSync.Service,
          Effect.gen(function* () {
            const engine = yield* IMKernelSync.Service
            captured.engine = engine
            captured.database = yield* Database.Service
            captured.repository = yield* IMRepository
            return IMKernelSync.Service.of({
              ...engine,
              acquireReader: (context) =>
                engine.acquireReader!(context).pipe(
                  Effect.tap((lease) =>
                    Effect.sync(() => {
                      captured.lease = lease
                    }),
                  ),
                ),
            })
          }),
        ).pipe(
          Layer.provide(
            IMKernelSync.layer(config, options).pipe(
              Layer.provide(KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config)))),
            ),
          ),
        )
      const node = createServer()
      yield* Effect.addFinalizer(() => Effect.sync(() => node.closeAllConnections()))
      const serving = HttpRouter.serve(
        HttpApiApp.createRoutes(undefined, RuntimeFlags.defaultLayer, {
          imRuntime: HttpApiApp.createIMRuntimeLayer(
            { buildEngine, env: { DEEPAGENT_IM_KERNEL_MEDIA_PROFILE: "mysql-protected-media-v1" } },
            platform.deviceLayer,
          ).pipe(Layer.provide(platform.httpLayer)),
        }),
        { disableListenLog: true, disableLogger: true },
      ).pipe(
        Layer.provide(layerWebSocketConstructorGlobal),
        Layer.provideMerge(
          NodeHttpServer.layer(() => node, { port: 0, host: "127.0.0.1", gracefulShutdownTimeout: "1 second" }),
        ),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      )
      yield* Layer.build(serving)
      const address = node.address()
      if (!address || typeof address === "string" || !captured.engine)
        return yield* Effect.die(new Error("Owned HTTP listener/engine unavailable"))
      const connected = yield* SubscriptionRef.changes(captured.engine.state).pipe(
        Stream.filter((state) => state !== "connecting"),
        Stream.runHead,
        Effect.timeout("3 seconds"),
      )
      expect(Option.getOrUndefined(connected)).toBe("connected")
      const request = (route: string, payload?: unknown) =>
        Effect.promise(async () => {
          const url = new URL(route, `http://127.0.0.1:${address.port}`)
          url.searchParams.set("directory", project)
          const response = await fetch(url, {
            method: payload === undefined ? "GET" : "POST",
            ...(payload === undefined
              ? {}
              : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
          })
          return { status: response.status, body: await response.json() }
        })
      stage.value = "ordinary admission"
      const group = yield* request("/api/v1/im/groups", { type: "project", name: "Local delivery" })
      expect(group.status).toBe(200)
      const local = yield* request(`/api/v1/im/groups/${group.body.id}/messages`, {
        senderType: "user",
        type: "text",
        content: "legacy outbound",
        clientRequestID: "legacy",
      })
      expect(local.status).toBe(200)
      expect(local.body.transport).toBeUndefined()
      const repo = captured.repository
      if (!repo) return yield* Effect.die(new Error("Original repository not captured"))
      yield* repo.bindKernelConversation({ groupID: group.body.id, kernelConvID: "k:1:sender" })
      const legacyWrite = yield* request(`/api/v1/im/groups/${group.body.id}/messages`, {
        senderType: "user",
        type: "text",
        content: "no current mapping",
        clientRequestID: "unavailable",
      })
      expect(legacyWrite.status).toBe(503)
      expect(legacyWrite.body).toMatchObject({ name: "IM_READER_UNAVAILABLE" })
      stage.value = "current source"
      const direct = yield* request("/api/v1/im/facade/direct", { name: "Sender" })
      expect(direct.status).toBe(200)
      const lease = captured.lease
      if (!lease || !captured.database) return yield* Effect.die(new Error("Original reader/database not captured"))
      const prepared = yield* lease.engine.createMessage({
        groupID: direct.body.id,
        senderID: "server",
        senderType: "user",
        type: "text",
        content: "prepared",
        clientRequestID: "prepared",
      })
      const acknowledged = yield* lease.engine.createMessage({
        groupID: direct.body.id,
        senderID: "server",
        senderType: "user",
        type: "text",
        content: "acknowledged",
        clientRequestID: "acknowledged",
      })
      const authority = KernelDelivery.runtime(lease.engine.receiptSource!)
      yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(authority)))
      const dispatch = yield* KernelDelivery.withVerification(
        authority,
        { conversationType: 1, conversationID: "sender", orgID: 1, memberIDs: ["receiver", "sender"] },
        repo.claimKernelDelivery(authority, acknowledged.id),
      )
      expect(dispatch).toBeDefined()
      expect(yield* repo.acknowledgeKernelDelivery(authority, dispatch!, "kernel-acknowledged")).toBe(true)
      // This is a real Core acknowledgement transition; no remote ACK is claimed.
      yield* Effect.sleep("200 millis")
      const db = captured.database.db
      const before = yield* db.all("SELECT * FROM im_kernel_delivery ORDER BY message_id")
      const identity = yield* Effect.promise(() => fs.stat(process.env.DEEPAGENT_CODE_DB!))
      yield* Effect.addFinalizer(() => db.run("PRAGMA query_only=OFF").pipe(Effect.orDie))
      yield* db.run("PRAGMA query_only=ON")
      stage.value = "readonly HTTP"
      const legacyPage = yield* request(`/api/v1/im/groups/${group.body.id}/messages?limit=100`)
      expect(legacyPage.status).toBe(503)
      expect(legacyPage.body).toMatchObject({ name: "IM_READER_UNAVAILABLE" })
      const legacyDetail = yield* request(`/api/v1/im/messages/${local.body.id}`)
      expect(legacyDetail.status).toBe(503)
      const page = yield* request(`/api/v1/im/groups/${direct.body.id}/messages?limit=100`)
      expect(page.status).toBe(200)
      const messages = page.body.messages as Message[]
      expect(messages).toHaveLength(3)
      const states = Object.fromEntries(messages.map((message) => [message.id, message.transport]))
      expect(states[prepared.id]).toEqual({ state: "prepared" })
      expect(states[acknowledged.id]).toEqual({ state: "acknowledged" })
      const inbound = messages.filter((message) => ![prepared.id, acknowledged.id].includes(message.id))
      expect(inbound).toHaveLength(1)
      expect(inbound[0]!.transport).toBeUndefined()
      const detail = yield* request(`/api/v1/im/messages/${acknowledged.id}`)
      expect(detail.status).toBe(200)
      expect(detail.body.transport).toEqual({ state: "acknowledged" })
      expect(JSON.stringify(page)).not.toContain("credentialFingerprint")
      expect(JSON.stringify(page)).not.toContain("dispatch_owner")
      expect(yield* db.all("SELECT * FROM im_kernel_delivery ORDER BY message_id")).toEqual(before)
      expect(yield* db.get("SELECT count(*) AS n FROM im_messages")).toEqual({ n: 4 })
      expect(yield* db.get("SELECT count(*) AS n FROM session_input")).toEqual({ n: 0 })
      expect(yield* db.get("SELECT count(*) AS n FROM session_provider_attempt")).toEqual({ n: 0 })
      const after = yield* Effect.promise(() => fs.stat(process.env.DEEPAGENT_CODE_DB!))
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: identity.dev, ino: identity.ino })
      yield* db.run("PRAGMA query_only=OFF")
      console.info(
        "owned-http-delivery-safe",
        JSON.stringify({
          localAdmission: "no transport receipt",
          protectedLegacy: 503,
          page: page.status,
          currentMessages: messages.length,
          states: Object.values(states),
          readonlyLedgerUnchanged: true,
          sameDatabase: true,
          queries: peers[0]!.requests.length,
          remoteACKQualified: false,
        }),
      )
    }).pipe(
      Effect.provide(HttpApiApp.context),
      Effect.onError(() => Effect.sync(() => console.error({ stage: stage.value, directory }))),
      Effect.scoped,
    ),
  )
}

test("actual HTTP keeps transport observation readonly and local admission separate from remote ACK", async () => {
  if (process.env.IM_HTTP_DELIVERY_CHILD === "1") return run(process.env.IM_HTTP_DELIVERY_ROOT!)
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-http-delivery-")))
  const { certificate } = await import("../installation/fixture/event-investigation-installation")
  const tls = await certificate(path.join(directory, "tls"))
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--preload",
      path.resolve(import.meta.dir, "../fixture/cli-secret-store.ts"),
      import.meta.path,
      "--timeout",
      "30000",
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        IM_HTTP_DELIVERY_CHILD: "1",
        IM_HTTP_DELIVERY_ROOT: directory,
        NODE_EXTRA_CA_CERTS: tls.certificatePath,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 29000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    await Bun.write(path.join(directory, "child.log"), stdout + "\n" + stderr)
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stderr).toContain("1 pass")
    expect(stderr).toContain("0 fail")
    console.info(
      "owned-http-delivery-terminal",
      JSON.stringify({
        terminal: stderr.match(/^\s*\d+ (?:pass|fail|expect\(\) calls).*$/gm),
        facts: stdout.split("\n").find((line) => line.startsWith("owned-http-delivery-safe ")),
      }),
    )
    await fs.rm(directory, { recursive: true, force: true })
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}, 30000)
