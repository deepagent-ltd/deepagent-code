import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { MediaProductTrace } from "./fixture/kernel-media-product-trace"

test("private trace installs on the original SDK and records a disconnected stage without exposing credentials", async () => {
  const root = await fs.mkdtemp("/tmp/dac-im-media-product-trace-dry-")
  const home = path.join(root, "A")
  await fs.mkdir(home, { mode: 0o700 })
  await import("@/im/kernel/shims")
  const sdk = (await import("@deepagent-code/im-kernel-sdk")).default
  const init = sdk.init
  const nativeFetch = globalThis.fetch
  const close = await MediaProductTrace.install(home)
  try {
    const client = sdk.init({ appkey: "trace-private-secret-appkey", navList: ["http://127.0.0.1:58642"], isSync: false, protectedDeliveryReader: true, protectedMedia: true })
    await expect(client.getProtectedMediaCapabilities()).rejects.toMatchObject({ kind: "disconnected" })
    const raw = await Bun.file(path.join(home, "media-trace-safe.jsonl")).text()
    const rows = raw.trim().split("\n").map((value) => JSON.parse(value))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ stage: "capabilities", phase: "start", callId: 1 })
    expect(rows[1]).toMatchObject({ stage: "capabilities", phase: "dispatch", callId: 1 })
    expect(rows[2]).toMatchObject({ stage: "capabilities", phase: "error", kind: "disconnected", code: 30001, callId: 1 })
    expect(raw).not.toContain("trace-private-secret-appkey")
    expect(raw).not.toContain("http://")
    expect(raw).not.toContain(root)
    expect((await fs.stat(path.join(home, "media-trace-safe.jsonl"))).mode & 0o777).toBe(0o600)
    expect(globalThis.fetch).not.toBe(nativeFetch)
  } finally {
    await close()
    expect(sdk.init).toBe(init)
    expect(globalThis.fetch).toBe(nativeFetch)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("diagnostic callbacks cannot alter the native media result or its original error", async () => {
  await import("@/im/kernel/shims")
  const sdk = (await import("@deepagent-code/im-kernel-sdk")).default
  const native = sdk.init({ appkey: "trace-private", navList: ["http://127.0.0.1:58642"], isSync: false, protectedDeliveryReader: true, protectedMedia: true })
  const original = Object.freeze({ kind: "denied", code: 30001, message: "private-secret-not-diagnostic" })
  const observed = MediaProductTrace.observe({ ...native, getProtectedMediaCapabilities: () => Promise.reject(original) }, () => { throw new Error("diagnostic sink failure") })
  expect(await observed.getProtectedMediaCapabilities().then(() => undefined, (error: unknown) => error)).toBe(original)
  const result = { version: 1 as const, profile: "mysql-protected-media-v1" as const, capability: "dac:media.v1" as const, readerVersion: 2 as const,
    maxFileBytes: 10485760 as const, maxAttachments: 4 as const, chunkBytes: 262144 as const, ttlMillis: 86400000 as const, authenticatedContent: true as const }
  const successful = MediaProductTrace.observe({ ...native, getProtectedMediaCapabilities: () => Promise.resolve(result) }, () => { throw new Error("diagnostic sink failure") })
  expect(await successful.getProtectedMediaCapabilities()).toBe(result)
})

test("bounded response facts distinguish valid metadata from mismatched Begin input without retaining either body", async () => {
  const createdAt = Date.now()
  const metadata = { objectID: "a".repeat(64), uploadID: "private-original-upload", filename: "private.bin", mime: "", sizeBytes: 3,
    sha256: "b".repeat(64), state: "uploading", receivedBytes: 0, receivedChunks: 0, createdAt, expiresAt: createdAt + 86400000 }
  const body = JSON.stringify(metadata)
  const response = () => new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)), "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } })
  const original = response()
  const matching = await MediaProductTrace.responseFacts(original, JSON.stringify({ upload: { uploadID: metadata.uploadID, filename: metadata.filename, sizeBytes: metadata.sizeBytes, sha256: metadata.sha256 } }))
  expect(matching).toMatchObject({ encodedBytes: Buffer.byteLength(body), declaredBytes: Buffer.byteLength(body), noStore: true, nosniff: true, jsonContentType: true, canonicalJSON: true, schemaAccepted: true, requestMatched: true })
  expect(await original.text()).toBe(body)
  expect(await MediaProductTrace.responseFacts(response(), JSON.stringify({ upload: { uploadID: "wrong-original", filename: metadata.filename, sizeBytes: metadata.sizeBytes, sha256: metadata.sha256 } }))).toMatchObject({ schemaAccepted: true, requestMatched: false })
  expect(JSON.stringify(matching)).not.toContain(metadata.uploadID)
  expect(JSON.stringify(matching)).not.toContain(metadata.filename)
  expect(await MediaProductTrace.responseFacts(new Response("x".repeat(5000)))).toMatchObject({ encodedBytes: 4097, schemaAccepted: false })
})
