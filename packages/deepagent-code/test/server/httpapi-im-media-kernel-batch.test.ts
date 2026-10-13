import { expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
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
import { testEffect } from "../lib/effect"

const it = testEffect(NodeServices.layer)
const post = (value: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) })
type Metadata = { objectID: string; uploadID: string; filename: string; mime: string; sizeBytes: number; sha256: string; state: string;
  receivedBytes: number; receivedChunks: number; createdAt: number; expiresAt: number }

const run = (concurrent: boolean, diagnostic = false) => Effect.gen(function* () {
  const root = diagnostic ? yield* Effect.acquireRelease(Effect.promise(() => fs.mkdtemp("/tmp/dac-im-media-product-controlled-")), (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true }))) : yield* tmpdirScoped({ git: false })
  const originalDatabase = Flag.DEEPAGENT_CODE_DB
  Flag.DEEPAGENT_CODE_DB = path.join(root, "fresh-media.sqlite")
  yield* Effect.addFinalizer(() => Effect.sync(() => { Flag.DEEPAGENT_CODE_DB = originalDatabase }))
  const fileTrace = MediaFileTrace.install(yield* Effect.promise(() => fs.realpath(Global.Path.data)))
  yield* Effect.addFinalizer(() => Effect.sync(fileTrace.restore))
  const events: { operation: string; phase: string }[] = []
  const effectFacts: MediaEffectTrace.Fact[] = []
  const objects = new Map<string, { metadata: Metadata; received: ReturnType<typeof createHash> }>()
  const chunks: number[] = []
  const native = KernelLiveFirstSeenFixture.make({
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (!pathname.startsWith("/navigator/protected-media/v1/") && !pathname.startsWith("/api/im/")) return undefined
      return (async () => {
        if (pathname.startsWith("/api/im/")) {
          const input = request.method === "POST" ? await request.json() : undefined
          const data = pathname.endsWith("/exchange") ? { kernel_token: "private-first-seen-token", credential_expires_at: Date.now() + 3600000,
            navigator_url: native.server.url.origin, appkey: "private-http-media", identity: { uuid: "receiver", name: "Receiver", org_id: 1, org_all_group_id: "unused" }, ttl: { msg_life_time_ms: 259200000 } }
            : pathname.endsWith("/resolve") ? { uuid: "sender", name: "Sender" }
            : pathname.endsWith("/inspect") ? { conversation_type: input.conversation_type, conversation_id: input.conversation_id, org_id: 1, member_uuids: ["receiver", "sender"], name: "Sender" } : {}
          return Response.json({ success: true, data })
        }
        if (!concurrent) expect(request.headers.get("authorization")).toBe("Bearer private-first-seen-token")
        if (pathname.endsWith("/capabilities")) return new Response(JSON.stringify({ version: 1, profile: "mysql-protected-media-v1", capability: "dac:media.v1", readerVersion: 2,
          maxFileBytes: 52428800, maxAttachments: 4, chunkBytes: 262144, ttlMillis: 86400000, authenticatedContent: true }), { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } })
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
      })()
    },
    response(topic, _request, original) {
      if (topic === "qry_delivery_capabilities") return { name: "DeliveryCapabilities", value: { version: 1, profile: "mysql-receipt-v1", maxLifetimeMs: 259200000, maxContentBytes: 65536, eventualDelivery: false } }
      if (!original || !topic.startsWith("qry_delivery_")) return original
      return { ...original, value: { ...original.value, version: 2, ...(topic === "qry_delivery_changes" ? { items: [], scanProjectionKey: "" } : {}) } }
    },
    outboundPublish: () => ({ code: 0, messageId: "private-http-batch-ack", timestamp: Date.now(), msgSeqNo: 1 }),
  })
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
  const node = createServer()
  const upgrades = new Set<import("node:stream").Duplex>()
  node.on("upgrade", (_request, socket) => { upgrades.add(socket); socket.once("close", () => upgrades.delete(socket)) })
  yield* Effect.addFinalizer(() => Effect.sync(() => node.closeAllConnections()))
  yield* Effect.addFinalizer(() => Effect.sync(() => { upgrades.forEach((socket) => socket.destroy()); upgrades.clear() }))
  const serving = HttpRouter.serve(HttpApiApp.createRoutes(undefined, RuntimeFlags.layer({ v4FileUploadEnabled: true }), { imFacade: { buildEngine,
    env: { DEEPAGENT_IM_FACADE_URL: native.server.url.origin, DEEPAGENT_IM_FACADE_KEY: "sk-private-http-media", DEEPAGENT_IM_KERNEL_MEDIA_PROFILE: "mysql-protected-media-v1" },
  } }), { disableListenLog: true, disableLogger: true }).pipe(Layer.provide(layerWebSocketConstructorGlobal),
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
  const normal = diagnostic ? yield* MediaEffectListener.start({ port: 0, buildEngine: MediaEffectTrace.builder((fact) => { effectFacts.push(fact); if (fact.phase === "final") throw new Error("QA diagnostic failure") }), env: {
    DEEPAGENT_IM_FACADE_URL: native.server.url.origin, DEEPAGENT_IM_FACADE_KEY: "sk-private-http-media", DEEPAGENT_IM_KERNEL_MEDIA_PROFILE: "mysql-protected-media-v1",
  } }) : undefined
  const context = diagnostic ? Context.empty() : yield* Layer.build(Layer.mergeAll(instance, Project.defaultLayer, Session.defaultLayer, workspace, Database.defaultLayer, serving).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_SERVER_PASSWORD: "private-http-media" }))),
  ))
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
      const response = await fetch(url, { ...input, headers, signal: AbortSignal.timeout(15000) })
      const body = await response.json()
      return { status: response.status, body }
    })
    const group = yield* request("/api/v1/im/facade/direct", post({ name: "Sender" }))
    expect(group.status).toBe(200)
    expect(group.body.reader).toMatchObject({ mode: "protected", state: "pending" })
    if (diagnostic) {
      const denied = yield* Effect.promise(() => fetch(baseURL + "/api/v1/im/status?directory=" + encodeURIComponent(directory)))
      expect(denied.status).toBe(401)
      yield* Effect.promise(() => fs.mkdir(path.join(root, "files")))
      yield* Effect.promise(() => Bun.write(path.join(root, "A", "auth.txt"), "Basic " + Buffer.from("deepagent-code:private-http-media").toString("base64")))
      const inputs = [{ filename: "large.bin", bytes: Buffer.alloc(52428800, 77), mime: "application/octet-stream" }, { filename: "empty.txt", bytes: Buffer.alloc(0), mime: "text/plain" },
        { filename: "note.txt", bytes: Buffer.alloc(2432, 78), mime: "text/plain" }, { filename: "pixel.png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQmln+HwAERQIyazZiBgAAAABJRU5ErkJggg==", "base64"), mime: "image/png" }]
      const files = yield* Effect.forEach(inputs, (file) => Effect.promise(async () => {
        const output = path.join(root, "files", file.filename)
        await fs.writeFile(output, file.bytes)
        return { path: output, filename: file.filename, bytes: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex"), mime: file.mime }
      }))
      const result = yield* Effect.promise(() => MediaSdkOnce.run({ peers: { A: { url: baseURL, directory, authorizationFile: path.join(root, "A", "auth.txt") } }, groups: { A: { id: group.body.id } }, files }, root))
      expect(result.safe.terminal).toBe("success")
      expect(result.safe.status).toBe(200)
      const begins = effectFacts.filter((fact) => fact.stage === "sdk-effect" && fact.operation === "begin" && fact.phase === "returned")
      expect(begins).toHaveLength(4)
      expect(begins.every((begin) => begin.requestID > 0 && begin.idHash?.length === 64 && effectFacts.some((fact) => fact.stage === "reader-effect" && fact.requestID === begin.requestID && fact.phase === "returned") && effectFacts.some((fact) => fact.stage === "reader-effect" && fact.requestID === begin.requestID && fact.phase === "final"))).toBe(true)
      expect(effectFacts.filter((fact) => fact.stage === "sdk-effect" && fact.operation === "chunk" && fact.phase === "returned")).toHaveLength(202)
      expect(fileTrace.counts["read:start"]).toBe(fileTrace.counts["read:settled"])
      expect(fileTrace.counts["close:start"]).toBe(fileTrace.counts["close:settled"])
      return
    }
    const frames: string[] = []
    if (concurrent) {
      const global = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => global.abort()))
      const eventURL = new URL(GlobalPaths.event, baseURL)
      eventURL.searchParams.set("directory", directory)
      const response = yield* Effect.promise(() => fetch(eventURL, { headers: { authorization: "Basic " + Buffer.from("deepagent-code:private-http-media").toString("base64") }, signal: global.signal }))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)).toContain("server.connected")
      yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel().catch(() => {})))
      const url = new URL(`/ws/im/group/${group.body.id}`, baseURL)
      url.protocol = "ws:"
      url.searchParams.set("directory", directory)
      url.searchParams.set("auth_token", Buffer.from("deepagent-code:private-http-media").toString("base64"))
      const socket = new WebSocket(url)
      socket.addEventListener("message", (event) => frames.push(String(event.data)))
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()))
      yield* Effect.promise(() => new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true })
        socket.addEventListener("error", () => reject(new Error("Private original group socket failed")), { once: true })
      }))
      expect(socket.readyState).toBe(WebSocket.OPEN)
    }
    const parent = AttachmentStorage.deriveStoragePath({ dataDir: Global.Path.data, workspaceID: group.body.workspaceID, attachmentID: "ima_cleanup" })
    if (parent.ok) yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(parent.baseDir, { recursive: true, force: true })))
    const files = [new File([Buffer.alloc(52428800, 77)], "large.bin", { type: "application/octet-stream" }), new File([], "empty.txt"),
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
    expect(objects.size).toBe(4)
    expect(chunks.filter((size) => size === 262144)).toHaveLength(200)
    expect(events.filter((event) => event.operation === "begin" && event.phase === "Effect-returned")).toHaveLength(4)
    expect(events.filter((event) => event.operation === "finalize" && event.phase === "Effect-returned")).toHaveLength(4)
    const database = yield* Database.Service
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
  }).pipe(Effect.provide(context), Effect.ensuring(Effect.promise(() => Bun.write(diagnostic ? "/tmp/dac-im-media-effect-host-controlled-safe.json" : concurrent ? "/tmp/dac-im-media-http-handler-concurrent-checkpoints-safe.json" : "/tmp/dac-im-media-http-handler-checkpoints-safe.json", JSON.stringify({ scope: "controlled actual HTTP handler only; no Go/UI/provider", concurrent, diagnostic, events, effectFacts, fileCounts: fileTrace.counts, fileFacts: fileTrace.facts }, null, 2))).pipe(Effect.asVoid)))
})

it.live("actual authenticated createMessage sends four original files including 50MiB through formal SDK and current reader", () => run(false), 40000)
it.live("metadata GETs global SSE and original group WS retain the pending reader through one four-file send", () => run(true), 40000)
it.live("QA listener normal bootstrap auth and formal SDK preserve Begin Effect reader final and four-file onceSend", () => run(false, true), 40000)
