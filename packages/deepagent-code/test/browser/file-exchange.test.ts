import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"

// This is a native binary protocol/FD oracle, not an installed Native factory approval.
test.skipIf(process.platform === "win32")("actual POSIX Rust binary FD: 50MiB once, byte-preserving create-no-replace, inode drift and close custody", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-binary-")))
  const project = path.join(root, "project")
  const stage = path.join(root, "stage")
  await fs.mkdir(project, { mode: 0o700 }); await fs.mkdir(stage, { mode: 0o700 })
  const helper = await fs.realpath(process.env.DAC_BROWSER_BINARY_HELPER ??
    path.resolve(import.meta.dir, "../../../work-file-helper/target/debug/deepagent-work-file-helper"))
  if (process.env.DAC_BROWSER_BINARY_HELPER) {
    // The standard runtime may supply the exact current producer's helper instead of a stale
    // Cargo debug output. This is binary/FD qualification, not installed Native authority.
    const expected = process.env.DAC_BROWSER_BINARY_HELPER_SHA
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error("Exact current helper SHA256 is required")
    const before = await fs.lstat(helper, { bigint: true })
    const bytes = await fs.readFile(helper)
    const after = await fs.lstat(helper, { bigint: true })
    expect(before.isFile() && before.nlink === 1n && (before.mode & 0o111n) !== 0n).toBe(true)
    expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual(
      [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs],
    )
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected)
  }
  const child = spawn(helper, [], { env: {}, stdio: ["pipe", "pipe", "pipe"] })
  child.stderr.resume()
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve))
  const state = { buffer: Buffer.alloc(0), counter: 0, pending: undefined as undefined | {
    id: string; resolve: (result: { reply: Record<string, unknown>; payload: Buffer }) => void; reject: (error: Error) => void
  } }
  child.stdout.on("data", (bytes: Buffer) => {
    state.buffer = Buffer.concat([state.buffer, bytes])
    if (!state.pending || state.buffer.length < 4) return
    const length = state.buffer.readUInt32BE(0)
    if (state.buffer.length < length + 4) return
    const reply = JSON.parse(state.buffer.subarray(4, length + 4).toString()) as Record<string, unknown>
    const size = Number(reply.payload_bytes)
    if (state.buffer.length < length + 4 + size) return
    const payload = state.buffer.subarray(length + 4, length + 4 + size)
    state.buffer = state.buffer.subarray(length + 4 + size)
    const pending = state.pending; state.pending = undefined
    pending.resolve({ reply, payload })
  })
  child.once("error", (error) => state.pending?.reject(error))
  const rpc = (input: Record<string, unknown>) => new Promise<{ reply: Record<string, unknown>; payload: Buffer }>((resolve, reject) => {
    if (state.pending) throw new Error("Overlapping native test leaves")
    const id = `binary_${state.counter++}`
    state.pending = { id, resolve, reject }
    const body = Buffer.from(JSON.stringify({ version: 1, id, ...input }))
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length)
    child.stdin.write(Buffer.concat([length, body]))
  })
  const identity = async (filename: string) => {
    const stat = await fs.lstat(filename, { bigint: true })
    return { kind: "posix", device: String(stat.dev), inode: String(stat.ino) }
  }
  try {
    const source = Buffer.alloc(BrowserFileSchema.MAX_FILE_BYTES, 0xff)
    source.write("\u0000binary\ufffd", 0, "utf8")
    await fs.writeFile(path.join(project, "source.bin"), source, { mode: 0o600 })
    const sha256 = createHash("sha256").update(source).digest("hex")
    expect((await rpc({ op: "open_root", path: project, expected: await identity(project) })).reply.status).toBe("ready")
    const observed = await rpc({ op: "observe_binary", relative: "source.bin", scan_limit: BrowserFileSchema.MAX_FILE_BYTES, deadline_ms: 30_000 })
    expect(observed.reply.status).toBe("observed")
    expect(observed.payload.length).toBe(0)
    expect((observed.reply.observation as Record<string, unknown>).file_bytes).toBe(BrowserFileSchema.MAX_FILE_BYTES)
    expect((observed.reply.observation as Record<string, unknown>).observed_sha256).toBe(sha256)
    expect((await rpc({ op: "observe", relative: "source.bin", scan_limit: 16_777_216, deadline_ms: 30_000 })).reply.status).toBe("refused")
    await fs.writeFile(path.join(project, "work.txt"), Buffer.alloc(65_536, 0x61), { mode: 0o600 })
    expect((await rpc({ op: "read", relative: "work.txt", offset: 0, length: 51_201,
      scan_limit: 16_777_216, deadline_ms: 30_000 })).reply.status).toBe("refused")
    const work = await rpc({ op: "read", relative: "work.txt", offset: 0, length: 51_200,
      scan_limit: 16_777_216, deadline_ms: 30_000 })
    expect(work.reply.status).toBe("observed")
    expect(work.payload.length).toBe(51_200)
    const refusedCapture = await rpc({ op: "open_binary", relative: "source.bin", expected: { kind: "observed", identity: await identity(path.join(project, "source.bin")),
      bytes: source.length, sha256 }, deadline_ms: 30_000 })
    expect(refusedCapture.reply.status).toBe("observed")
    const oversized = await rpc({ op: "read_binary", capture_id: refusedCapture.reply.capture_id, offset: 0,
      length: BrowserFileSchema.CHUNK_BYTES + 1, deadline_ms: 30_000 })
    expect(oversized.reply.status).toBe("refused")
    expect(oversized.payload.length).toBe(0)
    expect((await rpc({ op: "read_binary", capture_id: refusedCapture.reply.capture_id, offset: 0,
      length: 1, deadline_ms: 30_000 })).reply.status).toBe("refused")
    const open = await rpc({ op: "open_binary", relative: "source.bin", expected: { kind: "observed", identity: await identity(path.join(project, "source.bin")),
      bytes: source.length, sha256 }, deadline_ms: 30_000 })
    expect(open.reply.status).toBe("observed")
    const stream = createHash("sha256")
    const reads = { count: 0 }
    for (let offset = 0; offset < source.length; offset += BrowserFileSchema.CHUNK_BYTES) {
      const chunk = await rpc({ op: "read_binary", capture_id: open.reply.capture_id, offset,
        length: BrowserFileSchema.CHUNK_BYTES, deadline_ms: 30_000 })
      expect(chunk.reply.status).toBe("observed")
      reads.count++
      stream.update(chunk.payload)
      if (offset + chunk.payload.length === source.length) expect(chunk.reply.binary_complete).toBe(true)
    }
    expect(stream.digest("hex")).toBe(sha256)
    expect(reads.count).toBe(50)
    expect((await rpc({ op: "seal_binary", capture_id: open.reply.capture_id, deadline_ms: 30_000 })).reply.status).toBe("observed")
    expect((await rpc({ op: "seal_binary", capture_id: open.reply.capture_id, deadline_ms: 30_000 })).reply.status).toBe("refused")
    expect((await rpc({ op: "read_binary", capture_id: open.reply.capture_id, offset: source.length, length: 1, deadline_ms: 30_000 })).reply.status).toBe("refused")
    await fs.writeFile(path.join(stage, "payload"), source, { mode: 0o600 })
    const parent = await rpc({ op: "inspect_binary_destination", relative: "download.bin", deadline_ms: 30_000 })
    expect(parent.reply.status).toBe("missing")
    expect(parent.reply.destination_parent).toEqual(await identity(project))
    const prepare = await rpc({ op: "prepare_binary_write", relative: "download.bin", stage, stage_identity: await identity(stage),
      bytes: source.length, sha256, expected: { kind: "missing" }, deadline_ms: 30_000 })
    expect(prepare.reply.status).toBe("prepared")
    const published = await rpc({ op: "publish_write", prepared_id: prepare.reply.id })
    expect(published.reply.status).toBe("published")
    expect((published.reply.write as Record<string, unknown>).bytes).toBe(source.length)
    expect((published.reply.write as Record<string, unknown>).sha256).toBe(sha256)
    expect(createHash("sha256").update(await fs.readFile(path.join(project, "download.bin"))).digest("hex")).toBe(sha256)
    expect((await rpc({ op: "publish_write", prepared_id: prepare.reply.id })).reply.status).toBe("refused")
    expect((await rpc({ op: "cleanup_binary_stage", stage, stage_identity: await identity(stage) })).reply.status).toBe("cleaned")
    expect(await fs.readdir(stage)).toEqual([])
    const drift = await rpc({ op: "open_binary", relative: "source.bin", expected: { kind: "observed", identity: await identity(path.join(project, "source.bin")),
      bytes: source.length, sha256 }, deadline_ms: 30_000 })
    await fs.rename(path.join(project, "source.bin"), path.join(project, "old.bin"))
    await fs.writeFile(path.join(project, "source.bin"), source, { mode: 0o600 })
    const changed = await rpc({ op: "read_binary", capture_id: drift.reply.capture_id, offset: 0, length: 51200, deadline_ms: 30_000 })
    expect(changed.reply.status).toBe("refused")
    expect(changed.payload.length).toBe(0)
    expect((await rpc({ op: "close" })).reply.status).toBe("closed")
    expect(await exited).toBe(0)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
