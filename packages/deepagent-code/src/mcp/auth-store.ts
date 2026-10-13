import fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

export const MAX_BYTES = 1_048_576

export class Error extends globalThis.Error {
  readonly _tag = "McpAuthStoreError"
  constructor(readonly reason: "unavailable" | "invalid" | "capacity" | "changed" | "io") {
    super(`MCP credential store ${reason}`)
  }
}

type Stamp = { readonly device: number; readonly inode: number; readonly bytes: number; readonly mtime: number; readonly ctime: number; readonly hash: string }

// Native FD flags and fsync are required here; readJson/writeJson cannot provide this boundary.
// Only ENOENT is an empty store. Errors deliberately omit paths, payloads and OS error text.
export async function read(file: string): Promise<{ readonly text: string; readonly stamp: Stamp } | undefined> {
  try {
    await directory(file)
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
      if (errno(error) === "ENOENT") return undefined
      throw new Error("unavailable")
    })
    if (!handle) return undefined
    try {
      const before = await handle.stat()
      requirePrivate(before, "file")
      if (before.size > MAX_BYTES) throw new Error("capacity")
      const buffer = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < buffer.byteLength) {
        const chunk = await handle.read(buffer, length, buffer.byteLength - length, length)
        if (chunk.bytesRead === 0) break
        length += chunk.bytesRead
      }
      const after = await handle.stat()
      const actual = await fs.lstat(file)
      requirePrivate(after, "file")
      requirePrivate(actual, "file")
      if (length !== before.size || !sameFile(before, after) || !sameFile(after, actual)) throw new Error("changed")
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))
      return { text, stamp: { device: before.dev, inode: before.ino, bytes: before.size, mtime: before.mtimeMs, ctime: before.ctimeMs, hash: createHash("sha256").update(buffer.subarray(0, length)).digest("hex") } }
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error("io")
  }
}

/** Caller owns the fixed EffectFlock. Rename gives atomic visibility; directory fsync confirms
 * durability. A failure after rename does not undo publication and must not admit network work. */
export async function write(file: string, text: string, expected?: Stamp) {
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("capacity")
  const temporary = path.join(path.dirname(file), `.mcp-auth-${randomUUID()}.tmp`)
  try {
    await directory(file)
    const handle = await fs.open(temporary, "wx", 0o600)
    try {
      requirePrivate(await handle.stat(), "file")
      await handle.writeFile(text, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    const current = await read(file)
    if (JSON.stringify(current?.stamp) !== JSON.stringify(expected)) throw new Error("changed")
    await fs.rename(temporary, file)
    const parent = await fs.open(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
    try {
      requirePrivate(await parent.stat(), "directory")
      await parent.sync()
    } finally {
      await parent.close()
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error("io")
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => { throw new Error("io") })
  }
}

async function directory(file: string) {
  const parent = await fs.lstat(path.dirname(file))
  requirePrivate(parent, "directory")
}

function requirePrivate(stat: Stats, kind: "directory" | "file") {
  // POSIX mode is not a Windows DACL proof. Do not silently downgrade credential protection.
  if (process.platform === "win32" || !process.getuid || stat.uid !== process.getuid() ||
    (kind === "file" ? !stat.isFile() || (stat.mode & 0o077) !== 0 : !stat.isDirectory() || (stat.mode & 0o022) !== 0))
    throw new Error("unavailable")
}

function sameFile(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function errno(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}

export * as McpAuthStore from "./auth-store"
