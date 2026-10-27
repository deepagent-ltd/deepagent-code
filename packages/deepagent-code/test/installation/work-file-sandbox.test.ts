import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"
import net from "node:net"
import { sandboxProfile } from "../../src/installation/work-file-helper"

const mac = test.skipIf(process.platform !== "darwin")
const helper = process.env.DAC_WORK_FILE_HELPER_BINARY

mac("actual host policy denies network, private reads and installation writes; moved-parent publication is refused by the OS", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-work-sandbox-"))
  const base = await fs.realpath(directory)
  const root = path.join(base, "root")
  const stage = path.join(base, "stage")
  const install = path.join(root, "src", "install")
  const outside = path.join(base, "outside")
  const accepted = { count: 0 }
  const sink = net.createServer((socket) => { accepted.count++; socket.destroy() })
  const children: ReturnType<typeof spawn>[] = []
  try {
    await fs.mkdir(install, { recursive: true })
    await Promise.all([fs.mkdir(stage, { mode: 0o700 }), fs.mkdir(outside)])
    await fs.writeFile(path.join(outside, "secret"), "PRIVATE", { mode: 0o600 })
    await fs.writeFile(path.join(install, "asset"), "INSTALLED")
    await fs.writeFile(path.join(root, "src", "target"), "original")
    const binary = path.join(install, "probe")
    const build = Bun.spawn(["/usr/bin/clang", "-O0", "-Wall", "-o", binary,
      path.join(import.meta.dir, "fixture/work-file-sandbox-probe.c")], { stdout: "pipe", stderr: "pipe" })
    const diagnostic = await new Response(build.stderr).text()
    expect(await build.exited, diagnostic).toBe(0)
    await new Promise<void>((resolve, reject) => { sink.once("error", reject); sink.listen(0, "127.0.0.1", resolve) })
    const address = sink.address()
    if (!address || typeof address === "string") throw new Error("private listener missing")
    const policy = sandboxProfile({ filename: binary, root, stage,
      read: [{ kind: "tree", path: "src" }], write: [{ kind: "tree", path: "src" }], deny: [] })
    const child = spawn("/usr/bin/sandbox-exec", ["-p", policy, "--", binary, path.join(root, "src"), stage,
      path.join(outside, "secret"), path.join(install, "asset"), String(address.port)],
    { cwd: "/", env: {}, stdio: ["pipe", "pipe", "pipe"] })
    children.push(child)
    const state = { output: "", error: "" }
    const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject) })
    child.stderr.on("data", (data) => { state.error += String(data) })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`private probe timeout: ${state.error}`)), 5000)
      child.stdout.on("data", (data) => { state.output += String(data); if (state.output.includes("ready\n")) { clearTimeout(timeout); resolve() } })
      child.once("exit", () => { clearTimeout(timeout); if (!state.output.includes("ready\n")) reject(new Error(`probe exited: ${state.error}`)) })
    })
    await fs.rename(path.join(root, "src"), path.join(outside, "moved"))
    child.stdin.end("\n")
    expect(await exited).toBe(0)
    expect(state.output).toContain("secret:-1:1\n")
    expect(state.output).toContain("asset:-1:1\n")
    expect(state.output).toContain("network:-1:1\n")
    expect(state.output).toContain("fcntl80:-1:1\n")
    expect(state.output).toContain("fcntl110:-1:1\n")
    expect(state.output).toContain("publish:-1:1\n")
    expect(accepted.count).toBe(0)
    expect(await fs.readFile(path.join(outside, "moved", "target"), "utf8")).toBe("original")
    expect(await fs.readFile(path.join(stage, "payload"), "utf8")).toBe("replacement")
    expect(await fs.readFile(path.join(outside, "moved", "install", "asset"), "utf8")).toBe("INSTALLED")
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once("close", resolve)); child.kill("SIGKILL"); await closed
      }
    }
    await new Promise<void>((resolve) => sink.close(() => resolve()))
    await fs.rm(base, { recursive: true, force: true })
  }
}, 15_000)

test.skipIf(process.platform !== "darwin" || !helper)("actual native helper uses the host-generated read sandbox and cannot prepare a write", async () => {
  if (!helper) throw new Error("private helper fixture not configured")
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-work-read-sandbox-")))
  const root = path.join(base, "root")
  const stage = path.join(base, "stage")
  const binary = await fs.realpath(helper)
  try {
    await fs.mkdir(root); await fs.mkdir(stage, { mode: 0o700 }); await fs.writeFile(path.join(root, "text"), "hello")
    const identity = async (name: string) => { const value = await fs.stat(name, { bigint: true });
      return { kind: "posix", device: String(value.dev), inode: String(value.ino) } }
    const frame = (value: unknown) => { const body = Buffer.from(JSON.stringify(value)); const size = Buffer.alloc(4); size.writeUInt32BE(body.length); return Buffer.concat([size, body]) }
    const input = Buffer.concat([
      frame({ op: "open_root", version: 1, id: "root", path: root, expected: await identity(root) }),
      frame({ op: "read", version: 1, id: "read", relative: "text", offset: 0, length: 51200, scan_limit: 16777216, deadline_ms: 10000 }),
      frame({ op: "prepare_write", version: 1, id: "write", relative: "new", stage, stage_identity: await identity(stage),
        content: "forbidden", expected: { kind: "missing" }, deadline_ms: 10000 }),
      frame({ op: "close", version: 1, id: "close" }),
    ])
    const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", sandboxProfile({ filename: binary, root,
      read: [{ kind: "file", path: "text" }], write: [], deny: [] }), "--", binary],
    { cwd: "/", env: {}, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" })
    const bytes = Buffer.from(await new Response(child.stdout).arrayBuffer())
    const diagnostic = await new Response(child.stderr).text()
    expect(await child.exited, diagnostic).toBe(0)
    const statuses: string[] = []
    for (let offset = 0; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset)
      const value: unknown = JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString("utf8"))
      if (!value || typeof value !== "object" || !("status" in value) || typeof value.status !== "string" ||
        !("payload_bytes" in value) || typeof value.payload_bytes !== "number") throw new Error("invalid native response")
      statuses.push(value.status)
      offset += 4 + length + value.payload_bytes
    }
    expect(statuses).toEqual(["ready", "observed", "refused", "closed"])
    expect(await fs.readdir(stage)).toEqual([])
    expect(await fs.readFile(path.join(root, "text"), "utf8")).toBe("hello")
  } finally { await fs.rm(base, { recursive: true, force: true }) }
}, 15_000)

test.skipIf(process.platform !== "darwin" || !helper)("actual host file-only write policy publishes and cleans through one native owner", async () => {
  if (!helper) throw new Error("private helper fixture not configured")
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-work-write-policy-")))
  const root = path.join(base, "root")
  const stage = path.join(base, "stage")
  const binary = await fs.realpath(helper)
  try {
    await fs.mkdir(root); await fs.mkdir(stage, { mode: 0o700 })
    const identity = async (name: string) => { const value = await fs.stat(name, { bigint: true });
      return { kind: "posix", device: String(value.dev), inode: String(value.ino) } }
    const frame = (value: unknown) => { const body = Buffer.from(JSON.stringify(value)); const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length); return Buffer.concat([length, body]) }
    const frames = [
      { op: "open_root", version: 1, id: "root", path: root, expected: await identity(root) },
      { op: "prepare_write", version: 1, id: "write", relative: "target", stage, stage_identity: await identity(stage),
        content: "原子完整内容", expected: { kind: "missing" }, deadline_ms: 10000 },
      { op: "publish_write", version: 1, id: "publish", prepared_id: "write" },
      { op: "cleanup_write", version: 1, id: "cleanup" },
      { op: "close", version: 1, id: "close" },
    ]
    const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", sandboxProfile({ filename: binary, root, stage,
      read: [], write: [{ kind: "file", path: "target" }], deny: [] }), "--", binary],
    { cwd: "/", env: {}, stdin: new Blob([Buffer.concat(frames.map(frame))]), stdout: "pipe", stderr: "pipe" })
    const bytes = Buffer.from(await new Response(child.stdout).arrayBuffer())
    const diagnostic = await new Response(child.stderr).text()
    expect(await child.exited, diagnostic).toBe(0)
    const statuses: unknown[] = []
    for (let offset = 0; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset)
      const value: unknown = JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString("utf8"))
      if (!value || typeof value !== "object" || !("status" in value) || !("payload_bytes" in value) || value.payload_bytes !== 0)
        throw new Error("invalid fixed native write response")
      statuses.push(value.status); offset += 4 + length
    }
    expect(statuses, diagnostic).toEqual(["ready", "prepared", "published", "cleaned", "closed"])
    expect(await fs.readFile(path.join(root, "target"), "utf8")).toBe("原子完整内容")
    expect(await fs.readdir(stage)).toEqual([])
  } finally { await fs.rm(base, { recursive: true, force: true }) }
}, 15_000)
