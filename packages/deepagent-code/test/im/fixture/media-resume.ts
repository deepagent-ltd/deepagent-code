export * as MediaResumeFixture from "./media-resume"

import { expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { KernelLiveFirstSeenFixture } from "./kernel-live-first-seen"

/** Real cold Host processes, current reader/InstanceStore, SQLite file and the
 * official SDK lib run against a private protocol fixture. Fixture object bytes
 * stay with the parent; this does not claim Go SQL/quota product acceptance. */
export async function make(
  profile: "checkpoint" | "caller",
  mode: "resume" | "denied" | "legacy" | "missing-progress" | "no-origin" | "changed-request",
) {
  const denied = mode === "denied"
  const negative = mode === "no-origin" || mode === "changed-request" ? mode : undefined
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-im-resume-caller-"))
  const bytes = Buffer.alloc(262144 * (profile === "checkpoint" ? 1 : 2) + 17, 77)
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
    ...(profile === "checkpoint"
      ? { secondIdentity: { token: "private-cold-successor-token", userID: "receiver" } }
      : {}),
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (!pathname.startsWith("/navigator/protected-media/v1/")) return undefined
      return (async () => {
        expect(request.headers.get("authorization")).toBe(
          profile === "checkpoint" && phase.value === 2
            ? "Bearer private-cold-successor-token"
            : "Bearer private-first-seen-token",
        )
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
                maxChunks: 40,
                maxFileBytes: 10485760,
              })
        if (pathname.endsWith("/capabilities"))
          return response({
            version: 1,
            profile: "mysql-protected-media-v1",
            capability: "dac:media.v1",
            readerVersion: 2,
            maxFileBytes: 10485760,
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
              .update(
                Buffer.concat(
                  Array.from({ length: Math.ceil(bytes.length / 262144) }, (_, index) => stored.get(index)!),
                ),
              )
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
      JSON.stringify({
        root,
        navigator: native.server.url.origin,
        mode,
        rotateIdentity: profile === "checkpoint",
        checksum,
        sizeBytes: bytes.length,
        ...(negative ? { negative } : {}),
      }),
    )
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "media-resume-host.ts"), input], {
      cwd: path.join(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
        DEEPAGENT_CODE_HOME: path.join(root, "data"),
        DEEPAGENT_CODE_SKIP_DEFAULT_PLUGIN: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const status = await child.exited
    const stderr = await new Response(child.stderr).text()
    await Bun.write(path.join(root, `${mode}-stderr.log`), stderr)
    if (status !== 0) {
      const log = path.join(os.tmpdir(), `dac-im-checkpoint-host-child-${mode}-${randomUUID()}.log`)
      await fs.writeFile(log, stderr, { mode: 0o600, flag: "wx" })
      throw new Error(`Private Host fixture failed (${log}): ${stderr.slice(-1000)}`)
    }
    expect(status).toBe(0)
    const result = await Bun.file(path.join(root, `${mode}-result.json`)).json()
    return result as {
      pid: number
      outcome: string
      messageID: string | null
      localAttachmentID: string
      localCreatedAt: number
      hasTransferCapabilities: boolean
      hasUploadProgress: boolean
      copies: { messages: number; receipts: number }
      checkpoints: { records: number; bytes: number; rows: number }
      inspectionCalls: number
      fileOpens: number
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
