import { Schema } from "effect"
import { WorkCommandSchema } from "@deepagent-code/core/session/work-command.schema"
import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import net from "node:net"
import path from "node:path"
import type { Readable } from "node:stream"
import { WorkCommandRuntime } from "../../src/installation/work-command-runtime"

const native = process.env.DAC_WORK_COMMAND_HELPER
const runtime = process.env.DAC_WORK_COMMAND_BUN
const it = process.platform === "darwin" && native && runtime ? test : test.skip
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const identity = (value: { dev: bigint; ino: bigint }) => ({ kind: "posix", device: String(value.dev), inode: String(value.ino) })
const frame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value))
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length)
  return Buffer.concat([size, body])
}
test("partial cleanup retains foreign files and refuses a closed directory descriptor", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-command-preparation-")))
  const root = path.join(directory, "project")
  await fs.mkdir(root, { mode: 0o700 })
  const workspace = await WorkCommandRuntime.createWorkspace(directory, `cmd_${randomUUID().replaceAll("-", "")}`, root)
  try {
    await fs.writeFile(path.join(workspace.directory, "input.ts"), "owned", { mode: 0o600 })
    await fs.writeFile(path.join(workspace.directory, "foreign.txt"), "foreign", { mode: 0o600 })
    await expect(WorkCommandRuntime.cleanupPreparedWorkspace(workspace, ["input.ts"])).rejects.toBeDefined()
    expect(await fs.readFile(path.join(workspace.directory, "input.ts"), "utf8")).toBe("owned")
    expect(await fs.readFile(path.join(workspace.directory, "foreign.txt"), "utf8")).toBe("foreign")
    await fs.unlink(path.join(workspace.directory, "foreign.txt"))
    await workspace.file.close()
    expect(workspace.file.fd).toBe(-1)
    await expect(WorkCommandRuntime.cleanupPreparedWorkspace(workspace, ["input.ts"])).rejects.toBeDefined()
    expect(await fs.readFile(path.join(workspace.directory, "input.ts"), "utf8")).toBe("owned")
  } finally { await workspace.file.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
async function readText(stream: Readable) {
  const chunks: Buffer[] = []
  const count = { bytes: 0 }
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected fixture output")
    count.bytes += chunk.length
    if (count.bytes > 1_048_576) throw new Error("Fixture output capacity exceeded")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function fixture(source: Record<string, string> | ((root: string) => Record<string, string>), outputs: string[]) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-command-native-")))
  const root = path.join(directory, "project")
  await fs.mkdir(root, { mode: 0o700 })
  // The established Work caller omits the EV preparation lifecycle callbacks.
  const held = await WorkCommandRuntime.createWorkspace(directory, `cmd_${randomUUID().replaceAll("-", "")}`, root)
  const workspace = held.directory
  const files = typeof source === "function" ? source(root) : source
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), text)
  }
  const inputs = await Promise.all(Object.entries(files).map(async ([relative, text]) => ({ relative,
    identity: identity(await fs.stat(path.join(root, relative), { bigint: true })), sha256: hash(text), bytes: Buffer.byteLength(text) })))
  const executable = await fs.realpath(runtime!)
  const bytes = await fs.readFile(executable)
  const body = { version: 1, workspace, workspace_identity: identity(await fs.stat(workspace, { bigint: true })),
    executable, executable_identity: identity(await fs.stat(executable, { bigint: true })),
    executable_sha256: hash(bytes), executable_bytes: bytes.length, argv: ["test", "--timeout", "10000"], cwd: null,
    env: { CI: "1", NO_COLOR: "1" }, cpu_seconds: 15 }
  const prepared = Bun.spawn(["/usr/bin/sandbox-exec", "-p", WorkCommandRuntime.snapshotProfile({
    helper: native!, root, workspace, inputs: Object.keys(files) }), "--", native!], {
    env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  prepared.stdin.write(frame({ op: "open_root", version: 1, id: "root", path: root,
    expected: identity(await fs.stat(root, { bigint: true })) }))
  prepared.stdin.write(frame({ op: "snapshot_workspace", id: "copy", version: 1, workspace,
    workspace_identity: body.workspace_identity, inputs, outputs, deadline_ms: 10000 }))
  prepared.stdin.write(frame({ op: "close", id: "close", version: 1 })); prepared.stdin.end()
  const response = Buffer.from(await new Response(prepared.stdout).arrayBuffer())
  const diagnostic = await new Response(prepared.stderr).text()
  expect(await prepared.exited).toBe(0)
  const replies: Record<string, unknown>[] = []
  for (let offset = 0; offset < response.length;) {
    const length = response.readUInt32BE(offset); offset += 4
    replies.push(JSON.parse(response.subarray(offset, offset + length).toString())); offset += length
  }
  expect(replies[1]?.status, diagnostic).toBe("snapshot_ready")
  return { directory, root, workspace, outputs, body,
    async run(argv?: string[], cancel = false) {
      const child = spawn("/usr/bin/sandbox-exec", ["-p", WorkCommandRuntime.sandboxProfile({ helper: native!,
        executable, workspace, outputs }), "--", native!, "--command-exec"], {
        env: { SYNTHETIC_API_KEY: "must-not-inherit", NODE_OPTIONS: "--require=/invalid", DYLD_INSERT_LIBRARIES: "/invalid" },
        stdio: ["pipe", "pipe", "pipe"],
      })
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal })))
      const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000)
      const stop = { timer: undefined as ReturnType<typeof setTimeout> | undefined, requested: false }
      if (cancel) child.stdout.once("data", () => {
        stop.requested = true
        child.kill("SIGTERM")
        stop.timer = setTimeout(() => child.kill("SIGKILL"), 100)
      })
      child.stdin.end(frame({ ...body, ...(argv ? { argv } : {}) }))
      const stdout = readText(child.stdout); const stderr = readText(child.stderr)
      const outcome = await exit
      clearTimeout(deadline); clearTimeout(stop.timer)
      return { ...outcome, pid: child.pid, stopRequested: stop.requested, stdout: await stdout, stderr: await stderr }
    },
    async [Symbol.asyncDispose]() { await held.file.close(); await fs.rm(directory, { recursive: true, force: true }) },
  }
}

it("actual bun test runs from copied inputs and writes only its prebuilt result", async () => {
  await using f = await fixture({ "sample.test.ts": `import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
test("real-work", () => { expect(21*2).toBe(42); expect(process.env.SYNTHETIC_API_KEY).toBeUndefined();
expect(process.env.NODE_OPTIONS).toBeUndefined(); expect(process.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
writeFileSync("result.txt", "测试已通过\\n"); });` }, ["result.txt"])
  const result = await f.run()
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null })
  expect(result.stderr).toContain("1 pass")
  expect(await fs.readFile(path.join(f.workspace, "result.txt"), "utf8")).toBe("测试已通过\n")
  expect(await fs.readdir(f.root)).toEqual(["sample.test.ts"])
}, 30000)

it("actual bun build creates the approved output in the bounded private workspace", async () => {
  await using f = await fixture({ "input.ts": "export const result: number = 42;\n" }, ["output.js"])
  const result = await f.run(["build", "input.ts", "--outfile", "output.js", "--target", "bun"])
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null })
  expect(await fs.readFile(path.join(f.workspace, "output.js"), "utf8")).toContain("42")
  expect(await fs.readdir(f.root)).toEqual(["input.ts"])
}, 30000)

it("actual test cannot read the live project, write outside outputs, fork or reach the loopback sink", async () => {
  const connections = { count: 0 }
  const server = net.createServer((socket) => { connections.count++; socket.destroy() })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing owned listener")
    await using f = await fixture((root) => ({ "guard.test.ts": `import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, renameSync, linkSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
test("actual containment", async () => {
expect(() => readFileSync(${JSON.stringify(path.join(root, "guard.test.ts"))})).toThrow();
expect(() => writeFileSync(${JSON.stringify(path.join(root, "outside"))}, "bad")).toThrow();
expect(() => writeFileSync("guard.test.ts", "bad")).toThrow();
expect(() => writeFileSync("extra.txt", "bad")).toThrow();
expect(() => mkdirSync("extra")).toThrow();
expect(() => renameSync("result.txt", "other.txt")).toThrow();
expect(() => linkSync("guard.test.ts", "other.txt")).toThrow();
const child=spawnSync(process.execPath, ["--version"]); expect(child.error).toBeDefined();
await expect(fetch("http://127.0.0.1:${address.port}/", {signal:AbortSignal.timeout(1000)})).rejects.toBeDefined();
writeFileSync("result.txt", "contained"); });` }), ["result.txt"])
    const result = await f.run()
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null })
    expect(connections.count).toBe(0)
    expect(await fs.readdir(f.root)).toEqual(["guard.test.ts"])
    expect(await fs.readFile(path.join(f.workspace, "result.txt"), "utf8")).toBe("contained")
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}, 30000)

it("the OS caps an approved output before an oversized write can consume more than one MiB", async () => {
  await using f = await fixture({ "large.ts": `import { writeFileSync } from "node:fs";
writeFileSync("result.txt", Buffer.alloc(2*1024*1024, 65));` }, ["result.txt"])
  const result = await f.run(["large.ts"])
  expect(result.code === 0 && result.signal === null).toBe(false)
  expect((await fs.stat(path.join(f.workspace, "result.txt"))).size).toBeLessThanOrEqual(1_048_576)
  expect(await fs.readdir(f.root)).toEqual(["large.ts"])
}, 30000)

it("cancellation retains the exact exec process until forced exit and both streams reach EOF", async () => {
  await using f = await fixture({ "wait.ts": `process.on("SIGTERM", () => {});
console.log("ready:"+process.pid); console.error("stderr-ready"); setInterval(() => {}, 1000);` }, [])
  const result = await f.run(["wait.ts"], true)
  expect(result).toMatchObject({ code: null, signal: "SIGKILL", stopRequested: true })
  expect(result.stdout).toContain(`ready:${result.pid}`)
  expect(result.stderr).toContain("stderr-ready")
  expect(() => process.kill(result.pid!, 0)).toThrow()
}, 30000)

function recipe(f: Awaited<ReturnType<typeof fixture>>, argv: string[], inputs: string[]) {
  return Schema.decodeUnknownSync(WorkCommandSchema.Recipe)({ schemaVersion: "work-command-recipe.v1", logicalID: "fixture-build", revision: 1,
    executable: { assetPath: "packages/work-file-helper/bin/darwin-arm64/bun-command-runtime", sha256: f.body.executable_sha256,
      bytes: f.body.executable_bytes, platform: "darwin-arm64", identity: f.body.executable_identity },
    argv: argv.map((value) => ({ kind: "literal", value })), parameters: [], cwd: null, inputs, outputs: f.outputs,
    environment: [{ name: "CI", value: "1" }], workspace: "private_explicit_files.v1",
    sandbox: { id: "darwin-single-process-workspace-v1", revision: 1, network: "deny", processes: 1, openFiles: 64,
      maxInputFiles: 256, maxInputFileBytes: 16777216, maxInputBytes: 67108864, maxDepth: 16,
      maxOutputFiles: 32, maxOutputFileBytes: 1048576, maxOutputBytes: 33554432 },
    timeoutMs: 15000, stdoutBytes: 1048576, stderrBytes: 1048576 })
}

it("production command executor preserves real build output until exact-object cleanup", async () => {
  const source = "export const answer: number = 42;\n"
  await using f = await fixture({ "input.ts": source }, ["output.js"])
  const workspace = { directory: f.workspace, file: await fs.open(f.workspace, "r"),
    identity: Schema.decodeUnknownSync(WorkCommandSchema.Identity)(f.body.workspace_identity) }
  try {
    const started: number[] = []
    const result = await WorkCommandRuntime.execute({ helper: native!, executable: f.body.executable,
      workspace: f.workspace, identity: workspace.identity, recipe: recipe(f, ["build", "input.ts", "--outfile", "output.js"], ["input.ts"]),
      parameters: [], deadline: Date.now() + 15000, signal: new AbortController().signal,
      onStarted: async (pid) => { started.push(pid) } })
    expect(result).toMatchObject({ outcome: "exited", exitCode: 0, signal: null, stopConfirmed: true,
      stdout: { complete: true }, stderr: { complete: true } })
    expect(started).toHaveLength(1)
    const output = await WorkCommandRuntime.readOutput(workspace, "output.js", 51200)
    expect(output.bytes.toString()).toContain("42")
    expect(output.description.sha256).toBe(hash(output.bytes))
    expect(await fs.readFile(path.join(f.root, "input.ts"), "utf8")).toBe(source)
    expect(await fs.readdir(f.root)).toEqual(["input.ts"])
    await WorkCommandRuntime.cleanupWorkspace(workspace, [{ relative: "input.ts", sha256: hash(source), bytes: Buffer.byteLength(source) }, output.description])
    expect(await fs.lstat(f.workspace).then(() => false, (error) => error.code === "ENOENT")).toBe(true)
    await expect(WorkCommandRuntime.readOutput(workspace, "output.js")).rejects.toBeDefined()
  } finally { await workspace.file.close() }
}, 30000)

it("production command cancellation joins its real handle and both EOF streams", async () => {
  await using f = await fixture({ "wait.ts": 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);' }, [])
  const controller = new AbortController()
  const started: number[] = []
  const result = await WorkCommandRuntime.execute({ helper: native!, executable: f.body.executable, workspace: f.workspace,
    identity: Schema.decodeUnknownSync(WorkCommandSchema.Identity)(f.body.workspace_identity),
    recipe: recipe(f, ["wait.ts"], ["wait.ts"]), parameters: [], deadline: Date.now() + 10000, signal: controller.signal,
    onStarted: async (pid) => { started.push(pid); setTimeout(() => controller.abort(), 200) } })
  expect(result).toMatchObject({ outcome: "cancelled", stopConfirmed: true, stdout: { complete: true }, stderr: { complete: true } })
  expect(started).toHaveLength(1)
  expect(() => process.kill(started[0]!, 0)).toThrow()
}, 30000)

it("an actual helper stopped before command input settles without an unhandled pipe error", async () => {
  await using f = await fixture({ "input.ts": "export const answer = 42;\n" }, ["output.js"])
  const started: number[] = []
  const outcome = await WorkCommandRuntime.execute({ helper: native!, executable: f.body.executable, workspace: f.workspace,
    identity: Schema.decodeUnknownSync(WorkCommandSchema.Identity)(f.body.workspace_identity),
    recipe: recipe(f, ["build", "input.ts", "--outfile", "output.js"], ["input.ts"]), parameters: [],
    deadline: Date.now() + 10000, signal: new AbortController().signal,
    onStarted: async (pid) => { started.push(pid); process.kill(pid, "SIGKILL"); await Bun.sleep(50) },
  }).then(result => ({result,error:undefined}), (error:unknown) => ({result:undefined,error}))
  if (outcome.result) expect(outcome.result).toMatchObject({exitCode:null,signal:"SIGKILL",stopConfirmed:true})
  if (outcome.error) expect(outcome.error instanceof Error && outcome.error.message === "Command process outcome unknown").toBe(true)
  expect(started).toHaveLength(1)
  expect(() => process.kill(started[0]!, 0)).toThrow()
}, 30000)

it("approved Bun build watch reaches real output before cancellation", async () => {
  await using f = await fixture({ "input.ts": "export const answer: number = 42;\n" }, ["output.js"])
  const controller = new AbortController()
  const started: number[] = []
  const state = { done: false }
  const run = WorkCommandRuntime.execute({ helper: native!, executable: f.body.executable, workspace: f.workspace,
    identity: Schema.decodeUnknownSync(WorkCommandSchema.Identity)(f.body.workspace_identity),
    recipe: recipe(f, ["build", "input.ts", "--outfile", "output.js", "--watch"], ["input.ts"]),
    parameters: [], deadline: Date.now() + 15000, signal: controller.signal,
    onStarted: async (pid) => { started.push(pid) } }).finally(() => { state.done = true })
  try {
    const deadline = Date.now() + 10000
    while (!state.done && (await fs.stat(path.join(f.workspace, "output.js"))).size === 0 && Date.now() < deadline) await Bun.sleep(5)
    expect((await fs.stat(path.join(f.workspace, "output.js"))).size).toBeGreaterThan(0)
    expect(state.done).toBe(false)
  } finally { controller.abort(); await run }
  expect(await run).toMatchObject({ outcome: "cancelled", stopConfirmed: true, stdout: { complete: true }, stderr: { complete: true } })
  expect(started).toHaveLength(1)
  expect(() => process.kill(started[0]!, 0)).toThrow()
}, 30000)

it("Bun build emits both precreated JavaScript and source map outputs under the fixed sandbox", async () => {
  await using f = await fixture({ "input.ts": "export const answer: number = 42;\n" }, ["output.js", "output.js.map"])
  const result = await f.run(["build", "input.ts", "--outdir", ".", "--entry-naming", "output.js", "--sourcemap=external", "--target", "bun"])
  expect(result).toMatchObject({ code: 0, signal: null })
  expect((await fs.readFile(path.join(f.workspace, "output.js"))).byteLength).toBeGreaterThan(0)
  expect((await fs.readFile(path.join(f.workspace, "output.js.map"))).byteLength).toBeGreaterThan(0)
}, 30000)
