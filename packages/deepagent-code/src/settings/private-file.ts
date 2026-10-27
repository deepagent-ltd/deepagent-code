export * as SettingsPrivateFile from "./private-file"

import fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { Global } from "@deepagent-code/core/global"

export const MAX_BYTES = 1_048_576
const NAMES = ["settings.json", ".settings-operation.json", ".settings-receipt.json"]

/** Fixed private names are never canonicalized through a caller-created symlink. */
export function name(file: string) {
  const absolute = path.resolve(file)
  return path.dirname(absolute).toLowerCase() === path.resolve(Global.Path.config).toLowerCase() &&
    NAMES.includes(path.basename(absolute)) ? path.basename(absolute) : undefined
}

export class Error extends globalThis.Error {
  readonly _tag = "SettingsPrivateFileError"
  constructor(readonly reason: "unavailable" | "invalid" | "changed" | "capacity") {
    super(`Private settings storage ${reason}`)
  }
}

/** Missing leaves are empty. Existing private data requires the actual opened inode;
 * Windows stays unavailable until the held-handle DACL implementation is installed. */
export const read = (file: string) =>
  readEntry(file).catch((error: unknown) => {
    throw error instanceof Error ? error : new Error("unavailable")
  })

export const readEffect = (file: string) => Effect.suspend(() => {
  if (process.platform !== "win32") return Effect.tryPromise({ try: () => read(file), catch: safeError })
  return Effect.gen(function* () {
    const { WindowsSettingsStorage } = yield* Effect.promise(() => import("../installation/windows-settings-storage"))
    const storage = yield* WindowsSettingsStorage.Current
    const fixed = name(file)
    if (!storage || !fixed) return yield* Effect.fail(new Error("unavailable"))
    return yield* storage.read(fixed).pipe(Effect.mapError(safeError))
  })
})

export const parentEffect = (file: string) => Effect.suspend(() => {
  if (process.platform !== "win32") return Effect.tryPromise({ try: () => parent(file), catch: safeError })
  return Effect.gen(function* () {
    const { WindowsSettingsStorage } = yield* Effect.promise(() => import("../installation/windows-settings-storage"))
    const storage = yield* WindowsSettingsStorage.Current
    if (!storage || !name(file)) return yield* Effect.fail(new Error("unavailable"))
    yield* storage.parent.pipe(Effect.mapError(safeError))
  })
})

async function readEntry(file: string) {
  const parent = await fs.lstat(path.dirname(file)).catch((error: unknown) => {
    if (errno(error) === "ENOENT") return undefined
    throw new Error("unavailable")
  })
  if (!parent) return undefined
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if (errno(error) === "ENOENT") return undefined
    throw new Error("unavailable")
  })
  if (!handle) return undefined
  try {
    requirePrivate(parent, true)
    const before = await handle.stat()
    requirePrivate(before, false)
    if (before.size > MAX_BYTES) throw new Error("capacity")
    const buffer = Buffer.alloc(before.size + 1)
    const length = { value: 0 }
    while (length.value < buffer.length) {
      const result = await handle.read(buffer, length.value, buffer.length - length.value, length.value)
      if (result.bytesRead === 0) break
      length.value += result.bytesRead
    }
    const after = await handle.stat()
    const named = await fs.lstat(file)
    const directory = await fs.lstat(path.dirname(file))
    requirePrivate(after, false)
    requirePrivate(named, false)
    requirePrivate(directory, true)
    if (!same(before, after) || !same(after, named) || !sameDirectory(parent, directory) || length.value !== before.size)
      throw new Error("changed")
    const bytes = buffer.subarray(0, length.value)
    const text = (() => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        throw new Error("invalid")
      }
    })()
    return { text, hash: createHash("sha256").update(bytes).digest("hex") }
  } finally {
    await handle.close()
  }
}

export async function parent(file: string) {
  requirePrivate(await fs.lstat(path.dirname(file)), true)
}

function requirePrivate(stat: Stats, directory: boolean) {
  if (
    process.platform === "win32" ||
    !process.getuid ||
    stat.uid !== process.getuid() ||
    (directory
      ? !stat.isDirectory() || (stat.mode & 0o022) !== 0
      : !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
  )
    throw new Error("unavailable")
}

function same(left: Stats, right: Stats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function sameDirectory(left: Stats, right: Stats) {
  // Unrelated sibling creation changes directory size and timestamps without
  // changing the held file or its parent's identity and access boundary.
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  )
}

function errno(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}

function safeError(error: unknown) {
  if (error instanceof Error) return error
  const reason = typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined
  return new Error(reason === "invalid" || reason === "changed" || reason === "capacity" ? reason : "unavailable")
}
