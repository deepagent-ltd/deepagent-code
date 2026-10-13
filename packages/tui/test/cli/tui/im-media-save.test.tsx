/** @jsxImportSource @opentui/solid */
import { expect, test, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import type { ServerWebSocket } from "bun"
import { Option, Schema } from "effect"
import { ClientEvent } from "@deepagent-code/core/im/websocket"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import { createIMClient, openIMGroupSocket } from "../../../src/component/im-client"
import { MediaPublicationError, publishMediaStream } from "../../../src/component/im-media"
import { DialogIM } from "../../../src/component/dialog-im"
import { mountIM, until } from "../../fixture/im-environment"
import { tmpdir } from "../../fixture/fixture"

async function fixture(directory: string, size = 2 * 1024 * 1024) {
  const bytes = Buffer.alloc(size, 0x5a)
  const createdAt = Date.now()
  const attachment = { profile: "kernel_media" as const, attachmentID: "a".repeat(64), contentRef: "a".repeat(64),
    filename: "controlled.bin", mime: "application/octet-stream", sizeBytes: size,
    sha256: createHash("sha256").update(bytes).digest("hex"), createdAt, expiresAt: createdAt + 86_400_000 }
  const localAttachment = MediaIntent.attachment({ id: "local", workspaceID: directory, projectID: null,
    groupID: "group", messageID: "message", uploadedBy: "viewer", filename: attachment.filename, mime: attachment.mime,
    sizeBytes: attachment.sizeBytes, checksum: attachment.sha256, createdAt, expiresAt: attachment.expiresAt, preview: false })
  const group = { id: "group", workspaceID: directory, projectID: null, type: "project", name: "Controlled group",
    createdBy: "viewer", kernelConvID: "kr1:controlled", createdAt, updatedAt: createdAt, deletedAt: null,
    reader: { mode: "protected", state: "ready", liveUnread: "0" } }
  const state = { metadata: 0, pages: 0, pagesDuringDownload: 0, contentRequests: 0, nonGET: 0,
    streaming: false, streamCancelled: false, invalidated: false, truncate: false, corrupt: false,
    revokeFinal: false, noBody: false, overflow: false, sentBytes: 0, strictHeartbeat: false,
    heartbeats: 0, invalidHeartbeats: 0, pongs: [] as number[], closes: [] as number[] }
  const sockets = new Set<ServerWebSocket<undefined>>()
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ClientEvent))
  const gate = Promise.withResolvers<void>()
  const streamFinished = Promise.withResolvers<void>()
  const server = Bun.serve({
    idleTimeout: 60,
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (request.headers.get("authorization") !== "Bearer fixture-token" ||
          request.headers.get("x-deepagent-code-directory") !== encodeURIComponent(directory))
        return new Response(null, { status: 403 })
      if (url.pathname.startsWith("/ws/")) {
        if (server.upgrade(request)) return
        return new Response(null, { status: 400 })
      }
      if (request.method !== "GET") { state.nonGET++; return new Response(null, { status: 405 }) }
      const observation = () => ({ displayEpoch: "save-controlled", proofWindowMs: 1000,
        validatedServerNow: Date.now(), nextExpiryAt: null })
      if (url.pathname === "/global/capabilities") return Response.json({ features: { v4FileUploadEnabled: true } })
      if (url.pathname.endsWith("/status")) return Response.json({ facade: "active", identity: { uuid: "viewer", name: "Controlled viewer", orgID: 7, orgAllGroupID: "everyone" },
        viewer: { memberID: "viewer" }, kernel: "connected", keyOrigin: "env", blocked: null,
        reader: { state: "ready", displayEpoch: "save-controlled", legacyMirrorUnavailable: true },
        media: { version: 2, enabled: true, multipleAttachments: true, maxAttachments: 4, maxAttachmentBytes: 10485760, ttlMs: 86400000 } })
      if (url.pathname.endsWith("/groups/page")) {
        const lane = url.searchParams.get("lane")
        return Response.json({ version: 1, lane, groups: lane === "protected" ? [group] : [], nextCursor: null,
          hasMore: false, ...(lane === "protected" ? { reader: observation() } : {}) })
      }
      if (url.pathname.endsWith("/groups/group")) return Response.json({ version: 1, group, reader: observation() })
      if (url.pathname.endsWith("/messages")) {
        state.pages++
        if (state.streaming) state.pagesDuringDownload++
        return Response.json({ messages: [{ id: "message", groupID: group.id, senderID: "other", senderType: "user", type: "text",
          content: `Original caption ${state.pages}`, mentions: null, metadata: null, replyToID: null, createdAt, updatedAt: createdAt,
          deletedAt: null, remoteAttachments: [attachment] }], nextCursor: null, hasMore: false,
          reader: { ...observation(), state: "ready", projectionRevision: "1" }, protectedUnavailable: state.invalidated })
      }
      if (url.pathname.includes("/attachments/")) {
        if (!url.pathname.endsWith("/content")) {
          state.metadata++
          return state.revokeFinal && state.metadata >= 3 ? new Response(null, { status: 403 })
            : Response.json(url.pathname.endsWith("/attachments/local") ? localAttachment : attachment)
        }
        state.contentRequests++
        state.streaming = true
        if (state.corrupt) bytes[0] ^= 1
        if (state.noBody) return new Response(null, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-length": "0" } })
        let offset = 0
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (offset > 0) await gate.promise
            if (state.truncate && offset > 0) { controller.close(); state.streaming = false; streamFinished.resolve(); return }
            if (offset >= bytes.length) {
              if (state.overflow && offset === bytes.length) { offset++; state.sentBytes++; controller.enqueue(new Uint8Array([1])); return }
              controller.close(); state.streaming = false; streamFinished.resolve(); return
            }
            const part = bytes.subarray(offset, Math.min(bytes.length, offset + 262144))
            offset += part.length
            state.sentBytes += part.length
            controller.enqueue(part)
          },
          cancel() { state.streamCancelled = true; state.streaming = false; streamFinished.resolve() },
        }), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } })
      }
      return new Response(null, { status: 404 })
    },
    websocket: {
      open(socket) { sockets.add(socket) },
      close(socket, code) { sockets.delete(socket); state.closes.push(code) },
      message(socket, input) {
        if (!state.strictHeartbeat) return
        state.heartbeats++
        // Use the original Host decoder, including its mandatory data.ts.
        const event = decode(String(input))
        if (Option.isNone(event)) { state.invalidHeartbeats++; socket.close(1003, "Invalid WebSocket message"); return }
        if (event.value.type === "ping") socket.send(JSON.stringify({ type: "pong", data: { ts: event.value.data.ts } }))
        if (event.value.type === "pong") state.pongs.push(event.value.data.ts)
      },
    },
  })
  const client = createIMClient({ url: server.url.href, directory,
    client: createOpencodeClient({ baseUrl: server.url.href, headers: { Authorization: "Bearer fixture-token" } }) })
  return { state, gate, streamFinished, server, sockets, attachment, localAttachment, client,
    async [Symbol.asyncDispose]() { gate.resolve(); await server.stop(true) } }
}

async function startSave(ui: Awaited<ReturnType<typeof mountIM>>, filename: string, size: number) {
  await ui.frame("Controlled group")
  await ui.select("Controlled group")
  await ui.frame("Connection: online")
  ui.app.mockInput.pressKey("u", { ctrl: true })
  await ui.frame("Attachment details")
  await ui.select("Attachment details · controlled.bin")
  await ui.frame(`${size} B`)
  await ui.select("Save file")
  await ui.frame("Save to a new path (never replaces an existing file)")
  await ui.type(filename)
  ui.app.mockInput.pressEnter()
  await ui.frame("Working")
}

const parts = async (directory: string) => (await fs.readdir(directory)).filter((name) => name.startsWith(".dac-media-"))

test("original parent five-second poll preserves an in-flight 10 MiB save and publishes exactly once", async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path, 10 * 1024 * 1024)
  using ui = await mountIM(dir.path, api.server.url.href, () => <DialogIM />, 80)
  const filename = path.join(dir.path, "received.bin")
  await startSave(ui, filename, api.attachment.sizeBytes)
  await until(() => api.state.streaming, "original content stream")
  const pages = api.state.pages
  await until(() => api.state.pagesDuringDownload > 0 && api.state.pages > pages, "original parent poll during download", 8000)
  await ui.app.renderOnce()
  expect(ui.app.captureCharFrame()).toContain("Save to a new path")
  expect(ui.app.captureCharFrame()).toContain("Working")
  expect(await Bun.file(filename).exists()).toBe(false)
  const staged = await parts(dir.path)
  expect(staged).toHaveLength(1)
  expect((await fs.stat(path.join(dir.path, staged[0]))).mode & 0o777).toBe(0o700)
  const body = await fs.stat(path.join(dir.path, staged[0], "body.part"))
  expect(body.mode & 0o777).toBe(0o600)
  expect(body.size).toBeGreaterThan(0)
  expect(body.size).toBeLessThan(api.attachment.sizeBytes)
  api.gate.resolve()
  await until(() => Bun.file(filename).size === api.attachment.sizeBytes, "complete atomic original publication", 8000)
  await ui.frame("File saved and verified")
  const saved = await fs.readFile(filename)
  expect(saved.length).toBe(10485760)
  expect(createHash("sha256").update(saved).digest("hex")).toBe(api.attachment.sha256)
  expect(api.state.contentRequests).toBe(1)
  expect(api.state.sentBytes).toBe(10485760)
  expect(api.state.metadata).toBe(3)
  expect(api.state.pagesDuringDownload).toBeGreaterThan(0)
  expect(api.state.nonGET).toBe(0)
  expect(await parts(dir.path)).toEqual([])
}, 20000)

test("truncated real HTTP content leaves the original save form with an explicit failure and no destination", async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path)
  api.state.truncate = true
  using ui = await mountIM(dir.path, api.server.url.href, () => <DialogIM />, 80)
  const filename = path.join(dir.path, "truncated.bin")
  await startSave(ui, filename, api.attachment.sizeBytes)
  api.gate.resolve()
  await ui.frame("IM operation failed")
  expect(ui.app.captureCharFrame()).toContain("Save to a new path")
  expect(ui.app.captureCharFrame()).not.toContain("File saved and verified")
  expect(await Bun.file(filename).exists()).toBe(false)
  expect(await parts(dir.path)).toEqual([])
  expect(api.state.contentRequests).toBe(1)
  expect(api.state.nonGET).toBe(0)
}, 10000)

test("an invalid original parent poll tears down the save owner and never publishes late content", async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path)
  using ui = await mountIM(dir.path, api.server.url.href, () => <DialogIM />, 80)
  const filename = path.join(dir.path, "cancelled.bin")
  await startSave(ui, filename, api.attachment.sizeBytes)
  api.state.invalidated = true
  await until(() => api.state.pagesDuringDownload > 0, "original invalid protected page", 8000)
  await ui.frame("Attachments (Ctrl+U)")
  api.gate.resolve()
  await api.streamFinished.promise
  await ui.app.renderOnce()
  expect(api.state.streamCancelled).toBe(true)
  expect(await Bun.file(filename).exists()).toBe(false)
  expect(await parts(dir.path)).toEqual([])
  expect(ui.app.captureCharFrame()).not.toContain("File saved and verified")
  expect(api.state.contentRequests).toBe(1)
  expect(api.state.nonGET).toBe(0)
}, 15000)

test("final original metadata refusal prevents publication after the complete streamed body", async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path)
  api.state.revokeFinal = true
  using ui = await mountIM(dir.path, api.server.url.href, () => <DialogIM />, 80)
  const filename = path.join(dir.path, "revoked.bin")
  await startSave(ui, filename, api.attachment.sizeBytes)
  api.gate.resolve()
  await ui.frame("IM operation failed")
  expect(api.state.sentBytes).toBe(api.attachment.sizeBytes)
  expect(api.state.metadata).toBe(3)
  expect(await Bun.file(filename).exists()).toBe(false)
  expect(await parts(dir.path)).toEqual([])
  expect(ui.app.captureCharFrame()).toContain("Save to a new path")
  expect(api.state.nonGET).toBe(0)
}, 10000)

for (const noBody of [false, true]) test(`zero-byte original remote stream (${noBody ? "no HTTP body" : "empty HTTP body"}) seals and saves`, async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path, 0)
  api.state.noBody = noBody
  const signal = new AbortController().signal
  const source = await api.client.streamRemoteAttachment({ groupID: "group", messageID: "message", attachment: api.attachment }, signal)
  const filename = path.join(dir.path, "empty.bin")
  await publishMediaStream(filename, source, signal)
  expect(await Bun.file(filename).exists()).toBe(true)
  expect((await fs.stat(filename)).size).toBe(0)
  expect((await fs.stat(filename)).mode & 0o777).toBe(0o600)
  expect(api.state.metadata).toBe(2)
  expect(api.state.contentRequests).toBe(1)
  expect(api.state.nonGET).toBe(0)
  expect(await parts(dir.path)).toEqual([])
})

for (const failure of ["hash", "overflow"] as const) test(`real remote stream ${failure} failure never publishes`, async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path)
  api.state.corrupt = failure === "hash"
  api.state.overflow = failure === "overflow"
  api.gate.resolve()
  const signal = new AbortController().signal
  const filename = path.join(dir.path, "invalid.bin")
  await expect((async () => {
    const source = await api.client.streamRemoteAttachment({ groupID: "group", messageID: "message", attachment: api.attachment }, signal)
    await publishMediaStream(filename, source, signal)
  })()).rejects.toThrow()
  expect(await Bun.file(filename).exists()).toBe(false)
  expect(await parts(dir.path)).toEqual([])
  expect(api.state.contentRequests).toBe(1)
  expect(api.state.nonGET).toBe(0)
})

test("stream publisher preserves existing file, hard-link and symlink targets", async () => {
  await using dir = await tmpdir()
  const original = path.join(dir.path, "original.bin")
  const linked = path.join(dir.path, "linked.bin")
  const symlinked = path.join(dir.path, "symlinked.bin")
  await fs.writeFile(original, "original")
  await fs.link(original, linked)
  await fs.symlink(original, symlinked)
  for (const filename of [original, linked, symlinked]) {
    const bytes = new TextEncoder().encode("replacement")
    await expect(publishMediaStream(filename, { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }),
      sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), expiresAt: Date.now() + 86400000,
      seal: async () => {} }, new AbortController().signal)).rejects.toThrow()
    expect(await fs.readFile(filename, "utf8")).toBe("original")
    expect(await parts(dir.path)).toEqual([])
  }
  expect((await fs.lstat(symlinked)).isSymbolicLink()).toBe(true)
  expect((await fs.stat(original)).ino).toBe((await fs.stat(linked)).ino)
})

test("late replacement of the staged pathname is rejected and its foreign inode is never deleted", async () => {
  await using dir = await tmpdir()
  const bytes = new TextEncoder().encode("original body")
  let replaced = ""
  await expect(publishMediaStream(path.join(dir.path, "target.bin"), {
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }),
    sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), expiresAt: Date.now() + 86400000,
    seal: async () => {
      const directory = path.join(dir.path, (await parts(dir.path))[0])
      replaced = path.join(directory, "body.part")
      await fs.rename(replaced, path.join(directory, "held-original.part"))
      await fs.writeFile(replaced, "foreign replacement")
    },
  }, new AbortController().signal)).rejects.toThrow("media_file_changed")
  expect(await fs.readFile(replaced, "utf8")).toBe("foreign replacement")
  expect(await Bun.file(path.join(dir.path, "target.bin")).exists()).toBe(false)
})

test("actual HTTP declared Content-Length mismatch refuses before opening a publisher", async () => {
  await using dir = await tmpdir()
  const bytes = Buffer.from("original")
  const createdAt = Date.now()
  const attachment = { profile: "kernel_media" as const, attachmentID: "b".repeat(64), contentRef: "b".repeat(64),
    filename: "controlled.bin", mime: "application/octet-stream", sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), createdAt, expiresAt: createdAt + 86400000 }
  const server = createServer((request, response) => {
    if (!request.url?.includes("/content")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(attachment)); return }
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length + 1),
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
    response.end(bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No private HTTP address")
    const url = `http://127.0.0.1:${address.port}`
    const client = createIMClient({ url, directory: dir.path, client: createOpencodeClient({ baseUrl: url }) })
    await expect(client.streamRemoteAttachment({ groupID: "group", messageID: "message", attachment }, new AbortController().signal))
      .rejects.toThrow("Attachment response is unavailable")
    expect(await parts(dir.path)).toEqual([])
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    expect(server.listening).toBe(false)
  }
})

test("stream publisher checks image magic before metadata seal or publication", async () => {
  await using dir = await tmpdir()
  const bytes = new TextEncoder().encode("an ordinary text body with a PNG claim")
  let sealed = false
  const filename = path.join(dir.path, "invalid.png")
  await expect(publishMediaStream(filename, {
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.subarray(0, 1)); controller.enqueue(bytes.subarray(1)); controller.close() } }),
    sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mime: "image/png", expiresAt: Date.now() + 86400000,
    seal: async () => { sealed = true },
  }, new AbortController().signal)).rejects.toThrow("media_integrity_failed")
  expect(sealed).toBe(false)
  expect(await Bun.file(filename).exists()).toBe(false)
  expect(await parts(dir.path)).toEqual([])
})

test("authenticated local stream keeps original metadata identity and seals before no-replace publish", async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path)
  const signal = new AbortController().signal
  const source = await api.client.streamAttachment(api.localAttachment, signal)
  const filename = path.join(dir.path, "local.bin")
  api.gate.resolve()
  await publishMediaStream(filename, source, signal)
  expect(createHash("sha256").update(await fs.readFile(filename)).digest("hex")).toBe(api.localAttachment.checksum)
  expect(api.state.metadata).toBe(2)
  expect(api.state.contentRequests).toBe(1)
  expect(api.state.nonGET).toBe(0)
  expect(await parts(dir.path)).toEqual([])
})

test("a same-inode staged body mutation during final metadata seal cannot publish the earlier digest", async () => {
  await using dir = await tmpdir()
  const bytes = new TextEncoder().encode("original body")
  const filename = path.join(dir.path, "target.bin")
  await expect(publishMediaStream(filename, {
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }),
    sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), expiresAt: Date.now() + 86400000,
    seal: async () => {
      await fs.writeFile(path.join(dir.path, (await parts(dir.path))[0], "body.part"), "modified body")
    },
  }, new AbortController().signal)).rejects.toThrow("media_file_changed")
  expect(await Bun.file(filename).exists()).toBe(false)
  expect(await parts(dir.path)).toEqual([])
})

for (const change of ["current", "parent alias"] as const) test(`a real link followed by changed ${change} removes only its own published inode`, async () => {
  await using dir = await tmpdir()
  const parent = path.join(dir.path, "original")
  const other = path.join(dir.path, "other")
  const alias = path.join(dir.path, "alias")
  await fs.mkdir(parent)
  await fs.mkdir(other)
  await fs.symlink(parent, alias)
  const filename = path.join(alias, "target.bin")
  const bytes = new TextEncoder().encode("original body")
  let current = true
  // Scheduling observation only: restore and delegate to the real native link.
  const gate = spyOn(fs, "link").mockImplementation(async (...args) => {
    gate.mockRestore()
    await fs.link(...args)
    if (change === "current") current = false
    if (change === "parent alias") {
      await fs.unlink(alias)
      await fs.symlink(other, alias)
    }
  })
  try {
    await expect(publishMediaStream(filename, {
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }),
      sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), expiresAt: Date.now() + 86400000,
      seal: async () => {},
    }, new AbortController().signal, () => current)).rejects.toThrow(change === "current" ? "media_scope_changed" : "media_file_changed")
    expect(await Bun.file(path.join(parent, "target.bin")).exists()).toBe(false)
    expect(await Bun.file(path.join(other, "target.bin")).exists()).toBe(false)
    expect(await parts(parent)).toEqual([])
  } finally {
    gate.mockRestore()
  }
})

for (const change of ["source", "target", "parent"] as const) test(`real link ${change} pathname replacement is explicit and never deletes a foreign inode`, async () => {
  await using dir = await tmpdir()
  const parent = path.join(dir.path, "original")
  await fs.mkdir(parent)
  const filename = path.join(parent, "target.bin")
  const bytes = new TextEncoder().encode("original body")
  let residue = filename
  const gate = spyOn(fs, "link").mockImplementation(async (...args) => {
    gate.mockRestore()
    if (change === "source") {
      await fs.rename(String(args[0]), `${String(args[0])}.original`)
      await fs.writeFile(String(args[0]), "foreign replacement")
    }
    await fs.link(...args)
    if (change === "target") {
      await fs.rename(filename, `${filename}.original`)
      await fs.writeFile(filename, "foreign replacement")
    }
    if (change === "parent") {
      await fs.rename(parent, `${parent}.original`)
      residue = path.join(`${parent}.original`, "target.bin")
      await fs.mkdir(parent)
      await fs.writeFile(filename, "foreign replacement")
    }
  })
  try {
    const result = await publishMediaStream(filename, {
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }),
      sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), expiresAt: Date.now() + 86400000,
      seal: async () => {},
    }, new AbortController().signal).then(() => undefined, (error: unknown) => error)
    expect(result).toBeInstanceOf(MediaPublicationError)
    expect(result instanceof MediaPublicationError && result.code).toBe("media_publication_unknown")
    expect(await fs.readFile(filename, "utf8")).toBe("foreign replacement")
    if (change === "parent") expect(await fs.readFile(residue, "utf8")).toBe("original body")
  } finally {
    gate.mockRestore()
  }
})

test("the original save form explicitly reports an unverified foreign post-link target", async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path)
  using ui = await mountIM(dir.path, api.server.url.href, () => <DialogIM />, 100)
  const filename = path.join(dir.path, "unverified.bin")
  const gate = spyOn(fs, "link").mockImplementation(async (...args) => {
    gate.mockRestore()
    await fs.rename(String(args[0]), `${String(args[0])}.original`)
    await fs.writeFile(String(args[0]), "foreign replacement")
    await fs.link(...args)
  })
  try {
    await startSave(ui, filename, api.attachment.sizeBytes)
    api.gate.resolve()
    await ui.frame("Save verification failed")
    expect(ui.app.captureCharFrame()).toContain("check it before use")
    expect(ui.app.captureCharFrame()).toContain("Save to a new path")
    expect(ui.app.captureCharFrame()).not.toContain("File saved and verified")
    expect(await fs.readFile(filename, "utf8")).toBe("foreign replacement")
    expect(api.state.contentRequests).toBe(1)
    expect(api.state.nonGET).toBe(0)
  } finally {
    gate.mockRestore()
  }
})


test("original thirty-second heartbeat preserves a slow protected 10 MiB save with the original Host event contract", async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path, 10 * 1024 * 1024)
  api.state.strictHeartbeat = true
  using ui = await mountIM(dir.path, api.server.url.href, () => <DialogIM />, 80)
  const filename = path.join(dir.path, "heartbeat-received.bin")
  await startSave(ui, filename, api.attachment.sizeBytes)
  await until(() => api.state.streaming, "original slow stream")
  const started = performance.now()
  await until(() => api.state.heartbeats > 0, "original unmodified thirty-second heartbeat", 35_000)
  await ui.app.renderOnce()
  await Bun.sleep(30)
  await ui.app.renderOnce()
  if (process.env.DAC_TUI_HEARTBEAT_OBSERVATION) await Bun.write(process.env.DAC_TUI_HEARTBEAT_OBSERVATION,
    JSON.stringify({ elapsedMillis: Math.round(performance.now() - started), heartbeats: api.state.heartbeats,
      invalidHeartbeats: api.state.invalidHeartbeats, closes: api.state.closes,
      saveForm: ui.app.captureCharFrame().includes("Save to a new path"),
      working: ui.app.captureCharFrame().includes("Working"),
      parentUnavailable: ui.app.captureCharFrame().includes("Remote conversation is currently unavailable."),
      offline: ui.app.captureCharFrame().includes("Connection: offline"),
      sentBytes: api.state.sentBytes, pagesDuringDownload: api.state.pagesDuringDownload,
      streamCancelled: api.state.streamCancelled, targetExists: await Bun.file(filename).exists(), nonGET: api.state.nonGET }, null, 2) + "\n")
  expect(performance.now() - started).toBeGreaterThan(28_000)
  expect(api.state.invalidHeartbeats).toBe(0)
  expect(api.state.closes).toEqual([])
  await ui.app.renderOnce()
  expect(ui.app.captureCharFrame()).toContain("Save to a new path")
  expect(ui.app.captureCharFrame()).toContain("Working")
  expect(ui.app.captureCharFrame()).not.toContain("Remote conversation is currently unavailable.")
  expect(api.state.pagesDuringDownload).toBeGreaterThanOrEqual(5)
  api.gate.resolve()
  await until(() => Bun.file(filename).size === api.attachment.sizeBytes, "publication after the original heartbeat", 8000)
  await ui.frame("File saved and verified")
  const saved = await fs.readFile(filename)
  expect(createHash("sha256").update(saved).digest("hex")).toBe(api.attachment.sha256)
  expect(api.state.sentBytes).toBe(10485760)
  expect(api.state.contentRequests).toBe(1)
  expect(api.state.metadata).toBe(3)
  expect(api.state.nonGET).toBe(0)
  expect(await parts(dir.path)).toEqual([])
}, 45_000)


test("heartbeat answers the original server ping with its exact numeric timestamp", async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path)
  api.state.strictHeartbeat = true
  const scope = api.client.scope()
  const connection = openIMGroupSocket({ url: scope.url, directory: scope.directory, client: scope.client }, "group", {})
  try {
    await until(() => api.sockets.size === 1, "real heartbeat socket")
    for (const socket of api.sockets) socket.send(JSON.stringify({ type: "ping", data: { ts: 1791600000123 } }))
    await until(() => api.state.pongs.length === 1, "original server pong")
    expect(api.state.pongs).toEqual([1791600000123])
    expect(api.state.invalidHeartbeats).toBe(0)
    expect(api.state.closes).toEqual([])
    expect(api.state.nonGET).toBe(0)
  } finally { connection.close(); await until(() => api.sockets.size === 0, "owned heartbeat socket closed") }
})

test("heartbeat ignores malformed server ping data while preserving the original valid socket", async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path)
  api.state.strictHeartbeat = true
  const scope = api.client.scope()
  const connection = openIMGroupSocket({ url: scope.url, directory: scope.directory, client: scope.client }, "group", {})
  try {
    await until(() => api.sockets.size === 1, "real heartbeat socket")
    for (const socket of api.sockets) {
      socket.send(JSON.stringify({ type: "ping" }))
      socket.send(JSON.stringify({ type: "ping", data: { ts: "forged" } }))
      socket.send(JSON.stringify({ type: "ping", data: null }))
      socket.send(JSON.stringify({ type: "ping", data: { ts: 42 } }))
    }
    await until(() => api.state.pongs.length === 1, "one valid pong after malformed frames")
    expect(api.state.pongs).toEqual([42])
    expect(api.state.heartbeats).toBe(1)
    expect(api.state.invalidHeartbeats).toBe(0)
    expect(api.state.closes).toEqual([])
  } finally { connection.close(); await until(() => api.sockets.size === 0, "owned heartbeat socket closed") }
})

test("heartbeat correction keeps actual WebSocket revocation aborting the original save with no late publication", async () => {
  await using dir = await tmpdir()
  await using api = await fixture(dir.path)
  api.state.strictHeartbeat = true
  using ui = await mountIM(dir.path, api.server.url.href, () => <DialogIM />, 80)
  const filename = path.join(dir.path, "revoked-socket.bin")
  await startSave(ui, filename, api.attachment.sizeBytes)
  await until(() => api.state.streaming && api.sockets.size === 1, "owned original stream/socket")
  for (const socket of api.sockets) socket.close(1008, "Conversation access is no longer available")
  await ui.frame("Remote conversation is currently unavailable.")
  api.gate.resolve()
  await api.streamFinished.promise
  await ui.app.renderOnce()
  expect(api.state.streamCancelled).toBe(true)
  expect(await Bun.file(filename).exists()).toBe(false)
  expect(await parts(dir.path)).toEqual([])
  expect(ui.app.captureCharFrame()).not.toContain("Save to a new path")
  expect(ui.app.captureCharFrame()).not.toContain("File saved and verified")
  expect(api.state.nonGET).toBe(0)
}, 10000)
