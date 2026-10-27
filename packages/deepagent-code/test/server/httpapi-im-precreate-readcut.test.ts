import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { inspect } from "node:util"
import { writeSync } from "node:fs"
import os from "node:os"
import { seedRipgrep } from "../lib/seed-ripgrep"
import type { Database } from "@deepagent-code/core/database/database"
import type { IMFacade } from "@/im/facade"
import type { IMKernelSync } from "@/im/kernel/sync"
import { makeNativeV2Peer } from "../im/fixture/kernel-native-v2-peer"

// The original SDK, Flag and device configuration are process-global. Keep the full
// HTTP graph in a child rather than repoint the suite's shared TEST_HOME.
async function runBoundary(directory: string) {
  const project = path.join(directory, "project")
  const data = path.join(directory, ".deepagent", "code")
  const database = path.join(directory, "http-reader.sqlite")
  await Promise.all([fs.mkdir(project, { mode: 0o700 }), fs.mkdir(data, { mode: 0o700, recursive: true })])
  await fs.writeFile(path.join(data, "deepagent.json"), JSON.stringify({ formatter: false, lsp: false, plugin: [], share: "disabled" }), { flag: "wx", mode: 0o600 })
  await fs.writeFile(path.join(project, "deepagent.json"), JSON.stringify({ formatter: false, lsp: false, plugin: [], share: "disabled" }), { flag: "wx", mode: 0o600 })
  const originalEnvironment = { ...process.env }
  Object.assign(process.env, {
    DEEPAGENT_CODE_TEST_HOME: directory,
    DEEPAGENT_CODE_HOME: data,
    DEEPAGENT_CODE_DB: database,
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
    DEEPAGENT_CODE_DISABLE_PRUNE: "1",
    DEEPAGENT_CODE_SERVER_USERNAME: "private-native-boundary",
    DEEPAGENT_CODE_SERVER_PASSWORD: "private-offline-http-password",
    DEEPAGENT_IM_KERNEL_MEDIA_PROFILE: "mysql-protected-media-v1",
  })
  delete process.env.DEEPAGENT_CODE_AUTH_CONTENT
  delete process.env.DEEPAGENT_SERVER_MODE
  const raw = await fs.open(path.join(directory, "raw-private.log"), "wx", 0o600)
  const cancellation = new AbortController()
  const stop = () => cancellation.abort()
  process.once("SIGTERM", stop)
  const observed: { database?: Database.Interface; originalEngine?: IMKernelSync.Interface; lease?: IMFacade.ReaderLease; creates: number; sends: number; login: number; inspect: number; resolved: number; configs: number } =
    { creates: 0, sends: 0, login: 0, inspect: 0, resolved: 0, configs: 0 }
  const peers: ReturnType<typeof makeNativeV2Peer>[] = []
  const readers = new WeakSet<IMFacade.ReaderLease["reader"]>()
  const outputFrames: { start: number; end: number; refreshBeforeEffect: boolean }[] = []
  const node = createServer()
  const receipt: { normalScopeClosed: boolean; beforeRows?: number; afterRows?: number; getStatus?: number; postStatus?: number; getQueries?: ReturnType<typeof makeNativeV2Peer>["requests"]; postQueries?: ReturnType<typeof makeNativeV2Peer>["requests"]; outputFrames?: typeof outputFrames; databaseIdentity?: { dev: number; ino: number } } = { normalScopeClosed: false }
  try {
    // The owned environment is fixed before production runtime imports.
    const { Effect, Layer, ConfigProvider, Logger, Context, Stream, SubscriptionRef, Option } = await import("effect")
    const { NodeHttpServer, NodeServices } = await import("@effect/platform-node")
    const { HttpRouter } = await import("effect/unstable/http")
    const { layerWebSocketConstructorGlobal } = await import("effect/unstable/socket/Socket")
    const { sql } = await import("drizzle-orm")
    const { Flag } = await import("@deepagent-code/core/flag/flag")
    Flag.DEEPAGENT_CODE_DB = database
    const { init } = await import("@deepagent-code/core/util/log")
    const { Database } = await import("@deepagent-code/core/database/database")
    const { KernelReader } = await import("@deepagent-code/core/im/kernel-reader")
    const { IMKernelSync } = await import("@/im/kernel/sync")
    const { KernelClient } = await import("@/im/kernel/client")
    const { KernelSdk } = await import("@/im/kernel/sdk")
    const { HttpApiApp } = await import("@/server/routes/instance/httpapi/server")
    const { RuntimeFlags } = await import("@/effect/runtime-flags")
    const { WebSocketTracker } = await import("@/server/routes/instance/httpapi/websocket-tracker")
    const { IMPaths, IMGroupResponse } = await import("@/server/routes/instance/httpapi/groups/im")
    const { Schema } = await import("effect")
    await init({ print: false })
    const { IMDeviceRuntimeFixture } = await import("./im-device-runtime.fixture")
    const buildEngine: IMFacade.EngineBuilder = (config, options) => {
      const native = peers[0]!
      if (config.appkey !== native.config.appkey || config.navigator !== native.config.navigator || config.token !== native.config.token || config.userID !== "receiver" || config.identity?.orgID !== 1 || config.protectedMedia !== true)
        throw new Error("HTTP_BOUNDARY_ORIGINAL_CONFIG_REQUIRED")
      observed.configs++
      const original = IMKernelSync.layer(config, options).pipe(Layer.provide(KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config)))))
      return Layer.effect(IMKernelSync.Service, Effect.gen(function* () {
        const engine = yield* IMKernelSync.Service
        observed.database = yield* Database.Service
        observed.originalEngine = engine
        const acquire = engine.acquireReader
        if (!acquire) return yield* Effect.die(new Error("HTTP_BOUNDARY_ORIGINAL_READER_REQUIRED"))
        // Observation only: all parameters, guards, effects and source custody
        // continue through the original engine and original fixed-entry engine.
        return IMKernelSync.Service.of({ ...engine, acquireReader: (context) => acquire(context).pipe(Effect.map((lease) => {
          observed.lease = lease
          if (!readers.has(lease.reader)) {
            readers.add(lease.reader)
            const output = lease.reader.withOutput
            Object.defineProperty(lease.reader, "withOutput", { configurable: true, enumerable: true, value: ((request, effect, options) => Effect.suspend(() => {
              const frame = { start: native.requests.length, end: -1, refreshBeforeEffect: options?.refreshBeforeEffect === true }
              outputFrames.push(frame)
              return output(request, effect, options).pipe(Effect.ensuring(Effect.sync(() => { frame.end = native.requests.length })))
            })) as typeof output })
          }
          return { ...lease, engine: { ...lease.engine,
            createMessage: (input) => Effect.suspend(() => { observed.creates++; return lease.engine.createMessage(input) }),
            send: (input) => Effect.suspend(() => { observed.sends++; return lease.engine.send(input) }),
          } }
        })) })
      })).pipe(Layer.provide(original))
    }
    const authorized = `Basic ${Buffer.from("private-native-boundary:private-offline-http-password").toString("base64")}`
    const program = Effect.gen(function* () {
      const certificatePath = path.join(directory, "tls", "ca.pem")
      expect(process.env.NODE_EXTRA_CA_CERTS).toBe(certificatePath)
      const platform = yield* IMDeviceRuntimeFixture.make({
        directory: path.join(directory, "platform"), uuid: "receiver",
        certificate: { ca: yield* Effect.promise(() => Bun.file(certificatePath).text()), keyPath: path.join(directory, "tls", "ca-key.pem"), certificatePath },
        protectedPath: (pathname) => pathname.startsWith("/navigator/"),
        listen: (transport) => {
          const peer = makeNativeV2Peer({ userID: "receiver", targetID: "sender", token: "daim2.private-native-v2-http", tls: transport.tls,
            device: { publicJwk: transport.identity.publicJwk, appkey: "private-native-v2-http" },
            fetch(request) { const pathname = new URL(request.url).pathname; return pathname === "/health" || pathname === "/im" ? undefined : transport.fetch(request) } })
          peer.addMessage("native-http-baseline", { content: "private native baseline" })
          peers.push(peer)
          return peer.server
        },
        async fetch(request, identity): Promise<Response> {
          const url = new URL(request.url)
          const ok = (data: unknown) => Response.json({ success: true, data }, { headers: { "cache-control": "no-store" } })
          if (url.pathname === "/navigator/general") return Response.json({ code: 0, data: { user_id: "receiver", servers: [platform.server.url.origin] } }, { headers: { "cache-control": "no-store" } })
          if (url.pathname === "/api/im/login") {
            observed.login++
            return ok({ profile: "dac-im-device-v1", entitlementID: "e".repeat(32), deviceJkt: identity.jkt, bindingVersion: 1,
              identity: { uuid: "receiver", name: "Receiver", org_id: 1, org_all_group_id: "unused" },
              kernel: { token: "daim2.private-native-v2-http", navigator: platform.server.url.origin, appkey: "private-native-v2-http", user_id: "receiver",
                socket_audience: platform.server.url.origin.replace(/^https:/, "wss:") + "/im", credential_expires_at: Math.floor(Date.now() / 1000) + 3600,
                credential_generation: 1, device_profile: "dac-im-device-v1" } })
          }
          if (url.pathname === "/api/im/resolve") { observed.resolved++; return ok({ uuid: "sender", name: "sender" }) }
          if (url.pathname.endsWith("/inspect")) {
            observed.inspect++
            const input = Schema.decodeUnknownSync(Schema.Struct({ conversation_type: Schema.Number, conversation_id: Schema.String }))(await request.json())
            return ok({ ...input, org_id: 1, name: "sender", member_uuids: input.conversation_type === 1 && input.conversation_id === "sender" ? ["receiver", "sender"] : [] })
          }
          return new Response(null, { status: 404 })
        },
      })
      const native = peers[0]!
      yield* IMDeviceRuntimeFixture.profile(platform.url)
      yield* Effect.addFinalizer(() => Effect.sync(() => node.closeAllConnections()))
      const context = yield* Layer.build(HttpRouter.serve(HttpApiApp.createRoutes(undefined, RuntimeFlags.defaultLayer, { imRuntime:
        HttpApiApp.createIMRuntimeLayer({ buildEngine, env: { DEEPAGENT_IM_KERNEL_MEDIA_PROFILE: "mysql-protected-media-v1" } }, platform.deviceLayer).pipe(Layer.provide(platform.httpLayer)),
      }), { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provide(layerWebSocketConstructorGlobal),
        Layer.provideMerge(Layer.fresh(WebSocketTracker.layer)),
        Layer.provideMerge(NodeHttpServer.layer(() => node, { port: 0, host: "127.0.0.1", gracefulShutdownTimeout: "1 second" })),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ))
      // Resolve the original tracker through Context rather than replace it.
      const tracker = Context.get(context, WebSocketTracker.Service)
      yield* Effect.addFinalizer(() => tracker.closeAll)
      const server = node.address()
      if (!server || typeof server === "string") return yield* Effect.die(new Error("HTTP_BOUNDARY_LISTENER_ADDRESS_REQUIRED"))
      const base = `http://127.0.0.1:${server.port}`
      const request = (route: string, payload?: unknown) => Effect.tryPromise(async () => {
        const url = new URL(route, base)
        url.searchParams.set("directory", project)
        const response = await fetch(url, { method: payload === undefined ? "GET" : "POST", headers: { authorization: authorized, ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })
        const body: unknown = await response.json()
        return { status: response.status, body }
      })
      if (!observed.originalEngine) return yield* Effect.die(new Error("HTTP_BOUNDARY_ORIGINAL_ENGINE_REQUIRED"))
      const connection = yield* SubscriptionRef.changes(observed.originalEngine.state).pipe(Stream.filter((state) => state !== "connecting"), Stream.runHead, Effect.timeout("3 seconds"))
      expect(Option.getOrUndefined(connection)).toBe("connected")
      const direct = yield* request(IMPaths.facadeDirect, { name: "sender" })
      expect(direct.status).toBe(200)
      const group = Schema.decodeUnknownSync(IMGroupResponse)(direct.body)
      const db = observed.database?.db
      const lease = observed.lease
      if (!db || !lease) return yield* Effect.die(new Error("HTTP_BOUNDARY_ORIGINAL_CAPTURE_REQUIRED"))
      yield* lease.assertCurrent
      yield* lease.reader.sync
      const scope = yield* KernelReader.scope(lease.reader.runtime)
      const projection = yield* KernelReader.projection(lease.reader.runtime, native.projectionKey)
      expect(KernelReader.readerVersion(lease.reader.runtime)).toBe(2)
      expect(scope?.scope_key).toBe(native.scopeKey)
      expect(projection?.server_revision).toBe(native.state.revision)
      expect(projection?.local_group_id).toBe(group.id)
      // Let the original immediate acquisition hint settle. No scheduler or
      // production timer is replaced. Any unexpected intervening sync is red.
      yield* Effect.sleep("200 millis")
      const first = yield* db.get<{ n: number }>(sql`SELECT count(*) n FROM im_messages WHERE group_id=${group.id} AND sender_id='server'`)
      receipt.beforeRows = first?.n
      const firstIdentity = yield* Effect.promise(() => fs.stat(database))
      receipt.databaseIdentity = { dev: firstIdentity.dev, ino: firstIdentity.ino }
      native.advanceRevision()
      const getStart = native.requests.length
      const denied = yield* request(IMPaths.messages.replace(":groupId", group.id))
      receipt.getStatus = denied.status
      receipt.getQueries = native.requests.slice(getStart)
      expect(denied.status).toBe(503)
      expect(receipt.getQueries.filter((item) => ["qry_delivery_reader", "qry_delivery_changes", "qry_delivery_messages"].includes(item.topic))).toHaveLength(0)
      expect(receipt.getQueries.filter((item) => item.topic === "qry_delivery_read_cut" && item.ackCode === 12203)).toHaveLength(1)
      expect(observed.creates).toBe(0)
      const postStart = native.requests.length
      const created = yield* request(IMPaths.createMessage.replace(":groupId", group.id), { senderType: "user", type: "text", content: "private HTTP precreate boundary", clientRequestID: "private-http-once" })
      receipt.postStatus = created.status
      receipt.postQueries = native.requests.slice(postStart)
      expect(created.status).toBe(200)
      expect(observed.creates).toBe(1)
      expect(observed.sends).toBe(1)
      const cuts = receipt.postQueries.filter((item) => item.topic === "qry_delivery_read_cut")
      expect(cuts).toHaveLength(5)
      expect(cuts[0]?.ackCode).toBe(12203)
      expect(cuts[1]?.ackCode).toBe(0)
      expect(cuts[1]?.requestRevision).toBe(native.state.revision)
      const frames = outputFrames.filter((frame) => frame.start >= postStart)
      receipt.outputFrames = frames
      expect(frames).toHaveLength(4)
      expect(frames.every((frame) => frame.refreshBeforeEffect && frame.end >= frame.start)).toBe(true)
      const preparation = native.requests.slice(frames[0]!.start, frames[0]!.end)
      expect(preparation.filter((item) => item.topic === "qry_delivery_read_cut").map((item) => item.ackCode)).toEqual([12203, 0])
      for (const frame of frames.slice(1)) {
        expect(native.requests.slice(frame.start, frame.end)).toEqual([expect.objectContaining({ topic: "qry_delivery_read_cut", ackCode: 0, requestRevision: native.state.revision, serverRevision: native.state.revision })])
      }
      const sync = receipt.postQueries.filter((item) => ["qry_delivery_reader", "qry_delivery_changes", "qry_delivery_messages"].includes(item.topic))
      expect(sync.filter((item) => item.topic === "qry_delivery_reader")).toHaveLength(1)
      expect(sync.length).toBeLessThanOrEqual(4)
      const after = yield* db.get<{ n: number }>(sql`SELECT count(*) n FROM im_messages WHERE group_id=${group.id} AND sender_id='server'`)
      receipt.afterRows = after?.n
      expect(after?.n).toBe((first?.n ?? 0) + 1)
      expect((yield* KernelReader.projection(lease.reader.runtime, native.projectionKey))?.server_revision).toBe(native.state.revision)
      const afterIdentity = yield* Effect.promise(() => fs.stat(database))
      expect(afterIdentity.dev).toBe(firstIdentity.dev)
      expect(afterIdentity.ino).toBe(firstIdentity.ino)
      // The fixture has no native send/receipt endpoint. A successful local
      // HTTP create and delegated send invocation do not prove a remote ACK.
    }).pipe(Effect.provide(HttpApiApp.context), Effect.scoped,
      Effect.provide(Logger.layer([Logger.make((options) => { writeSync(raw.fd, Logger.formatLogFmt.log(options) + "\n") })])))
    await Effect.runPromise(program, { signal: cancellation.signal })
    receipt.normalScopeClosed = true
    await fs.writeFile(path.join(directory, "http-boundary-safe.json"), JSON.stringify({ event: "private_http_boundary_completed", ...receipt,
      creates: observed.creates, delegatedSends: observed.sends, originalConfigBuilds: observed.configs,
      originalAuthLoginCalls: observed.login, inspectCalls: observed.inspect, resolveCalls: observed.resolved,
      qualification: "offline-original-sdk-v2-http-filedb-local-create-only", remoteACKQualified: false, publicQualified: false,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    console.info("http-precreate-readcut-safe", JSON.stringify({ getStatus: receipt.getStatus, postStatus: receipt.postStatus, creates: observed.creates, delegatedSends: observed.sends, normalScopeClosed: true, remoteACKQualified: false }))
  } catch (error) {
    await raw.write(inspect(error, { depth: 12, colors: false, maxArrayLength: 128 }) + "\n")
    await fs.writeFile(path.join(directory, "http-boundary-failed-safe.json"), JSON.stringify({ event: "private_http_boundary_failed", ...receipt,
      creates: observed.creates, delegatedSends: observed.sends, raw: path.join(directory, "raw-private.log"), remoteACKQualified: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    throw new Error(`HTTP_NATIVE_V2_BOUNDARY_FAILED_PRIVATE_DETAIL: ${directory}`)
  } finally {
    await raw.close()
    process.removeListener("SIGTERM", stop)
    Object.keys(process.env).filter((key) => !(key in originalEnvironment)).forEach((key) => { delete process.env[key] })
    Object.assign(process.env, originalEnvironment)
  }
}


test("original V2 HTTP GET remains read-only and text precreate refreshes before one local create", async () => {
  if (process.env.DAC_HTTP_PRECREATE_READCUT_CHILD === "1") {
    const directory = process.env.DAC_HTTP_PRECREATE_READCUT_DIRECTORY
    if (!directory || !path.isAbsolute(directory)) throw new Error("HTTP_BOUNDARY_OWN_DIRECTORY_REQUIRED")
    return runBoundary(directory)
  }
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-http-precreate-readcut-")))
  await fs.chmod(directory, 0o700)
  await seedRipgrep(directory)
  const { certificate } = await import("../installation/fixture/event-investigation-installation")
  const tls = await certificate(path.join(directory, "tls"))
  if (!await Bun.file(path.join(directory, ".deepagent", "code", "cache", "bin", process.platform === "win32" ? "rg.exe" : "rg")).exists())
    throw new Error("HTTP_BOUNDARY_LOCAL_RIPGREP_REQUIRED")
  const stdout = await fs.open(path.join(directory, "child-stdout-private.log"), "wx", 0o600)
  const stderr = await fs.open(path.join(directory, "child-stderr-private.log"), "wx", 0o600)
  // Preserve only the ordinary execution environment. The package preload
  // supplies the dev owner chain; no provider credentials cross into this child.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL|DEEPAGENT_|DAC_HTTP_PRECREATE_READCUT_)/.test(key)))
  const child = Bun.spawn([process.execPath, "--conditions=browser", "test", "--preload", path.resolve(import.meta.dir, "../fixture/cli-secret-store.ts"), import.meta.path, "--timeout", "30000"], {
    cwd: path.resolve(import.meta.dir, "../.."), stdout: stdout.fd, stderr: stderr.fd,
    env: { ...inherited, NODE_EXTRA_CA_CERTS: tls.certificatePath, DAC_HTTP_PRECREATE_READCUT_CHILD: "1", DAC_HTTP_PRECREATE_READCUT_DIRECTORY: directory,
      DEEPAGENT_CODE_TEST_HOME: directory, DEEPAGENT_CODE_HOME: path.join(directory, ".deepagent", "code"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1", DEEPAGENT_CODE_DISABLE_PRUNE: "1" },
  })
  try {
    const exit = await child.exited
    if (exit !== 0) throw new Error(`HTTP_NATIVE_V2_BOUNDARY_CHILD_FAILED_PRIVATE_DETAIL: ${directory}`)
    const receipt = await Bun.file(path.join(directory, "http-boundary-safe.json")).json()
    const terminal = await Bun.file(path.join(directory, "child-stderr-private.log")).text()
    expect(receipt.normalScopeClosed).toBe(true)
    console.info("http-precreate-readcut-isolated-safe", JSON.stringify({ childExit: exit, normalScopeClosed: receipt.normalScopeClosed,
      getStatus: receipt.getStatus, postStatus: receipt.postStatus, creates: receipt.creates, delegatedSends: receipt.delegatedSends,
      getQueries: receipt.getQueries, postQueries: receipt.postQueries, outputFrames: receipt.outputFrames, databaseIdentity: receipt.databaseIdentity,
      terminal: terminal.match(/^\s*\d+ (?:pass|fail|expect\(\) calls).*$/gm), remoteACKQualified: false, publicQualified: false }))
  } finally {
    await stdout.close()
    await stderr.close()
    // SIGTERM requests the original Scope shutdown; never force-kill a blocked
    // owner or label an unjoined child as a successful normal close.
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited }
  }
  await fs.rm(directory, { recursive: true, force: true })
}, 60_000)
