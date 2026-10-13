import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { createServer } from "node:net"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { KernelLiveFirstSeenFixture } from "../im/fixture/kernel-live-first-seen"
import { MediaSdkOnce } from "../im/fixture/kernel-media-sdk-once"
import { testEffect, pollWithTimeout } from "../lib/effect"

const it = testEffect(NodeServices.layer)
type Metadata = { objectID: string; uploadID: string; filename: string; mime: string; sizeBytes: number; sha256: string; state: string; receivedBytes: number; receivedChunks: number; createdAt: number; expiresAt: number }
const freePort = () => new Promise<number>((resolve, reject) => {
  const socket = createServer()
  socket.on("error", reject)
  socket.listen(0, "127.0.0.1", () => { const address = socket.address(); if (!address || typeof address === "string") return reject(new Error("Private port unavailable")); socket.close(() => resolve(address.port)) })
})

it.live("original listener and QA composition cold roots complete one formal SDK small-media send and normal stop", () => Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(Effect.promise(() => fs.mkdtemp("/tmp/dac-im-media-product-lanes-")), (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })))
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    for (const lane of ["original", "qa"]) {
      const file = path.join(root, lane, "A", "child.log")
      if (await Bun.file(file).exists()) await fs.copyFile(file, `/tmp/dac-im-media-listener-lanes-${lane}-child.log`)
    }
  }))
  const results: object[] = []
  for (const lane of ["original", "qa"] as const) {
    const data = Buffer.from("private small-media controlled listener comparison")
    const checksum = createHash("sha256").update(data).digest("hex")
    const objects: Metadata[] = []
    const received = createHash("sha256")
    const native = KernelLiveFirstSeenFixture.make({ fetch(request) {
      const pathname = new URL(request.url).pathname
      if (!pathname.startsWith("/navigator/protected-media/v1/") && !pathname.startsWith("/api/im/")) return undefined
      return (async () => {
        if (pathname.startsWith("/api/im/")) {
          const input = request.method === "POST" ? await request.json() : undefined
          const payload = pathname.endsWith("/exchange") ? { kernel_token: "private-first-seen-token", credential_expires_at: Date.now() + 3600000, navigator_url: native.server.url.origin,
            appkey: "private-listener-" + lane, identity: { uuid: "receiver", name: "Receiver", org_id: 1, org_all_group_id: "unused" }, ttl: { msg_life_time_ms: 259200000 } }
            : pathname.endsWith("/resolve") ? { uuid: "sender", name: "Sender" }
            : pathname.endsWith("/inspect") ? { conversation_type: input.conversation_type, conversation_id: input.conversation_id, org_id: 1, member_uuids: ["receiver", "sender"], name: "Sender" } : {}
          return Response.json({ success: true, data: payload })
        }
        expect(request.headers.get("authorization")).toBe("Bearer private-first-seen-token")
        if (pathname.endsWith("/capabilities")) return new Response(JSON.stringify({ version: 1, profile: "mysql-protected-media-v1", capability: "dac:media.v1", readerVersion: 2,
          maxFileBytes: 52428800, maxAttachments: 4, chunkBytes: 262144, ttlMillis: 86400000, authenticatedContent: true }), { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } })
        if (request.method === "POST" && pathname.endsWith("/objects")) {
          const input = await request.json()
          const createdAt = Date.now()
          objects.push({ objectID: createHash("sha256").update(input.upload.uploadID).digest("hex"), uploadID: input.upload.uploadID, filename: input.upload.filename, mime: "",
            sizeBytes: input.upload.sizeBytes, sha256: input.upload.sha256, state: "uploading", receivedBytes: 0, receivedChunks: 0, createdAt, expiresAt: createdAt + 86400000 })
        }
        const object = objects[0]!
        if (request.method === "PUT") {
          const chunk = new Uint8Array(await request.arrayBuffer())
          received.update(chunk); object.receivedBytes += chunk.byteLength; object.receivedChunks++
        }
        if (pathname.endsWith("/finalize")) { expect(received.digest("hex")).toBe(checksum); object.state = "uploaded_unbound"; object.mime = "application/octet-stream" }
        return new Response(JSON.stringify(object), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } })
      })()
    }, response(topic, _request, original) {
      if (topic === "qry_delivery_capabilities") return { name: "DeliveryCapabilities", value: { version: 1, profile: "mysql-receipt-v1", maxLifetimeMs: 259200000, maxContentBytes: 65536, eventualDelivery: false } }
      if (!original || !topic.startsWith("qry_delivery_")) return original
      return { ...original, value: { ...original.value, version: 2, ...(topic === "qry_delivery_changes" ? { items: [], scanProjectionKey: "" } : {}) } }
    }, outboundPublish: () => ({ code: 0, messageId: "private-original-small-ack", timestamp: Date.now(), msgSeqNo: 1 }) })
    yield* Effect.addFinalizer(() => Effect.sync(() => native.server.stop(true)))
    const laneRoot = path.join(root, lane)
    const home = path.join(laneRoot, "A")
    yield* Effect.promise(() => Promise.all(["data", "config", "cache", "workspace", "files"].map((part) => fs.mkdir(path.join(home, part), { recursive: true, mode: 0o700 }))))
    const port = yield* Effect.promise(freePort)
    const log = yield* Effect.acquireRelease(Effect.promise(() => fs.open(path.join(home, "child.log"), "wx", 0o600)), (file) => Effect.promise(() => file.close()))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DEEPAGENT_") && !key.startsWith("DAC_IM_")))
    const child = Bun.spawn([process.execPath, path.resolve("test/im/fixture/kernel-media-listener-lane.ts"), home, lane], { cwd: process.cwd(), stdout: log.fd, stderr: log.fd,
      env: { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"),
        DEEPAGENT_CODE_TEST_HOME: home, DEEPAGENT_CODE_DB: path.join(home, "data/database.sqlite"), DEEPAGENT_CODE_SERVER_PASSWORD: "private-listener-password",
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1", DEEPAGENT_CODE_DISABLE_PROJECT_CONFIG: "1", DEEPAGENT_IM_AGENT_RESPONDER: "off",
        DEEPAGENT_IM_KERNEL_MEDIA_PROFILE: "mysql-protected-media-v1", DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED: "true", DEEPAGENT_IM_FACADE_URL: native.server.url.origin,
        DEEPAGENT_IM_FACADE_KEY: "sk-private-controlled-listener", DAC_IM_HOST_PORT: String(port) } })
    yield* Effect.addFinalizer(() => Effect.promise(async () => { await Bun.write(path.join(home, "stop"), ""); if (child.exitCode === null) await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) child.kill(); await child.exited }))
    const readyFile = path.join(home, "lane-ready-safe.json")
    yield* pollWithTimeout(Effect.promise(async () => await Bun.file(readyFile).exists() ? true : undefined), "Controlled original listener did not start", "20 seconds")
    const ready = yield* Effect.promise(() => Bun.file(readyFile).json())
    expect(ready.databasePathMatches).toBe(true)
    expect(ready.rootBefore.present).toBe(false)
    expect(ready.rootAfter.present).toBe(false)
    if (lane === "original") expect(ready.originalListenerReady).toBe(true)
    const url = `http://127.0.0.1:${port}`
    const directory = path.join(home, "workspace")
    const auth = "Basic " + Buffer.from("deepagent-code:private-listener-password").toString("base64")
    const client = createDeepAgentCodeClient({ baseUrl: url, directory, headers: { authorization: auth } })
    const denied = yield* Effect.promise(() => fetch(url + "/api/v1/im/status?directory=" + encodeURIComponent(directory)))
    expect(denied.status).toBe(401)
    const status = yield* Effect.promise(() => client.im.facade.status({ directory }, { throwOnError: true }))
    expect(status.data?.facade).toBe("active")
    const direct = yield* Effect.promise(() => client.im.facade.direct({ directory, name: "Sender" }, { throwOnError: true }))
    expect(direct.data?.reader?.state).toBe("pending")
    const socketURL = new URL(`/ws/im/group/${direct.data!.id}`, url)
    socketURL.protocol = "ws:"
    socketURL.searchParams.set("directory", directory)
    socketURL.searchParams.set("auth_token", Buffer.from("deepagent-code:private-listener-password").toString("base64"))
    const socket = new WebSocket(socketURL)
    yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()))
    yield* Effect.promise(() => new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("Original group socket failed")), { once: true })
    })).pipe(Effect.timeout("5 seconds"))
    expect(socket.readyState).toBe(WebSocket.OPEN)
    const file = path.join(laneRoot, "files", lane + ".txt")
    yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
    yield* Effect.promise(() => Bun.write(file, data))
    const authorizationFile = path.join(home, "auth.txt")
    yield* Effect.promise(() => Bun.write(authorizationFile, auth))
    const sent = yield* Effect.promise(() => MediaSdkOnce.run({ peers: { A: { url, directory, authorizationFile } }, groups: { A: { id: direct.data!.id } },
      files: [{ path: file, filename: "small.txt", mime: "text/plain", bytes: data.byteLength, sha256: checksum }] }, laneRoot, 1))
    expect(sent.safe.terminal).toBe("success")
    expect(sent.safe.status).toBe(200)
    expect(objects).toHaveLength(1)
    expect(objects[0]?.receivedChunks).toBe(1)
    // The DB is the child's fresh file. Census uses readonly SQL only.
    const db = new Database(path.join(home, "data/database.sqlite"), { readonly: true })
    const census = Object.fromEntries(["session", "session_input", "session_provider_attempt", "work_execution", "session_v2_tool_effect_admission"].map((table) => [table, db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count]))
    db.close()
    expect(Object.values(census)).toEqual([0, 0, 0, 0, 0])
    // This auxiliary listener has no production WebSocketTracker. Its client
    // owner closes and joins the socket before Scope.close; the original lane
    // deliberately retains its socket through the real Listener.stop(true).
    if (lane === "qa") {
      socket.close()
      yield* pollWithTimeout(Effect.sync(() => socket.readyState === WebSocket.CLOSED ? true : undefined), "QA-owned socket did not close", "3 seconds")
    }
    yield* Effect.promise(() => Bun.write(path.join(home, "stop"), ""))
    const exit = yield* Effect.promise(() => child.exited).pipe(Effect.timeout("8 seconds"))
    expect(exit).toBe(0)
    const stopped = yield* Effect.promise(() => Bun.file(path.join(home, "lane-stop-safe.json")).json())
    expect(stopped.normalStop).toBe(true)
    expect(stopped.scopeClosed).toBe(true)
    expect(stopped.fileCounts["close:start"]).toBe(stopped.fileCounts["close:settled"])
    yield* pollWithTimeout(Effect.sync(() => socket.readyState === WebSocket.CLOSED ? true : undefined), "Owned original group socket did not close", "3 seconds")
    expect(socket.readyState).toBe(WebSocket.CLOSED)
    const probe = createServer()
    yield* Effect.promise(() => new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", () => probe.close(() => resolve())) }))
    const nativeFacts = yield* Effect.promise(() => Bun.file(path.join(home, "media-trace-safe.jsonl")).text())
    expect(nativeFacts).toContain('"stage":"begin","phase":"settled"')
    expect(nativeFacts).toContain('"stage":"chunk","phase":"settled"')
    const effectFacts = yield* Effect.promise(() => Bun.file(path.join(home, "lane-effect-safe.jsonl")).text())
    expect(effectFacts.includes('"stage":"sdk-effect"')).toBe(lane === "qa")
    results.push({ lane, ready, stopped, census, HTTPstatus: sent.safe.status, sendCalls: 1, receivedBytes: objects[0]?.receivedBytes, chunks: 1, contentHashMatched: true,
      ownedGroupSocketClosed: true, socketStopOrder: lane === "original" ? "held until original listener.stop(true)" : "QA owner closes and joins before Scope.close", ownedChildExit: exit, portBindable: true })
  }
  yield* Effect.promise(() => Bun.write("/tmp/dac-im-media-listener-lanes-controlled-safe.json", JSON.stringify({ scope: "controlled native WS+HTTP only; two cold private roots; no Go/UI/provider; small media eachonce", results }, null, 2)))
}), 60000)
