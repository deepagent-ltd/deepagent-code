import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { clientMessageID } from "@deepagent-code/core/im/repository"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"

/** Real cold Host processes, current reader/InstanceStore, SQLite file and the
 * official SDK lib run against a private protocol fixture. Fixture object bytes
 * stay with the parent; this does not claim Go SQL/quota product acceptance. */
async function fixture(mode: "resume" | "denied" | "legacy" | "missing-progress") {
  const denied = mode === "denied"
  const root = await fs.mkdtemp("/tmp/dac-im-resume-caller-")
  const bytes = Buffer.alloc(262144 * 2 + 17, 77)
  const checksum = createHash("sha256").update(bytes).digest("hex")
  await fs.writeFile(path.join(root, "source.bin"), bytes, { flag: "wx", mode: 0o600 })
  const createdAt = Date.now()
  const metadata = {
    objectID: "c".repeat(64),
    uploadID: "",
    filename: "private.bin",
    mime: "",
    sizeBytes: bytes.length,
    sha256: checksum,
    state: "uploading",
    receivedBytes: 0,
    receivedChunks: 0,
    createdAt,
    expiresAt: createdAt + 86400000,
  }
  const stored = new Map<number, Buffer>()
  const calls: { stage: number; method: string; path: string }[] = []
  const puts: { stage: number; index: number }[] = []
  const uploadIDs: string[] = []
  const phase = { value: 1, drop: true, publishes: 0 }
  const native = KernelLiveFirstSeenFixture.make({
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (!pathname.startsWith("/navigator/protected-media/v1/")) return undefined
      return (async () => {
        expect(request.headers.get("authorization")).toBe("Bearer private-first-seen-token")
        calls.push({ stage: phase.value, method: request.method, path: pathname })
        const headers = {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        }
        const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers })
        if (pathname.endsWith("/transfer/capabilities"))
          return mode === "legacy"
            ? response({}, 404)
            : response({
                version: 1,
                protocol: "dac-media-resumable-v1",
                chunkBytes: 262144,
                maxChunks: 200,
                maxFileBytes: 52428800,
              })
        if (pathname.endsWith("/capabilities"))
          return response({
            version: 1,
            profile: "mysql-protected-media-v1",
            capability: "dac:media.v1",
            readerVersion: 2,
            maxFileBytes: 52428800,
            maxAttachments: 4,
            chunkBytes: 262144,
            ttlMillis: 86400000,
            authenticatedContent: true,
          })
        if (request.method === "POST" && pathname.endsWith("/objects")) {
          const input = await request.json()
          const uploadID = input.upload.uploadID
          expect(metadata.uploadID === "" || metadata.uploadID === uploadID).toBe(true)
          metadata.uploadID = uploadID
          uploadIDs.push(uploadID)
          return response(metadata)
        }
        if (pathname.endsWith("/upload-progress")) {
          if (denied) return response({}, 403)
          if (mode === "missing-progress") return response({}, 404)
          return response({
            version: 1,
            protocol: "dac-media-resumable-v1",
            object: metadata,
            chunkBytes: 262144,
            checkpointRevision: 2,
            committedIndices: [...stored.keys()].sort((a, b) => a - b),
          })
        }
        if (request.method === "PUT") {
          const index = Number(pathname.split("/").at(-1))
          puts.push({ stage: phase.value, index })
          if (phase.value === 2 && denied) return response({}, 403)
          const body = Buffer.from(await request.arrayBuffer())
          expect(body.equals(bytes.subarray(index * 262144, Math.min(bytes.length, (index + 1) * 262144)))).toBe(true)
          if (stored.has(index)) expect(stored.get(index)!.equals(body)).toBe(true)
          stored.set(index, body)
          metadata.receivedBytes = [...stored.values()].reduce((n, value) => n + value.byteLength, 0)
          metadata.receivedChunks = stored.size
          // The original chunk is durable in this fixture before one response
          // loses its body. A lost chunk ACK is not an unknown business send.
          if (phase.drop) {
            phase.drop = false
            return new Response("{", { headers })
          }
          return response(metadata)
        }
        if (pathname.endsWith("/finalize")) {
          expect(denied).toBe(false)
          expect(
            createHash("sha256")
              .update(Buffer.concat([0, 1, 2].map((index) => stored.get(index)!)))
              .digest("hex"),
          ).toBe(checksum)
          metadata.mime = "application/octet-stream"
          metadata.state = "uploaded_unbound"
          return response(metadata)
        }
        return new Response(null, { status: 404 })
      })()
    },
    outboundPublish() {
      phase.publishes++
      throw new Error("No business send is authorized by this upload fixture")
    },
    response(topic, request, original) {
      if (!original || !topic.startsWith("qry_delivery_")) return original
      return {
        ...original,
        value: {
          ...original.value,
          version: 2,
          ...(topic === "qry_delivery_changes" ? { items: [], scanProjectionKey: "" } : {}),
        },
      }
    },
  })
  const run = async (mode: "first" | "resume") => {
    const input = path.join(root, `${mode}-input.json`)
    await Bun.write(
      input,
      JSON.stringify({ root, navigator: native.server.url.origin, mode, checksum, sizeBytes: bytes.length }),
    )
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixture/kernel-media-resume-caller.ts"), input],
      {
        cwd: path.join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
          DEEPAGENT_CODE_HOME: path.join(root, "data"),
          DEEPAGENT_CODE_SKIP_DEFAULT_PLUGIN: "true",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const status = await child.exited
    const stderr = await new Response(child.stderr).text()
    await Bun.write(path.join(root, `${mode}-stderr.log`), stderr)
    expect(status).toBe(0)
    if (status !== 0) throw new Error(`Private Host fixture failed: ${stderr.slice(-1000)}`)
    return (await Bun.file(path.join(root, `${mode}-result.json`)).json()) as {
      pid: number
      outcome: string
      messageID: string | null
      localAttachmentID: string
      localCreatedAt: number
      hasTransferCapabilities: boolean
      hasUploadProgress: boolean
      copies: { messages: number; receipts: number }
    }
  }
  return {
    root,
    run,
    phase,
    metadata,
    puts,
    calls,
    uploadIDs,
    stored,
    [Symbol.asyncDispose]: async () => {
      native.server.stop(true)
      await fs.rm(root, { recursive: true })
      expect(await Bun.file(path.join(root, "host.sqlite")).exists()).toBe(false)
    },
  }
}

test("actual fixed engine cold explicit same-ID retry only sends missing chunks after a lost chunk ACK", async () => {
  await using value = await fixture("resume")
  const first = await value.run("first")
  expect(first.outcome).toBe("Failure")
  expect(first.copies).toEqual({ messages: 0, receipts: 0 })
  expect(value.puts).toEqual([{ stage: 1, index: 0 }])
  const expiry = value.metadata.expiresAt
  value.phase.value = 2
  const resumed = await value.run("resume")
  expect(resumed.pid).not.toBe(first.pid)
  expect(resumed.outcome).toBe("Success")
  expect(resumed.hasTransferCapabilities).toBe(true)
  expect(resumed.hasUploadProgress).toBe(true)
  expect(resumed.localCreatedAt).toBe(first.localCreatedAt)
  expect(resumed.messageID).toBe(clientMessageID("server", "original-cold-resume"))
  expect(resumed.copies).toEqual({ messages: 1, receipts: 1 })
  expect(value.puts).toEqual([
    { stage: 1, index: 0 },
    { stage: 2, index: 1 },
    { stage: 2, index: 2 },
  ])
  expect(value.calls.filter((call) => call.path.endsWith("/upload-progress"))).toHaveLength(1)
  expect(new Set(value.uploadIDs).size).toBe(1)
  expect(value.metadata.expiresAt).toBe(expiry)
  expect(value.phase.publishes).toBe(0)
}, 20000)

test("actual fixed engine progress denial does not fall back to chunk dispatch or finalize", async () => {
  await using value = await fixture("denied")
  expect((await value.run("first")).outcome).toBe("Failure")
  const expiry = value.metadata.expiresAt
  value.phase.value = 2
  const resumed = await value.run("resume")
  expect(resumed.outcome).toBe("Failure")
  expect(resumed.copies).toEqual({ messages: 0, receipts: 0 })
  expect(value.puts).toEqual([{ stage: 1, index: 0 }])
  expect(value.calls.filter((call) => call.path.endsWith("/upload-progress"))).toHaveLength(1)
  expect(value.calls.some((call) => call.path.endsWith("/finalize"))).toBe(false)
  expect(value.metadata.receivedChunks).toBe(1)
  expect(new Set(value.uploadIDs).size).toBe(1)
  expect(value.metadata.expiresAt).toBe(expiry)
  expect(value.phase.publishes).toBe(0)
}, 20000)

test("actual fixed engine falls back only for missing transfer capability, preserving the original object", async () => {
  await using value = await fixture("legacy")
  expect((await value.run("first")).outcome).toBe("Failure")
  const expiry = value.metadata.expiresAt
  value.phase.value = 2
  const resumed = await value.run("resume")
  expect(resumed.outcome).toBe("Success")
  expect(resumed.copies).toEqual({ messages: 1, receipts: 1 })
  expect(value.puts).toEqual([
    { stage: 1, index: 0 },
    { stage: 2, index: 0 },
    { stage: 2, index: 1 },
    { stage: 2, index: 2 },
  ])
  expect(value.calls.filter((call) => call.path.endsWith("/transfer/capabilities"))).toHaveLength(1)
  expect(value.calls.filter((call) => call.path.endsWith("/upload-progress"))).toHaveLength(0)
  expect(new Set(value.uploadIDs).size).toBe(1)
  expect(value.metadata.expiresAt).toBe(expiry)
  expect(value.phase.publishes).toBe(0)
}, 20000)

test("actual fixed engine missing progress is not the missing-capability fallback", async () => {
  await using value = await fixture("missing-progress")
  expect((await value.run("first")).outcome).toBe("Failure")
  const expiry = value.metadata.expiresAt
  value.phase.value = 2
  const resumed = await value.run("resume")
  expect(resumed.outcome).toBe("Failure")
  expect(resumed.copies).toEqual({ messages: 0, receipts: 0 })
  expect(value.puts).toEqual([{ stage: 1, index: 0 }])
  expect(value.calls.filter((call) => call.path.endsWith("/upload-progress"))).toHaveLength(1)
  expect(value.calls.some((call) => call.path.endsWith("/finalize"))).toBe(false)
  expect(value.metadata.receivedChunks).toBe(1)
  expect(new Set(value.uploadIDs).size).toBe(1)
  expect(value.metadata.expiresAt).toBe(expiry)
  expect(value.phase.publishes).toBe(0)
}, 20000)
