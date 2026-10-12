import path from "node:path"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import type { Readable } from "node:stream"
import type { FileHandle } from "node:fs/promises"
import type { WorkCommandSchema } from "@deepagent-code/core/session/work-command.schema"
import { WorkCommandMacX64Schema } from "@deepagent-code/core/session/work-command-mac-x64.schema"
import type { NativeInstallation } from "./native-installation"

export const RUNTIME_ASSET = "packages/work-file-helper/bin/darwin-arm64/bun-command-runtime"

type Workspace = { directory: string; file: FileHandle; identity: { kind: "posix"; device: string; inode: string } }
export async function createWorkspace(data: string, basename: string, project: string, lifecycle?: {
  creating: () => void; created: (workspace: Workspace) => void
}) {
  if (!/^cmd_[a-f0-9]{32}$/.test(basename) || await fs.realpath(data) !== data) throw new Error("Command workspace unavailable")
  const owner = process.getuid?.()
  const parent = await fs.lstat(data, { bigint: true })
  if (owner === undefined || !parent.isDirectory() || parent.uid !== BigInt(owner) || (parent.mode & 0o022n) !== 0n)
    throw new Error("Command workspace unavailable")
  const base = path.join(data, "work-command-stage")
  await fs.mkdir(base, { mode: 0o700 }).catch((error: unknown) => {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error
  })
  const before = await fs.lstat(base, { bigint: true })
  const directory = path.join(base, basename)
  if (!before.isDirectory() || before.uid !== BigInt(owner) || (before.mode & 0o077n) !== 0n ||
    await fs.realpath(base) !== base || directory.startsWith(`${project}/`) || project.startsWith(`${directory}/`))
    throw new Error("Command workspace unavailable")
  lifecycle?.creating()
  await fs.mkdir(directory, { mode: 0o700 })
  const file = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const actual = await file.stat({ bigint: true })
    const named = await fs.lstat(directory, { bigint: true })
    const after = await fs.lstat(base, { bigint: true })
    if (!actual.isDirectory() || actual.uid !== BigInt(owner) || (actual.mode & 0o077n) !== 0n ||
      actual.dev !== named.dev || actual.ino !== named.ino || before.dev !== after.dev || before.ino !== after.ino ||
      await fs.realpath(directory) !== directory) throw new Error("Command workspace changed")
    const workspace = { directory, file, identity: { kind: "posix" as const, device: actual.dev.toString(), inode: actual.ino.toString() } }
    lifecycle?.created(workspace)
    return workspace
  } catch (error) { await file.close(); throw error }
}

export async function currentWorkspace(workspace: { directory: string; file: FileHandle;
  identity: WorkCommandSchema.Recipe["executable"]["identity"] }) {
  const actual = await workspace.file.stat({ bigint: true })
  const named = await fs.lstat(workspace.directory, { bigint: true })
  if (!actual.isDirectory() || actual.uid !== BigInt(process.getuid!()) || (actual.mode & 0o077n) !== 0n ||
    actual.dev.toString() !== workspace.identity.device || actual.ino.toString() !== workspace.identity.inode ||
    actual.dev !== named.dev || actual.ino !== named.ino || await fs.realpath(workspace.directory) !== workspace.directory)
    throw new Error("Command workspace changed")
}

/** The command cannot mutate namespace entries. Every ancestor is nevertheless checked
 * and the actual opened output is hashed with before/after/name identity checks. */
export async function readOutput(workspace: Parameters<typeof currentWorkspace>[0], relative: string, limit = 1_048_576) {
  await currentWorkspace(workspace)
  const parts = relative.split("/")
  if (parts.length > 16 || parts.some((part) => !part || part === "." || part === "..") || /[\\:\u0000-\u001f\u007f]/.test(relative))
    throw new Error("Command output unavailable")
  for (let count = 1; count < parts.length; count++) {
    const parent = path.join(workspace.directory, ...parts.slice(0, count))
    const stat = await fs.lstat(parent, { bigint: true })
    if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n || await fs.realpath(parent) !== parent)
      throw new Error("Command output changed")
  }
  const filename = path.join(workspace.directory, relative)
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) ||
      (before.mode & 0o077n) !== 0n || before.size > BigInt(limit)) throw new Error("Command output unavailable")
    const chunks: Buffer[] = []
    const hash = createHash("sha256")
    const state = { bytes: 0 }
    const buffer = Buffer.alloc(65_536)
    while (true) {
      const read = await file.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      state.bytes += read.bytesRead
      if (state.bytes > limit) throw new Error("Command output capacity exceeded")
      hash.update(buffer.subarray(0, read.bytesRead)); chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)))
    }
    const after = await file.stat({ bigint: true })
    const named = await fs.lstat(filename, { bigint: true })
    const stamp = (stat: typeof before) => [stat.dev, stat.ino, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
    if (state.bytes !== Number(before.size) || stamp(before) !== stamp(after) || stamp(after) !== stamp(named) ||
      await fs.realpath(filename) !== filename) throw new Error("Command output changed")
    await currentWorkspace(workspace)
    return { description: { relative, identity: { kind: "posix" as const, device: before.dev.toString(), inode: before.ino.toString() },
      bytes: state.bytes, sha256: hash.digest("hex") }, bytes: Buffer.concat(chunks) }
  } finally { await file.close() }
}

export async function cleanupWorkspace(workspace: Parameters<typeof currentWorkspace>[0], expected: readonly {
  relative: string; sha256: string; bytes: number
}[], preparedDirectories?: readonly string[]) {
  await currentWorkspace(workspace)
  const directories = new Set(preparedDirectories ?? [".dac-home", ".dac-tmp"])
  const files = new Map(expected.map((entry) => [entry.relative, entry]))
  if (files.size !== expected.length || files.size > 288) throw new Error("Command cleanup unavailable")
  for (const relative of files.keys()) {
    const parts = relative.split("/")
    for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"))
  }
  // Enumerate the exact allowlist before the first unlink. Extra files, symlinks or a
  // changed output retain custody; terminal SQL status alone is not cleanup evidence.
  const visit = async (relative: string): Promise<void> => {
    const directory = await fs.opendir(path.join(workspace.directory, relative))
    for await (const entry of directory) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory() && directories.has(name)) { await visit(name); continue }
      if (!entry.isFile() || !files.has(name)) throw new Error("Command cleanup changed")
    }
  }
  await visit("")
  for (const entry of expected) {
    const actual = await readOutput(workspace, entry.relative, 16_777_216)
    if (actual.description.bytes !== entry.bytes || actual.description.sha256 !== entry.sha256) throw new Error("Command cleanup changed")
  }
  for (const entry of expected) {
    await currentWorkspace(workspace)
    const filename = path.join(workspace.directory, entry.relative)
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const held = await file.stat({ bigint: true })
      const named = await fs.lstat(filename, { bigint: true })
      if (!held.isFile() || held.nlink !== 1n || held.dev !== named.dev || held.ino !== named.ino ||
        held.size !== BigInt(entry.bytes) || await fs.realpath(filename) !== filename) throw new Error("Command cleanup changed")
      await fs.unlink(filename)
      const after = await file.stat({ bigint: true })
      if (after.dev !== held.dev || after.ino !== held.ino || after.nlink !== 0n) throw new Error("Command cleanup unknown")
      await fs.lstat(filename).then(() => { throw new Error("Command cleanup unknown") }, absent)
    } finally { await file.close() }
  }
  for (const relative of [...directories].sort((a, b) => b.split("/").length - a.split("/").length)) {
    await currentWorkspace(workspace)
    await fs.rmdir(path.join(workspace.directory, relative))
  }
  await currentWorkspace(workspace)
  const empty = await fs.opendir(workspace.directory)
  for await (const _ of empty) throw new Error("Command cleanup changed")
  await fs.rmdir(workspace.directory)
  const held = await workspace.file.stat({ bigint: true })
  if (!held.isDirectory() || held.dev.toString() !== workspace.identity.device || held.ino.toString() !== workspace.identity.inode)
    throw new Error("Command cleanup unknown")
  await fs.lstat(workspace.directory).then(() => { throw new Error("Command cleanup unknown") }, absent)
}

/** Only used before a command can dispatch, after the snapshot helper has exited.
 * The opened private workspace is the authority. A partial snapshot may contain a
 * strict subset of approved names, whose actual bytes are observed before cleanup. */
export async function cleanupPreparedWorkspace(workspace: Parameters<typeof currentWorkspace>[0], allowed: readonly string[]) {
  await currentWorkspace(workspace)
  const files: { relative: string; bytes: number; sha256: string }[] = []
  const directories: string[] = []
  const names = new Set(allowed)
  const ancestors = new Set([".dac-home", ".dac-tmp"])
  if (names.size !== allowed.length || names.size > 288) throw new Error("Command cleanup unavailable")
  for (const relative of names) {
    const parts = relative.split("/")
    if (parts.length > 16 || parts.some(part => !part || part === "." || part === "..") || /[\\:\u0000-\u001f\u007f]/.test(relative)) throw new Error("Command cleanup unavailable")
    for (let index = 1; index < parts.length; index++) ancestors.add(parts.slice(0, index).join("/"))
  }
  const deadline = Date.now() + 30_000
  const visit = async (relative: string): Promise<void> => {
    if (Date.now() >= deadline || directories.length > 4610) throw new Error("Command cleanup capacity exceeded")
    await currentWorkspace(workspace)
    const directory = path.join(workspace.directory, relative)
    const stat = await fs.lstat(directory, { bigint: true })
    if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n || await fs.realpath(directory) !== directory) throw new Error("Command cleanup changed")
    for await (const entry of await fs.opendir(directory)) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory() && ancestors.has(name)) { directories.push(name); await visit(name); continue }
      if (!entry.isFile() || !names.has(name)) throw new Error("Command cleanup changed")
      const observed = await readOutput(workspace, name, 16_777_216)
      files.push(observed.description)
      if (files.reduce((sum, file) => sum + file.bytes, 0) > 100_663_296 || Date.now() >= deadline) throw new Error("Command cleanup capacity exceeded")
    }
  }
  await visit("")
  await cleanupWorkspace(workspace, files, directories)
}

function absent(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error
}

/** Exact installed asset, not PATH or the invoking process executable. The recipe's
 * filesystem identity is captured at approval from this same installed object. */
export async function verifiedRuntime(installation: NativeInstallation.VerifiedInstalledComponents,
  expected?: WorkCommandSchema.Recipe["executable"]) {
  return verifiedMacRuntime(installation, "darwin-arm64", RUNTIME_ASSET, expected)
}

export async function verifiedMacX64Runtime(installation: NativeInstallation.VerifiedInstalledComponents,
  expected?: WorkCommandMacX64Schema.Executable) {
  return verifiedMacRuntime(installation, "darwin-x64", WorkCommandMacX64Schema.RUNTIME_ASSET, expected)
}

export async function verifiedMacRecipeRuntime(installation: NativeInstallation.VerifiedInstalledComponents,
  recipe: WorkCommandSchema.Recipe | WorkCommandMacX64Schema.Recipe) {
  if (recipe.schemaVersion === "work-command-recipe.mac-x64.v1")
    return verifiedMacX64Runtime(installation, recipe.executable)
  if (recipe.schemaVersion === "work-command-recipe.v1") return verifiedRuntime(installation, recipe.executable)
  throw new Error("Command runtime unavailable")
}

async function verifiedMacRuntime<T extends "darwin-arm64" | "darwin-x64", A extends string>(
  installation: NativeInstallation.VerifiedInstalledComponents, target: T, assetPath: A,
  expected?: WorkCommandSchema.Recipe["executable"] | WorkCommandMacX64Schema.Executable,
) {
  const { Effect } = await import("effect")
  const { NativeInstallation } = await import("./native-installation")
  if (`${process.platform}-${process.arch}` !== target) throw new Error("Command runtime unavailable")
  await Effect.runPromise(NativeInstallation.requireCurrent(installation))
  if ((await Effect.runPromise(NativeInstallation.describe(installation))).target !== target)
    throw new Error("Command runtime unavailable")
  const inventory = await Effect.runPromise(NativeInstallation.inventory(installation))
  const component = inventory.find((entry) => entry.path === assetPath)
  const filename = path.join(await Effect.runPromise(NativeInstallation.assetDirectory(installation)), "bun-command-runtime")
  if (!component || component.bytes < 1 || component.bytes > 268_435_456 || await fs.realpath(filename) !== filename)
    throw new Error("Command runtime unavailable")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(component.bytes) ||
      (before.mode & 0o022n) !== 0n || (before.mode & 0o111n) === 0n ||
      (before.uid !== 0n && before.uid !== BigInt(process.getuid!()))) throw new Error("Command runtime unavailable")
    if (target === "darwin-x64") {
      // A signed path/manifest label alone is not evidence of a native Intel image.
      const header = Buffer.alloc(32)
      const read = await file.read(header, 0, header.length, 0)
      if (read.bytesRead !== header.length || header.readUInt32LE(0) !== 0xfeedfacf ||
        header.readUInt32LE(4) !== 0x01000007 || header.readUInt32LE(12) !== 2)
        throw new Error("Command runtime unavailable")
    }
    const digest = createHash("sha256")
    const buffer = Buffer.alloc(65_536)
    const observed = { bytes: 0 }
    while (true) {
      const read = await file.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      observed.bytes += read.bytesRead
      if (observed.bytes > component.bytes) throw new Error("Command runtime changed")
      digest.update(buffer.subarray(0, read.bytesRead))
    }
    const after = await file.stat({ bigint: true })
    const named = await fs.lstat(filename, { bigint: true })
    const stamp = (stat: typeof before) => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
    if (observed.bytes !== component.bytes || digest.digest("hex") !== component.sha256 || stamp(before) !== stamp(after) ||
      stamp(after) !== stamp(named) || await fs.realpath(filename) !== filename) throw new Error("Command runtime changed")
    const identity = { kind: "posix" as const, device: before.dev.toString(), inode: before.ino.toString() }
    const executable = { assetPath, sha256: component.sha256, bytes: component.bytes,
      platform: target, identity }
    if (expected && (expected.assetPath !== assetPath || expected.sha256 !== executable.sha256 ||
      expected.bytes !== executable.bytes || expected.platform !== executable.platform ||
      expected.identity.device !== identity.device || expected.identity.inode !== identity.inode))
      throw new Error("Command runtime changed")
    return { filename, executable }
  } finally { await file.close() }
}

/** One owned native handle replaces itself with the runtime. Cancellation joins that
 * exact handle and both streams; a timeout alone cannot manufacture an exit proof. */
export async function execute(input: {
  helper: string; executable: string; workspace: string; identity: WorkCommandSchema.Record["workspaceIdentity"];
  recipe: WorkCommandSchema.Recipe | WorkCommandMacX64Schema.Recipe; parameters: WorkCommandSchema.Input["parameters"]; deadline: number;
  signal: AbortSignal; onStarted: (pid: number) => Promise<void>;
}) {
  if (!input.identity || input.signal.aborted || Date.now() >= input.deadline) throw new Error("Command dispatch unavailable")
  const argv = input.recipe.argv.map((argument) => {
    if (argument.kind === "literal") return argument.value
    const value = input.parameters.find((parameter) => parameter.key === argument.parameter)?.value
    if (value === undefined || !input.recipe.parameters.find((parameter) => parameter.key === argument.parameter)?.choices.includes(value))
      throw new Error("Command parameter unavailable")
    return value
  })
  const bytes = Buffer.from(JSON.stringify({ version: 1, workspace: input.workspace, workspace_identity: input.identity,
    executable: input.executable, executable_identity: input.recipe.executable.identity,
    executable_sha256: input.recipe.executable.sha256, executable_bytes: input.recipe.executable.bytes,
    argv, cwd: input.recipe.cwd, env: Object.fromEntries(input.recipe.environment.map((item) => [item.name, item.value])),
    cpu_seconds: Math.max(1, Math.min(600, Math.ceil((input.deadline - Date.now()) / 1000))) }))
  if (bytes.length > 65_536) throw new Error("Command frame capacity exceeded")
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length)
  const child = spawn("/usr/bin/sandbox-exec", ["-p", sandboxProfile({ helper: input.helper,
    executable: input.executable, workspace: input.workspace, outputs: input.recipe.outputs }), "--", input.helper, "--command-exec"],
  { cwd: "/", env: {}, stdio: ["pipe", "pipe", "pipe"] })
  const state = { cancelled: false, closed: false, failed: false, kill: undefined as ReturnType<typeof setTimeout> | undefined,
    abortDeadline: undefined as ReturnType<typeof setTimeout> | undefined, unknown: undefined as (() => void) | undefined }
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("error", () => { state.failed = true })
    child.once("close", (code, signal) => { state.closed = true; resolve({ code, signal }) })
  })
  const stop = () => {
    if (state.closed || state.cancelled) return
    state.cancelled = true
    child.kill("SIGTERM")
    state.kill = setTimeout(() => { if (!state.closed) child.kill("SIGKILL") }, 500)
    state.abortDeadline = setTimeout(() => state.unknown?.(), 2500)
  }
  child.stdin.once("error", () => { state.failed = true; stop() })
  input.signal.addEventListener("abort", stop, { once: true })
  const timer = setTimeout(stop, Math.max(1, input.deadline - Date.now()))
  const stdout = collect(child.stdout, input.recipe.stdoutBytes)
  const stderr = collect(child.stderr, input.recipe.stderrBytes)
  // A bound after the hard kill covers broken OS/pipe acknowledgement. Such a result is
  // unknown and retains durable custody; no process-tree or PID-reuse claim is made.
  const bounded = new Promise<undefined>((resolve) => { state.unknown = () => resolve(undefined) })
  try {
    if (child.pid === undefined) throw new Error("Command spawn unavailable")
    await input.onStarted(child.pid)
    if (input.signal.aborted) stop()
    if (!state.cancelled) child.stdin.end(Buffer.concat([size, bytes]))
    else child.stdin.destroy()
    const result = await Promise.race([Promise.all([exited, stdout, stderr]), bounded])
    if (!result || !state.closed || state.failed || !result[1].complete || !result[2].complete)
      throw new Error("Command process outcome unknown")
    return { outcome: state.cancelled ? "cancelled" as const : "exited" as const,
      exitCode: result[0].code, signal: result[0].signal, stdout: result[1], stderr: result[2], stopConfirmed: true as const }
  } finally {
    input.signal.removeEventListener("abort", stop); clearTimeout(timer); clearTimeout(state.kill); clearTimeout(state.abortDeadline)
    if (!state.closed) {
      child.kill("SIGKILL")
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2000))])
    }
  }
}

function collect(stream: Readable, limit: number) {
  return new Promise<WorkCommandSchema.Output["stdout"]>((resolve) => {
    const hash = createHash("sha256")
    const chunks: Buffer[] = []
    const state = { bytes: 0, captured: 0, ended: false, done: false }
    stream.on("data", (chunk: Buffer) => {
      state.bytes += chunk.length; hash.update(chunk)
      const keep = Math.min(chunk.length, limit - state.captured)
      if (keep > 0) { chunks.push(Buffer.from(chunk.subarray(0, keep))); state.captured += keep }
    })
    const finish = () => {
      if (state.done) return
      state.done = true
      resolve({ sha256: hash.digest("hex"), bytes: state.bytes, capturedBytes: state.captured,
        complete: state.ended, truncated: state.captured < state.bytes, text: Buffer.concat(chunks).toString("utf8") })
    }
    stream.once("end", () => { state.ended = true; finish() })
    stream.once("error", finish); stream.once("close", finish)
  })
}

/** Policy construction is not authority. The installed command factory must validate
 * the exact asset, live private workspace and current Work before launching this profile.
 * There is deliberately no ordinary shell fallback or caller-provided policy fragment. */
export function sandboxProfile(input: {
  helper: string
  executable: string
  workspace: string
  outputs: readonly string[]
}) {
  if (process.platform !== "darwin" || input.outputs.length > 32 ||
    [input.helper, input.executable, input.workspace].some((value) => !path.isAbsolute(value) || path.normalize(value) !== value ||
      Buffer.byteLength(value) > 2048 || /[\u0000-\u001f\u007f]/.test(value)) ||
    input.outputs.some((value) => value.includes("\\") || value.includes(":") || /[\u0000-\u001f\u007f]/.test(value) ||
      value.split("/").some((part) => part === "" || part === "." || part === "..") ||
      value.split("/").length > 16 || [".dac-home", ".dac-tmp"].includes(value.split("/")[0]!)) ||
    new Set(input.outputs).size !== input.outputs.length) throw new Error("Command sandbox profile unavailable")
  const literal = (value: string) => `(literal ${JSON.stringify(value)})`
  return `(version 1)
(deny default)
(allow process-exec ${literal(input.helper)} ${literal(input.executable)})
(deny process-fork)
(deny network*)
(deny appleevent-send)
(deny mach-lookup)
(deny system-fcntl (fcntl-command 80 110))
(allow sysctl-read)
(allow signal (target self))
(allow file-map-executable ${literal(input.helper)} ${literal(input.executable)} (subpath "/System/Library") (subpath "/usr/lib"))
(allow file-read-metadata)
(allow file-read-data (literal "/") ${literal(input.helper)} ${literal(input.executable)}
  (subpath "/System/Library") (subpath "/usr/lib") (subpath "/Library/Apple")
  (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")
  (subpath ${JSON.stringify(input.workspace)}))
(allow file-write-data (literal "/dev/null") ${input.outputs.map((relative) => literal(path.join(input.workspace, relative))).join(" ")})
`
}

/** A separate, short-lived copy process can read the explicit live inputs and write only
 * the private destination. It exits before the command receives any descriptor. */
export function snapshotProfile(input: { helper: string; root: string; workspace: string; inputs: readonly string[] }) {
  if ([input.helper, input.root, input.workspace].some((value) => !path.isAbsolute(value) || path.normalize(value) !== value ||
    /[\u0000-\u001f\u007f]/.test(value)) || input.workspace.startsWith(`${input.root}/`) ||
    input.root.startsWith(`${input.workspace}/`) || input.root === input.workspace || input.inputs.length > 256 ||
    input.inputs.some((value) => value.includes("\\") || value.includes(":") || /[\u0000-\u001f\u007f]/.test(value) ||
      value.split("/").some((part) => part === "" || part === "." || part === ".."))) throw new Error("Command snapshot profile unavailable")
  const literal = (value: string) => `(literal ${JSON.stringify(value)})`
  return `(version 1)(deny default)
(allow process-exec ${literal(input.helper)})(deny process-fork)(deny network*)(deny mach-lookup)
(allow sysctl-read)(allow signal (target self))(allow file-read-metadata)
(allow file-read* (literal "/") ${literal(input.helper)} ${literal(input.root)}
  (subpath "/System/Library") (subpath "/usr/lib")
  ${input.inputs.map((relative) => literal(path.join(input.root, relative))).join(" ")}
  (subpath ${JSON.stringify(input.workspace)}))
(allow file-map-executable ${literal(input.helper)} (subpath "/System/Library") (subpath "/usr/lib"))
(allow file-write* (subpath ${JSON.stringify(input.workspace)}))
(deny system-fcntl (fcntl-command 80 110))`
}

export * as WorkCommandRuntime from "./work-command-runtime"
