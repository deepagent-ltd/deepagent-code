import { expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { ConfigProvider, Context, Effect, Layer, Option, Schema, SubscriptionRef } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import assert from "node:assert/strict"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Global } from "@deepagent-code/core/global"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Project } from "@/project/project"
import { Workspace } from "@/control-plane/workspace"
import { Session } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { GlobalPaths } from "@/server/routes/instance/httpapi/groups/global"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { IMKernelSync } from "@/im/kernel/sync"
import { IMFacade } from "@/im/facade"
import { KernelLiveFirstSeenFixture } from "../im/fixture/kernel-live-first-seen"
import { MediaFileTrace } from "../im/fixture/kernel-media-file-trace"
import { MediaEffectTrace } from "../im/fixture/kernel-media-effect-trace"
import { MediaEffectListener } from "../im/fixture/kernel-media-effect-listener"
import { MediaSdkOnce } from "../im/fixture/kernel-media-sdk-once"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { IMDeviceRuntimeFixture } from "./im-device-runtime.fixture"

const it = testEffect(NodeServices.layer)
const post = (value: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) })
type Metadata = { objectID: string; uploadID: string; filename: string; mime: string; sizeBytes: number; sha256: string; state: string;
  receivedBytes: number; receivedChunks: number; createdAt: number; expiresAt: number }

const runBoundary = (concurrent: boolean, diagnostic: boolean) => Effect.gen(function* () {
  const root = process.env.DAC_IM_MEDIA_BATCH_ROOT
  assert(root && path.isAbsolute(root) && path.basename(root).startsWith("dac-im-media-product-lanes-batch-") && path.dirname(root) === (yield* Effect.promise(() => fs.realpath(os.tmpdir()))))
  const certificatePath = path.join(root, "tls", "ca.pem")
  assert(process.env.NODE_EXTRA_CA_CERTS === certificatePath)
  const originalDatabase = Flag.DEEPAGENT_CODE_DB
  Flag.DEEPAGENT_CODE_DB = path.join(root, "fresh-media.sqlite")
  yield* Effect.addFinalizer(() => Effect.sync(() => { Flag.DEEPAGENT_CODE_DB = originalDatabase }))
  const fileTrace = MediaFileTrace.install(yield* Effect.promise(() => fs.realpath(Global.Path.data)))
  yield* Effect.addFinalizer(() => Effect.sync(fileTrace.restore))
  const events: { operation: string; phase: string }[] = []
  const effectFacts: MediaEffectTrace.Fact[] = []
  const objects = new Map<string, { metadata: Metadata; received: ReturnType<typeof createHash> }>()
  const chunks: number[] = []
  const outbound = { count: 0 }
  const engines: IMKernelSync.Interface[] = []
  const progress = { phase: "boundary:start", startedAt: Date.now() }
  const writeProgress = () => fs.writeFile(path.join(root, "progress-safe.json"), JSON.stringify({
    phase: progress.phase, elapsedMs: Date.now() - progress.startedAt,
    events: events.reduce<Record<string, number>>((counts, event) => {
      const key = `${event.operation}:${event.phase}`
      counts[key] = (counts[key] ?? 0) + 1
      return counts
    }, {}),
    effectFacts: effectFacts.reduce<Record<string, number>>((counts, fact) => {
      const key = `${fact.stage}:${fact.operation}:${fact.phase}`
      counts[key] = (counts[key] ?? 0) + 1
      return counts
    }, {}),
    fileCounts: fileTrace.counts, outboundPublishes: outbound.count, objects: objects.size, chunks: chunks.length,
  }))
  const phase = (value: string) => Effect.promise(() => {
    progress.phase = value
    return writeProgress()
  })
  const observation = setInterval(() => { void writeProgress().catch(() => {}) }, 1000)
  observation.unref()
  yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(observation)))
  yield* Effect.addFinalizer(() => phase("scope:closed"))
  yield* phase("native:starting")
  const native = yield* IMDeviceRuntimeFixture.make({ directory: path.join(root, "platform"), uuid: "receiver",
    certificate: { ca: yield* Effect.promise(() => Bun.file(certificatePath).text()), keyPath: path.join(root, "tls", "ca-key.pem"), certificatePath },
    protectedPath: (pathname) => pathname.startsWith("/navigator/"),
    listen: (transport) => KernelLiveFirstSeenFixture.make({ tls: transport.tls,
      device: { publicJwk: transport.identity.publicJwk, appkey: "private-http-media", token: "daim2.private-http-media" },
      fetch(request) { const pathname = new URL(request.url).pathname; return pathname === "/health" || pathname === "/im" ? undefined : transport.fetch(request) },
      response(topic, request, original) {
        if (topic === "qry_delivery_capabilities") return { name: "DeliveryCapabilities", value: { version: 1, profile: "mysql-receipt-v1", maxLifetimeMs: 259200000, maxContentBytes: 65536, eventualDelivery: false } }
        if (topic === "qry_delivery_output_proof") {
          const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ pending: Schema.Struct({ conversationType: Schema.Literal(1), targetId: Schema.Literal("sender") }) })))(request.outputRows)
          return { name: "DeliveryOutputProofResult", value: { version: 2, scopeKey: request.scopeKey, serverNow: Date.now(), rows } }
        }
        if (!original || !topic.startsWith("qry_delivery_")) return original
        return { ...original, value: { ...original.value, version: 2, ...(topic === "qry_delivery_reader" ? { outputProofAvailable: true } : {}), ...(topic === "qry_delivery_changes" ? { items: [], scanProjectionKey: "" } : {}) } }
      },
      outboundPublish: () => { outbound.count++; return { code: 0, messageId: "private-http-batch-ack", timestamp: Date.now(), msgSeqNo: 1 } },
    }).server,
    async fetch(request, identity): Promise<Response> {
      const pathname = new URL(request.url).pathname
      const ok = (data: unknown) => Response.json({ success: true, data }, { headers: { "cache-control": "no-store" } })
      if (pathname === "/navigator/general") return Response.json({ code: 0, data: { user_id: "receiver", servers: [native.server.url.origin] } }, { headers: { "cache-control": "no-store" } })
      if (pathname.startsWith("/api/im/")) {
        const input = request.method === "POST" ? await request.json() : undefined
        if (pathname.endsWith("/login")) return ok({ profile: "dac-im-device-v1", entitlementID: "e".repeat(32), deviceJkt: identity.jkt, bindingVersion: 1,
          identity: { uuid: "receiver", name: "Receiver", org_id: 1, org_all_group_id: "unused" },
          kernel: { token: "daim2.private-http-media", navigator: native.server.url.origin, appkey: "private-http-media", user_id: "receiver",
            socket_audience: native.server.url.origin.replace(/^https:/, "wss:") + "/im", credential_expires_at: Math.floor(Date.now() / 1000) + 3600,
            credential_generation: 1, device_profile: "dac-im-device-v1" } })
        if (pathname.endsWith("/resolve")) return ok({ uuid: "sender", name: "Sender" })
        if (pathname.endsWith("/inspect")) return ok({ conversation_type: input.conversation_type, conversation_id: input.conversation_id, org_id: 1, member_uuids: ["receiver", "sender"], name: "Sender" })
        return new Response(null, { status: 404 })
      }
        if (!concurrent) expect(request.headers.get("authorization")).toBe("DPoP daim2.private-http-media")
        if (pathname.endsWith("/capabilities")) return new Response(JSON.stringify({ version: 1, profile: "mysql-protected-media-v1", capability: "dac:media.v1", readerVersion: 2,
          maxFileBytes: 10485760, maxAttachments: 4, chunkBytes: 262144, ttlMillis: 86400000, authenticatedContent: true }), { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } })
        if (request.method === "POST" && pathname.endsWith("/objects")) {
          const input = await request.json()
          const createdAt = Date.now()
          const objectID = createHash("sha256").update(input.upload.uploadID).digest("hex")
          objects.set(objectID, { metadata: { objectID, uploadID: input.upload.uploadID, filename: input.upload.filename, mime: "", sizeBytes: input.upload.sizeBytes, sha256: input.upload.sha256,
            state: "uploading", receivedBytes: 0, receivedChunks: 0, createdAt, expiresAt: createdAt + 86400000 }, received: createHash("sha256") })
        }
        const id = pathname.endsWith("/objects") ? Array.from(objects.keys()).at(-1)! : pathname.split("/")[5]
        const object = objects.get(id)!
        if (request.method === "PUT") {
          if (!concurrent) expect(Number(pathname.split("/").at(-1))).toBe(object.metadata.receivedChunks)
          const body = new Uint8Array(await request.arrayBuffer())
          if (!concurrent) expect(body.byteLength).toBe(Math.min(262144, object.metadata.sizeBytes - object.metadata.receivedBytes))
          chunks.push(body.byteLength)
          object.received.update(body)
          object.metadata.receivedBytes += body.byteLength
          object.metadata.receivedChunks++
        }
        if (pathname.endsWith("/finalize")) {
          expect(object.received.digest("hex")).toBe(object.metadata.sha256)
          object.metadata.state = "uploaded_unbound"
          object.metadata.mime = object.metadata.filename === "pixel.png" ? "image/png" : "application/octet-stream"
        }
        return new Response(JSON.stringify(object.metadata), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } })
    },
  })
  yield* phase("native:started")
  yield* IMDeviceRuntimeFixture.profile(native.url)
  yield* Effect.addFinalizer(() => Effect.sync(() => native.server.stop(true)))
  const buildEngine: IMFacade.EngineBuilder = (config, options) => {
    const original = KernelSdk.liveFromConfig(config)
    const observed = Layer.effect(KernelSdk.Service, Effect.gen(function* () {
      const sdk = yield* KernelSdk.Service
      const checkpoint = <A>(operation: string, effect: Effect.Effect<A, KernelSdk.KernelError>) => Effect.sync(() => { events.push({ operation, phase: "Effect-start" }) }).pipe(
        Effect.andThen(effect), Effect.tap(() => Effect.sync(() => { events.push({ operation, phase: "Effect-returned" }) })),
        Effect.tapError(() => Effect.sync(() => { events.push({ operation, phase: "Effect-error" }) })),
      )
      return KernelSdk.Service.of({ ...sdk, media: { ...sdk.media!,
        begin: (input) => checkpoint("begin", sdk.media!.begin(input)),
        putChunk: (input) => checkpoint("chunk", sdk.media!.putChunk(input)),
        finalize: (input) => checkpoint("finalize", sdk.media!.finalize(input)),
      } })
    })).pipe(Layer.provide(original))
    return IMKernelSync.layer(config, options).pipe(Layer.provide(KernelClient.layer.pipe(Layer.provide(observed))))
  }
  const observeEngine = (build: IMFacade.EngineBuilder): IMFacade.EngineBuilder => (config, options) => {
    const original = build(config, options)
    return Layer.effect(IMKernelSync.Service, Effect.gen(function* () {
      const sync = yield* IMKernelSync.Service
      engines.push(sync)
      return sync
    })).pipe(Layer.provide(original))
  }
  const node = createServer()
  const upgrades = new Set<import("node:stream").Duplex>()
  node.on("upgrade", (_request, socket) => { upgrades.add(socket); socket.once("close", () => upgrades.delete(socket)) })
  yield* Effect.addFinalizer(() => Effect.sync(() => node.closeAllConnections()))
  yield* Effect.addFinalizer(() => Effect.sync(() => { upgrades.forEach((socket) => socket.destroy()); upgrades.clear() }))
  const imOptions = { buildEngine: observeEngine(buildEngine), env: { DEEPAGENT_IM_KERNEL_MEDIA_PROFILE: "mysql-protected-media-v1" } }
  const imRuntime = HttpApiApp.createIMRuntimeLayer(imOptions, native.deviceLayer).pipe(Layer.provide(native.httpLayer))
  const serving = HttpRouter.serve(HttpApiApp.createRoutes(undefined, RuntimeFlags.layer({ v4FileUploadEnabled: true }), { imRuntime }), { disableListenLog: true, disableLogger: true }).pipe(Layer.provide(layerWebSocketConstructorGlobal),
    Layer.provideMerge(NodeHttpServer.layer(() => node, { port: 0, host: "127.0.0.1", gracefulShutdownTimeout: "1 second" })), Layer.provideMerge(NodeServices.layer))
  const instance = InstanceStore.defaultLayer.pipe(Layer.provide(Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })))
  const workspace = Workspace.defaultLayer.pipe(Layer.provide(InstanceStore.defaultLayer), Layer.provide(InstanceBootstrap.defaultLayer))
  const originalEnv = { password: process.env.DEEPAGENT_CODE_SERVER_PASSWORD, upload: process.env.DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED }
  if (diagnostic) {
    process.env.DEEPAGENT_CODE_SERVER_PASSWORD = "private-http-media"
    process.env.DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED = "true"
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      if (originalEnv.password === undefined) delete process.env.DEEPAGENT_CODE_SERVER_PASSWORD
      if (originalEnv.password !== undefined) process.env.DEEPAGENT_CODE_SERVER_PASSWORD = originalEnv.password
      if (originalEnv.upload === undefined) delete process.env.DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED
      if (originalEnv.upload !== undefined) process.env.DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED = originalEnv.upload
    }))
  }
  yield* phase("listener:starting")
  const normal = diagnostic ? yield* MediaEffectListener.start({ port: 0, buildEngine: observeEngine(MediaEffectTrace.builder((fact) => { effectFacts.push(fact); if (fact.phase === "final") throw new Error("QA diagnostic failure") })), env: {
    DEEPAGENT_IM_KERNEL_MEDIA_PROFILE: "mysql-protected-media-v1",
  }, deviceStore: native.deviceLayer }).pipe(Effect.provide(native.httpLayer)) : undefined
  const context = diagnostic ? Context.empty() : yield* Layer.build(Layer.mergeAll(instance, Project.defaultLayer, Session.defaultLayer, workspace, Database.defaultLayer, serving).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_SERVER_PASSWORD: "private-http-media" }))),
  ))
  yield* phase("listener:started")
  const address = node.address()
  if (!normal && (!address || typeof address === "string")) return yield* Effect.die(new Error("Private HTTP listener unavailable"))
  const baseURL = normal?.url ?? `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  return yield* Effect.gen(function* () {
    const directory = diagnostic ? path.join(root, "A", "workspace") : yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
    if (diagnostic) yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
    const request = (route: string, input: RequestInit = {}) => Effect.promise(async () => {
      const url = new URL(route, baseURL)
      url.searchParams.set("directory", directory)
      const headers = new Headers(input.headers)
      headers.set("authorization", "Basic " + Buffer.from("deepagent-code:private-http-media").toString("base64"))
      const operation = route.endsWith("/attachments") ? "upload" : route.endsWith("/messages") ? "send" : route.endsWith("/direct") ? "direct" : "metadata"
      progress.phase = `http:${operation}:request`
      await writeProgress()
      const response = await fetch(url, { ...input, headers, signal: AbortSignal.timeout(15000) })
      progress.phase = `http:${operation}:headers`
      await writeProgress()
      const body = await response.json()
      progress.phase = `http:${operation}:body`
      await writeProgress()
      return { status: response.status, body }
    })
    yield* phase("kernel:connecting")
    expect(engines).toHaveLength(1)
    yield* pollWithTimeout(SubscriptionRef.get(engines[0]!.state).pipe(Effect.map((state) => state === "connected" ? true : undefined)), "Original SDK did not finish its authenticated connection before the single create", "3 seconds")
    yield* phase("kernel:connected")
    const group = yield* request("/api/v1/im/facade/direct", post({ name: "Sender" }))
    if (group.status !== 200) console.info("owned-media-group-refusal", JSON.stringify(group))
    expect(group.status).toBe(200)
    expect(group.body.reader).toMatchObject({ mode: "protected", state: "pending" })
    // The former50MiB upload remains a real multipart request and must be
    // rejected before any SDK Begin, send, attachment row or message mutation.
    const oversized = new FormData()
    oversized.set("file", new File([Buffer.alloc(52428800, 77)], "legacy-50MiB.bin", { type: "application/octet-stream" }))
    oversized.set("groupId", group.body.id)
    const rejected = yield* request("/api/v1/im/attachments", { method: "POST", body: oversized })
    expect(rejected).toMatchObject({ status: 413, body: { name: "FILE_TOO_LARGE", data: { maxBytes: 10485760 } } })
    expect(events).toHaveLength(0)
    expect(effectFacts.filter((fact) => fact.stage === "sdk-effect" && fact.operation === "begin")).toHaveLength(0)
    expect(objects.size).toBe(0)
    expect(chunks).toHaveLength(0)
    expect(outbound.count).toBe(0)
    const database = diagnostic ? yield* Layer.build(Database.defaultLayer).pipe(Effect.map((context) => Context.get(context, Database.Service))) : yield* Database.Service
    expect((yield* database.db.get<{ n: number }>(sql`SELECT count(*) n FROM im_attachments`))?.n).toBe(0)
    expect((yield* database.db.get<{ n: number }>(sql`SELECT count(*) n FROM im_messages`))?.n).toBe(0)
    expect((yield* database.db.get<{ n: number }>(sql`SELECT count(*) n FROM im_kernel_delivery`))?.n).toBe(0)
    if (diagnostic) {
      const denied = yield* Effect.promise(() => fetch(baseURL + "/api/v1/im/status?directory=" + encodeURIComponent(directory)))
      expect(denied.status).toBe(401)
      yield* Effect.promise(() => fs.mkdir(path.join(root, "files")))
      yield* Effect.promise(() => Bun.write(path.join(root, "A", "auth.txt"), "Basic " + Buffer.from("deepagent-code:private-http-media").toString("base64")))
      const inputs = [{ filename: "large.bin", bytes: Buffer.alloc(10485760, 77), mime: "application/octet-stream" }, { filename: "empty.txt", bytes: Buffer.alloc(0), mime: "text/plain" },
        { filename: "note.txt", bytes: Buffer.alloc(2432, 78), mime: "text/plain" }, { filename: "pixel.png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQmln+HwAERQIyazZiBgAAAABJRU5ErkJggg==", "base64"), mime: "image/png" }]
      const files = yield* Effect.forEach(inputs, (file) => Effect.promise(async () => {
        const output = path.join(root, "files", file.filename)
        await fs.writeFile(output, file.bytes)
        return { path: output, filename: file.filename, bytes: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex"), mime: file.mime }
      }))
      yield* phase("sdk:once-send")
      const result = yield* Effect.promise(() => MediaSdkOnce.run({ peers: { A: { url: baseURL, directory, authorizationFile: path.join(root, "A", "auth.txt") } }, groups: { A: { id: group.body.id } }, files }, root))
      expect(result.safe.terminal).toBe("success")
      expect(result.safe.status).toBe(200)
      yield* pollWithTimeout(Effect.sync(() => outbound.count === 1 ? true : undefined), "Original queued media dispatch did not reach its single protobuf publish", "3 seconds")
      expect(outbound.count).toBe(1)
      const begins = effectFacts.filter((fact) => fact.stage === "sdk-effect" && fact.operation === "begin" && fact.phase === "returned")
      expect(begins).toHaveLength(4)
      expect(begins.every((begin) => begin.requestID > 0 && begin.idHash?.length === 64 && effectFacts.some((fact) => fact.stage === "reader-effect" && fact.requestID === begin.requestID && fact.phase === "returned") && effectFacts.some((fact) => fact.stage === "reader-effect" && fact.requestID === begin.requestID && fact.phase === "final"))).toBe(true)
      expect(effectFacts.filter((fact) => fact.stage === "sdk-effect" && fact.operation === "chunk" && fact.phase === "returned")).toHaveLength(42)
      expect(fileTrace.counts["read:start"]).toBe(fileTrace.counts["read:settled"])
      expect(fileTrace.counts["close:start"]).toBe(fileTrace.counts["close:settled"])
      yield* phase("handler:complete")
      yield* Effect.addFinalizer(() => phase("scope:closing"))
      return
    }
    const frames: string[] = []
    if (concurrent) {
      const global = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => global.abort()))
      const eventURL = new URL(GlobalPaths.event, baseURL)
      eventURL.searchParams.set("directory", directory)
      yield* phase("sse:connecting")
      const response = yield* Effect.promise(() => fetch(eventURL, { headers: { authorization: "Basic " + Buffer.from("deepagent-code:private-http-media").toString("base64") }, signal: global.signal }))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const reader = response.body!.getReader()
      yield* phase("sse:first-event")
      expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)).toContain("server.connected")
      yield* phase("sse:connected")
      yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel().catch(() => {})))
      const url = new URL(`/ws/im/group/${group.body.id}`, baseURL)
      url.protocol = "ws:"
      url.searchParams.set("directory", directory)
      url.searchParams.set("auth_token", Buffer.from("deepagent-code:private-http-media").toString("base64"))
      yield* phase("websocket:connecting")
      const socket = new WebSocket(url)
      socket.addEventListener("message", (event) => frames.push(String(event.data)))
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()))
      yield* Effect.promise(() => new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true })
        socket.addEventListener("error", () => reject(new Error("Private original group socket failed")), { once: true })
      }))
      expect(socket.readyState).toBe(WebSocket.OPEN)
      yield* phase("websocket:connected")
    }
    const parent = AttachmentStorage.deriveStoragePath({ dataDir: Global.Path.data, workspaceID: group.body.workspaceID, attachmentID: "ima_cleanup" })
    if (parent.ok) yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(parent.baseDir, { recursive: true, force: true })))
    const files = [new File([Buffer.alloc(10485760, 77)], "large.bin", { type: "application/octet-stream" }), new File([], "empty.txt"),
      new File(["private note"], "note.txt"), new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQmln+HwAERQIyazZiBgAAAABJRU5ErkJggg==", "base64")], "pixel.png", { type: "image/png" })]
    const ids: string[] = []
    for (const file of files) {
      const form = new FormData()
      form.set("file", file)
      form.set("groupId", group.body.id)
      const uploaded = yield* request("/api/v1/im/attachments", { method: "POST", body: form })
      expect(uploaded.status).toBe(200)
      expect(uploaded.body.sizeBytes).toBe(file.size)
      ids.push(uploaded.body.id)
      if (concurrent) {
        const metadata = yield* request(`/api/v1/im/groups/${group.body.id}`)
        expect(metadata.status).toBe(200)
        expect(metadata.body.group.id).toBe(group.body.id)
      }
    }
    const sending = request(`/api/v1/im/groups/${group.body.id}/messages`, post({ senderType: "user", type: "file", content: "private ordered original batch", attachmentIDs: ids, clientRequestID: "private-original-batch" }))
    const response = concurrent ? (yield* Effect.all([sending, Effect.forEach(ids, () => request(`/api/v1/im/groups/${group.body.id}`).pipe(Effect.tap((metadata) => Effect.sync(() => expect(metadata.status).toBe(200)))))], { concurrency: 2 }))[0] : yield* sending
    expect(response.status).toBe(200)
    expect(response.body.type).toBe("file")
    yield* pollWithTimeout(Effect.sync(() => outbound.count === 1 ? true : undefined), "Original queued media dispatch did not reach its single protobuf publish", "3 seconds")
    expect(outbound.count).toBe(1)
    expect(objects.size).toBe(4)
    expect(chunks.filter((size) => size === 262144)).toHaveLength(40)
    expect(events.filter((event) => event.operation === "begin" && event.phase === "Effect-returned")).toHaveLength(4)
    expect(events.filter((event) => event.operation === "finalize" && event.phase === "Effect-returned")).toHaveLength(4)
    expect((yield* database.db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session_input`))?.count).toBe(0)
    expect((yield* database.db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session_provider_attempt`))?.count).toBe(0)
    expect(fileTrace.counts["read:start"]).toBe(fileTrace.counts["read:settled"])
    expect(fileTrace.counts["close:start"]).toBe(fileTrace.counts["close:settled"])
    if (concurrent) {
      for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
        if (frames.some((frame) => frame.includes("reader_changed"))) break
        if (attempt === 99) return yield* Effect.die(new Error("Original group socket did not observe media creation"))
        yield* Effect.sleep("10 millis")
      }
      expect(frames.some((frame) => frame.includes("reader_changed"))).toBe(true)
    }
    yield* phase("handler:complete")
    yield* Effect.addFinalizer(() => phase("scope:closing"))
  }).pipe(Effect.provide(context), Effect.ensuring(Effect.promise(() => Bun.write(path.join(root, "handler-safe.json"), JSON.stringify({ scope: "controlled actual HTTP handler only; no Go/UI/provider", concurrent, diagnostic, events, effectFacts, fileCounts: fileTrace.counts, fileFacts: fileTrace.facts, outboundPublishes: outbound.count, objects: objects.size, chunkSizes: chunks }, null, 2))).pipe(Effect.asVoid)))
})

const run = (concurrent: boolean, diagnostic = false) => Effect.gen(function* () {
  if (process.env.DAC_IM_MEDIA_BATCH_CHILD === "1") return yield* runBoundary(concurrent, diagnostic)
  const root = yield* Effect.acquireRelease(Effect.promise(async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-im-media-product-lanes-batch-")))), (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })))
  const { certificate } = yield* Effect.promise(() => import("../installation/fixture/event-investigation-installation"))
  const tls = yield* Effect.promise(() => certificate(path.join(root, "tls")))
  const log = yield* Effect.acquireRelease(Effect.promise(() => fs.open(path.join(root, "child.log"), "wx", 0o600)), (log) => Effect.promise(() => log.close()))
  const pattern = diagnostic ? "^QA listener normal bootstrap" : concurrent ? "^metadata GETs global SSE" : "^actual authenticated createMessage"
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL|DEEPAGENT_|DAC_IM_MEDIA_BATCH_)/.test(key)))
  const child = Bun.spawn([process.execPath, "test", "--preload", path.resolve(import.meta.dir, "../fixture/cli-secret-store.ts"), import.meta.path, "--test-name-pattern", pattern, "--timeout", "30000"], { cwd: process.cwd(), stdout: log.fd, stderr: log.fd,
    env: { ...inherited, NODE_EXTRA_CA_CERTS: tls.certificatePath, DAC_IM_MEDIA_BATCH_CHILD: "1", DAC_IM_MEDIA_BATCH_ROOT: root } })
  const startedAt = Date.now()
  const diagnose = async (reason: "deadline-observation" | "failed-exit") => {
    const file = Bun.file(path.join(root, "progress-safe.json"))
    const progress = await file.exists() && file.size <= 32768 ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Struct({
      phase: Schema.Literals(["boundary:start", "native:starting", "native:started", "listener:starting", "listener:started", "kernel:connecting", "kernel:connected",
        "http:upload:request", "http:upload:headers", "http:upload:body", "http:send:request", "http:send:headers", "http:send:body",
        "http:direct:request", "http:direct:headers", "http:direct:body", "http:metadata:request", "http:metadata:headers", "http:metadata:body",
        "sdk:once-send", "sse:connecting", "sse:first-event", "sse:connected", "websocket:connecting", "websocket:connected", "handler:complete", "scope:closing", "scope:closed"]),
      elapsedMs: Schema.Number,
      events: Schema.Record(Schema.String.check(Schema.isPattern(/^(begin|chunk|finalize):Effect-(start|returned|error)$/)), Schema.Number),
      effectFacts: Schema.Record(Schema.String.check(Schema.isPattern(/^(sdk-effect:(capabilities|begin|chunk|finalize)|reader-effect:(foreground|background)):(start|returned|error|final)$/)), Schema.Number),
      fileCounts: Schema.Record(Schema.String.check(Schema.isPattern(/^(realpath|lstat|open|stat|read|close):(start|settled|error)$/)), Schema.Number),
      outboundPublishes: Schema.Number, objects: Schema.Number, chunks: Schema.Number,
    }))(await file.json().catch(() => undefined))) : undefined
    const sdkFile = Bun.file(path.join(root, "cli-safe.json"))
    const sdk = await sdkFile.exists() && sdkFile.size <= 32768 ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Struct({
      sendCalls: Schema.Number, terminal: Schema.optional(Schema.Literals(["started", "success", "typed-error", "unsettled-transport"])), status: Schema.optional(Schema.Number),
      facts: Schema.Array(Schema.Struct({ stage: Schema.Literals(["http", "upload"]), status: Schema.Number, at: Schema.Number,
        index: Schema.optional(Schema.Number), expectedBytes: Schema.optional(Schema.Number), success: Schema.optional(Schema.Boolean),
        upload: Schema.optional(Schema.Boolean), send: Schema.optional(Schema.Boolean) })),
    }))(await sdkFile.json().catch(() => undefined))) : undefined
    // Only these fixture-owned fields leave the child. Raw logs can contain auth
    // headers or tokens and remain private even when the original test times out.
    console.info("owned-media-batch-diagnostic", JSON.stringify({ reason, concurrent, diagnostic, elapsedMs: Date.now() - startedAt,
      exitCode: child.exitCode, exitSignal: child.signalCode, progress: progress ?? { unavailable: true }, sdk }))
  }
  const observation = setTimeout(() => { void diagnose("deadline-observation").catch(() => {}) }, 35000)
  observation.unref()
  yield* Effect.addFinalizer(() => Effect.sync(() => clearTimeout(observation)))
  yield* Effect.addFinalizer(() => Effect.promise(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited }))
  const exit = yield* Effect.promise(() => child.exited)
  clearTimeout(observation)
  if (exit !== 0) {
    yield* Effect.promise(() => diagnose("failed-exit"))
    const evidence = path.join(os.tmpdir(), `dac-im-media-kernel-batch-${diagnostic ? "qa" : concurrent ? "concurrent" : "ordinary"}-child.log`)
    yield* Effect.promise(() => fs.copyFile(path.join(root, "child.log"), evidence))
    return yield* Effect.die(new Error(`Owned media batch child failed; original diagnostics: ${evidence}`))
  }
  expect(exit).toBe(0)
  const receipt = yield* Effect.promise(() => Bun.file(path.join(root, "handler-safe.json")).json())
  const terminal = yield* Effect.promise(() => Bun.file(path.join(root, "child.log")).text())
  console.info("owned-media-batch-safe", JSON.stringify({ concurrent, diagnostic, outboundPublishes: receipt.outboundPublishes, objects: receipt.objects, chunkCount: receipt.chunkSizes.length, fileCounts: receipt.fileCounts, terminal: terminal.match(/^\s*\d+ (?:pass|fail|expect\(\) calls).*$/gm) }))
})

it.live("actual authenticated createMessage sends four original files including the current10MiB boundary after rejecting the original50MiB through formal SDK and current reader", () => run(false), 40000)
it.live("metadata GETs global SSE and original group WS retain the pending reader through one four-file send", () => run(true), 40000)
it.live("QA listener normal bootstrap auth and formal SDK preserve Begin Effect reader final and four-file onceSend", () => run(false, true), 40000)
