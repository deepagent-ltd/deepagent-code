export * as ConfigFileWrite from "./file-write"

import fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { Effect, Schema } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { Global } from "@deepagent-code/core/global"
import { SettingsPrivateFile } from "../settings/private-file"
import type { WindowsPrivateStorage } from "../installation/windows-private-storage"

export class Error extends Schema.TaggedErrorClass<Error>()("ConfigFileWriteError", {
  reason: Schema.Literals(["changed", "invalid", "unavailable", "capacity", "unknown"]),
}) {
  override get message() {
    return `Configuration file ${this.reason}`
  }
}

export type Observation = Readonly<{
  path: string
  stamp?: Readonly<{
    device: number
    inode: number
    bytes: number
    mtime: number
    ctime: number
    mode: number
    digest: string
  }>
  nativeStamp?: Readonly<{
    identity: Readonly<{ kind: "windows"; volume_serial: string; file_id: string }>
    stamp: string
    bytes: number
    digest: string
  }>
}>
export type File = Observation & Readonly<{ text?: string }>
export type Transaction = {
  files: readonly File[]
  file: (name: string) => File
  write: (file: File, text: string) => Effect.Effect<void, Error>
  remove: (file: File) => Effect.Effect<void, Error>
}
const MAX_BYTES = 16_777_216
const nativeFiles = new WeakMap<File, WindowsPrivateStorage.Snapshot | null>()
const mcpLedger = (file: string) => process.platform === "win32" &&
  path.resolve(file).toLowerCase() === path.join(Global.Path.config, "mcp-secret-migration.json").toLowerCase()
const privateFile = (file: string) => process.platform === "win32" && (!!SettingsPrivateFile.name(file) || mcpLedger(file))

/** Raw source observation: no expansion, logging, normalization or writes. */
export const read = (file: string) => Effect.suspend(() => {
  const name = process.platform === "win32" ? SettingsPrivateFile.name(file) : undefined
  if (!name && !mcpLedger(file)) return Effect.tryPromise({ try: () => observe(file), catch: safeError })
  return Effect.gen(function* () {
    const { WindowsPrivateStorage } = yield* Effect.promise(() => import("../installation/windows-private-storage"))
    const current = yield* Effect.gen(function* () {
      if (mcpLedger(file)) {
        const { McpWindowsStorage } = yield* Effect.promise(() => import("../mcp/windows-storage"))
        const storage = yield* McpWindowsStorage.Current
        if (!storage) return yield* new Error({ reason: "unavailable" })
        return yield* Effect.tryPromise({ try: () => storage.read("mcp_secret_migration"), catch: safeError })
      }
      const { WindowsSettingsStorage } = yield* Effect.promise(() => import("../installation/windows-settings-storage"))
      const storage = yield* WindowsSettingsStorage.Current
      if (!storage || !name) return yield* new Error({ reason: "unavailable" })
      return yield* storage.read(name).pipe(Effect.mapError(safeError))
    })
    const observation = current && WindowsPrivateStorage.describe(current.witness)
    if (current && !observation) return yield* new Error({ reason: "changed" })
    const result: File = Object.freeze({ path: path.resolve(file), ...(current && observation ? { text: current.text,
      nativeStamp: Object.freeze({ identity: observation.identity, stamp: observation.stamp,
        bytes: observation.bytes, digest: observation.sha256 }) } : {}) })
    nativeFiles.set(result, current?.witness ?? null)
    return result
  })
})

/** All cooperating writers take the same canonical file locks, including multi-file startup
 * maintenance. Publication is atomic per file, not an OS conditional rename or multi-file commit. */
export const transaction = <A, E, R>(files: readonly string[], body: (tx: Transaction) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const filesystem = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    yield* Effect.forEach(files, (file) =>
      filesystem.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 }),
    )
    const names = yield* Effect.forEach(files, (file) =>
      Effect.tryPromise({
        try: async () => [path.resolve(file), await canonicalFile(file)] as const,
        catch: safeError,
      }),
    )
    const canonical = [...new Set(names.map((item) => item[1]))].sort()
    // Missing Windows leaves may still differ only by spelling. Serialize those aliases
    // conservatively while preserving the real parent path used to open the lock directory.
    const locks = [
      ...new Map(canonical.map((file) => [process.platform === "win32" ? file.toLowerCase() : file, file])).entries(),
    ].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    const effect = Effect.gen(function* () {
      const observed = yield* Effect.forEach(canonical, read)
      const active = { value: true }
      return yield* body({
        files: observed,
        file: (name) => {
          const file = observed.find((file) => file.path === names.find((item) => item[0] === path.resolve(name))?.[1])
          if (!file) throw new Error({ reason: "changed" })
          return file
        },
        write: (file, text) =>
          Effect.suspend(() =>
            active.value && observed.includes(file)
              ? (privateFile(file.path)
                ? publishPrivate(file, text)
                : Effect.tryPromise({ try: () => publish(file, text), catch: safeError })).pipe(Effect.uninterruptible)
              : Effect.fail(new Error({ reason: "changed" })),
          ),
        remove: (file) =>
          Effect.suspend(() =>
            active.value && observed.includes(file)
              ? privateFile(file.path)
                ? Effect.fail(new Error({ reason: "unavailable" }))
                : Effect.tryPromise({ try: () => remove(file), catch: safeError }).pipe(Effect.uninterruptible)
              : Effect.fail(new Error({ reason: "changed" })),
          ),
      }).pipe(Effect.ensuring(Effect.sync(() => { active.value = false })))
    })
    yield* Effect.forEach(canonical, (file) =>
      filesystem.makeDirectory(path.join(path.dirname(file), ".dac-config-locks"), { recursive: true, mode: 0o700 }),
    )
    return yield* locks.reduceRight<Effect.Effect<A, E | Error | EffectFlock.LockError, R>>(
      (effect, [key, file]) => effect.pipe(flock.withLock(`config-file:${key}`, path.join(path.dirname(file), ".dac-config-locks"))),
      effect,
    )
  })

export const edit = <A>(file: string, change: (file: File) => { text?: string; value: A }, expected?: Observation) =>
  transaction([file], (tx) =>
    Effect.gen(function* () {
      const current = tx.files[0]
      if (expected && !sameObservation(current, expected)) return yield* new Error({ reason: "changed" })
      if (current.text !== undefined) {
        const errors: ParseError[] = []
        const parsed = parse(current.text, errors, { allowTrailingComma: true })
        if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed))
          return yield* new Error({ reason: "invalid" })
      }
      const result = yield* Effect.try({ try: () => change(current), catch: (error) => error }).pipe(
        Effect.catch((error) => (error instanceof Error ? Effect.fail(error) : Effect.die(error))),
      )
      if (result.text !== undefined && result.text !== current.text) yield* tx.write(current, result.text)
      return result.value
    }),
  )

/** Promise callers reuse only existing filesystem/lock layers, never an App/Session runtime. */
export const run = <A, E>(effect: Effect.Effect<A, E, FSUtil.Service | EffectFlock.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(EffectFlock.defaultLayer), Effect.provide(FSUtil.defaultLayer)))

export function sameObservation(left: Observation, right: Observation) {
  return left.path === right.path && JSON.stringify([left.stamp, left.nativeStamp]) === JSON.stringify([right.stamp, right.nativeStamp])
}

/** Native FileID observations stay distinct from POSIX stat numbers. */
export function digest(file: Observation) { return file.nativeStamp?.digest ?? file.stamp?.digest }

async function canonicalFile(file: string) {
  const absolute = path.resolve(file)
  if (privateFile(absolute)) return absolute
  const parent = await fs.realpath(path.dirname(absolute)).catch((error: unknown) => {
    if (errno(error) === "ENOENT") return path.dirname(absolute)
    throw error
  })
  const candidate = path.join(parent, path.basename(absolute))
  return fs.realpath(candidate).catch(async (error: unknown) => {
    if (errno(error) !== "ENOENT") throw error
    const leaf = await fs.lstat(candidate).catch((error: unknown) => {
      if (errno(error) === "ENOENT") return undefined
      throw error
    })
    if (leaf) throw new Error({ reason: "unavailable" })
    return candidate
  })
}

const publishPrivate = Effect.fn("ConfigFileWrite.publishPrivate")(function* (before: File, text: string) {
  const { WindowsPrivateStorage } = yield* Effect.promise(() => import("../installation/windows-private-storage"))
  if (!nativeFiles.has(before)) return yield* new Error({ reason: "changed" })
  const witness = yield* Effect.gen(function* () {
    if (mcpLedger(before.path)) {
      const { McpWindowsStorage } = yield* Effect.promise(() => import("../mcp/windows-storage"))
      const storage = yield* McpWindowsStorage.Current
      if (!storage) return yield* new Error({ reason: "unavailable" })
      return yield* Effect.tryPromise({ try: () => storage.publish("mcp_secret_migration", text, nativeFiles.get(before)!), catch: safeError })
    }
    const { WindowsSettingsStorage } = yield* Effect.promise(() => import("../installation/windows-settings-storage"))
    const storage = yield* WindowsSettingsStorage.Current
    const name = SettingsPrivateFile.name(before.path)
    if (!storage || !name) return yield* new Error({ reason: "changed" })
    return yield* storage.publish(name, text, nativeFiles.get(before)!).pipe(Effect.mapError(safeError))
  })
  return yield* Effect.gen(function* () {
    const expected = WindowsPrivateStorage.describe(witness)
    const after = yield* read(before.path)
    if (!expected || after.text !== text || !after.nativeStamp || after.nativeStamp.bytes !== expected.bytes ||
      after.nativeStamp.digest !== expected.sha256 || JSON.stringify(after.nativeStamp.identity) !== JSON.stringify(expected.identity))
      return yield* new Error({ reason: "unknown" })
  }).pipe(Effect.mapError(() => new Error({ reason: "unknown" })))
})

async function observe(file: string): Promise<File> {
  const canonical = await canonicalFile(file)
  const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if (errno(error) === "ENOENT") return undefined
    throw error
  })
  if (!handle) return { path: canonical }
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error({ reason: "unavailable" })
    if (before.size > MAX_BYTES) throw new Error({ reason: "capacity" })
    const buffer = Buffer.alloc(before.size + 1)
    const length = { value: 0 }
    while (length.value < buffer.byteLength) {
      const chunk = await handle.read(buffer, length.value, buffer.byteLength - length.value, length.value)
      if (!chunk.bytesRead) break
      length.value += chunk.bytesRead
    }
    const bytes = buffer.subarray(0, length.value)
    const after = await handle.stat()
    const named = await fs.lstat(canonical)
    if (!sameFile(before, after) || !sameFile(after, named) || bytes.byteLength !== before.size)
      throw new Error({ reason: "changed" })
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return {
      path: canonical,
      text,
      stamp: {
        device: before.dev,
        inode: before.ino,
        bytes: before.size,
        mtime: before.mtimeMs,
        ctime: before.ctimeMs,
        mode: before.mode & 0o777,
        digest: createHash("sha256").update(bytes).digest("hex"),
      },
    }
  } finally {
    await handle.close()
  }
}

async function publish(before: File, text: string) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error({ reason: "capacity" })
  const temporary = path.join(path.dirname(before.path), `.dac-config-${randomUUID()}.tmp`)
  // Windows has no Node directory-fsync contract. Its successful write is file-verified,
  // not a claim that the directory replacement survives a power loss.
  const parent =
    process.platform === "win32"
      ? undefined
      : await fs.open(path.dirname(before.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const published = { value: false }
  try {
    await parent?.sync()
    const created = await prepareReplacement(before, temporary, text)
    if (!sameObservation(await observe(before.path), before)) throw new Error({ reason: "changed" })
    // Noncooperating editors can still change the path after this check. Rename is not OS CAS.
    await fs.rename(temporary, before.path)
    published.value = true
    await parent?.sync()
    const after = await observe(before.path)
    if (
      after.path !== before.path ||
      after.text !== text ||
      after.stamp?.device !== created.dev ||
      after.stamp.inode !== created.ino ||
      after.stamp.bytes !== created.size ||
      after.stamp.mode !== (created.mode & 0o777) ||
      after.stamp.digest !== createHash("sha256").update(text, "utf8").digest("hex")
    )
      throw new Error({ reason: "unknown" })
  } catch (error) {
    if (published.value) throw new Error({ reason: "unknown" })
    throw error
  } finally {
    const cleanup = await Promise.allSettled([parent?.close(), fs.rm(temporary, { force: true })])
    if (cleanup.some((result) => result.status === "rejected"))
      throw new Error({ reason: published.value ? "unknown" : "unavailable" })
  }
}

async function prepareReplacement(before: File, temporary: string, text: string) {
  const handle = await fs.open(temporary, "wx", before.stamp?.mode ?? 0o600)
  try {
    await handle.writeFile(text, "utf8")
    await handle.chmod(before.stamp?.mode ?? 0o600)
    if (process.platform === "win32" && before.stamp) await copyWindowsACL(before.path, temporary)
    await handle.sync()
    return await handle.stat()
  } finally {
    await handle.close()
  }
}

async function remove(before: File) {
  if (!sameObservation(await observe(before.path), before)) throw new Error({ reason: "changed" })
  if (!before.stamp) return
  const parent =
    process.platform === "win32"
      ? undefined
      : await fs.open(path.dirname(before.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const removed = { value: false }
  try {
    await parent?.sync()
    if (!sameObservation(await observe(before.path), before)) throw new Error({ reason: "changed" })
    await fs.unlink(before.path)
    removed.value = true
    await parent?.sync()
    if ((await observe(before.path)).stamp) throw new Error({ reason: "unknown" })
  } catch (error) {
    if (removed.value) throw new Error({ reason: "unknown" })
    throw error
  } finally {
    await parent?.close()
  }
}

const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $source = Get-Acl -LiteralPath $env:DAC_CONFIG_ACL_SOURCE
  Set-Acl -LiteralPath $env:DAC_CONFIG_ACL_TARGET -AclObject $source
  $target = Get-Acl -LiteralPath $env:DAC_CONFIG_ACL_TARGET
  $sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
  if ($source.Owner -ne $target.Owner -or $source.GetSecurityDescriptorSddlForm($sections) -ne $target.GetSecurityDescriptorSddlForm($sections)) { exit 1 }
  exit 0
} catch { exit 1 }
`

/** Static UTF-16 script, no shell path interpolation or inherited credential environment. */
export function windowsACLInvocation(systemRoot: string, source: string, target: string) {
  if (
    !/^[a-z]:\\/i.test(systemRoot) ||
    [systemRoot, source, target].some(
      (value) =>
        !path.win32.isAbsolute(value) || ["\\", "/"].includes(path.win32.parse(value).root) || value.includes("\0"),
    )
  )
    throw new Error({ reason: "unavailable" })
  return {
    cmd: [
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64"),
    ],
    env: { SystemRoot: systemRoot, DAC_CONFIG_ACL_SOURCE: source, DAC_CONFIG_ACL_TARGET: target },
  }
}

async function copyWindowsACL(source: string, target: string) {
  const invocation = windowsACLInvocation(process.env.SystemRoot ?? "", source, target)
  const child = spawn(invocation.cmd[0]!, invocation.cmd.slice(1), {
    env: invocation.env,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  })
  const state = { closed: false, timedOut: false }
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null))
    child.once("close", (code) => { state.closed = true; resolve(code) })
  })
  const deadline = setTimeout(() => { state.timedOut = true; child.kill("SIGKILL") }, 15_000)
  const join = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
  try {
    const code = await Promise.race([exited, new Promise<null>((resolve) => {
      join.timer = setTimeout(() => resolve(null), 17_000)
    })])
    if (!state.closed) throw new Error({ reason: "unknown" })
    if (code !== 0 || state.timedOut) throw new Error({ reason: "unavailable" })
  } finally {
    clearTimeout(deadline)
    clearTimeout(join.timer)
    if (!state.closed) child.kill("SIGKILL")
  }
}

function sameFile(left: Stats, right: Stats) {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  )
}
function errno(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}
function safeError(error: unknown) {
  if (error instanceof Error) return error
  const reason = typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined
  return new Error({ reason: reason === "unknown" || reason === "changed" || reason === "invalid" || reason === "capacity"
    ? reason : error instanceof TypeError ? "invalid" : "unavailable" })
}
