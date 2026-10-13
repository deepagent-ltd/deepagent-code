import fs from "node:fs/promises"
import { constants, lstatSync, unlinkSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { AttachmentPreview } from "@deepagent-code/core/im/attachment-preview"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import type { FileHandle } from "node:fs/promises"

export type MediaFileStream = {
  readonly body: ReadableStream<Uint8Array>
  readonly sizeBytes: number
  readonly checksum: string
  readonly expiresAt: number
  readonly mime?: string
  readonly seal: () => Promise<void>
}

export class MediaPublicationError extends Error {
  readonly code = "media_publication_unknown"

  constructor(cause: unknown) {
    super("media_publication_unknown", { cause })
  }
}

export async function readMediaFile(filename: string, signal: AbortSignal) {
  signal.throwIfAborted()
  if (/[\x00-\x1f\x7f-\x9f]/.test(filename)) throw new Error("media_path_invalid")
  const expected = await fs.lstat(filename)
  if (!expected.isFile() || expected.size > AttachmentPreview.maxBytes) throw new Error("media_file_invalid")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size)
      throw new Error("media_file_changed")
    const bytes = new Uint8Array(opened.size)
    const hash = createHash("sha256")
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const chunk = await file.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
      if (!chunk.bytesRead) throw new Error("media_file_changed")
      hash.update(bytes.subarray(offset, offset + chunk.bytesRead))
      offset += chunk.bytesRead
    }
    const after = await file.stat()
    const current = await fs.lstat(filename)
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      throw new Error("media_file_changed")
    signal.throwIfAborted()
    const name = Array.from(path.basename(filename).replace(/[\x00-\x1f\x7f/\\]/g, "_"))
      .slice(0, 255)
      .join("")
    return {
      bytes,
      file: {
        name,
        mime: AttachmentPreview.mime(bytes),
        sizeBytes: bytes.length,
        checksum: hash.digest("hex"),
      } satisfies MediaIntent.File,
    }
  } finally {
    await file.close()
  }
}

export async function publishMediaFile(
  filename: string,
  bytes: Uint8Array,
  attachment: Pick<MediaIntent.Attachment, "sizeBytes" | "checksum" | "expiresAt">,
  signal: AbortSignal,
  current: () => boolean = () => true,
) {
  return publishMediaStream(filename, {
    ...attachment,
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }),
    seal: async () => {},
  }, signal, current)
}

export async function publishMediaStream(
  filename: string,
  source: MediaFileStream,
  signal: AbortSignal,
  current: () => boolean = () => true,
) {
  const reader = source.body.getReader()
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener("abort", abort, { once: true })
  const live = () => {
    signal.throwIfAborted()
    if (!current()) throw new Error("media_scope_changed")
    if (source.expiresAt <= Date.now()) throw new Error("media_expired")
  }
  let temporary: { directory: string; filename: string; dev: number; ino: number } | undefined
  let handle: FileHandle | undefined
  try {
    live()
    if (!filename.trim() || /[\x00-\x1f\x7f-\x9f]/.test(filename) ||
        !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0 || source.sizeBytes > AttachmentPreview.maxBytes ||
        !/^[a-f0-9]{64}$/.test(source.checksum) || !Number.isSafeInteger(source.expiresAt))
      throw new Error("media_file_invalid")
    const parent = await fs.realpath(path.dirname(path.resolve(filename)))
    const original = await fs.lstat(parent)
    if (!original.isDirectory()) throw new Error("media_path_invalid")
    const directory = await fs.mkdtemp(path.join(parent, ".dac-media-"))
    const owned = await fs.lstat(directory)
    temporary = { directory, filename: path.join(directory, "body.part"), dev: owned.dev, ino: owned.ino }
    // mkdtemp creates an owner-only directory; the body itself is never executable.
    await fs.chmod(directory, 0o700)
    handle = await fs.open(temporary.filename, "wx", 0o600)
    const opened = await handle.stat()
    const digest = createHash("sha256")
    const prefix = new Uint8Array(24)
    const buffer = new Uint8Array(Math.min(65536, Math.max(1, source.sizeBytes)))
    let offset = 0
    while (true) {
      live()
      const chunk = await reader.read()
      live()
      if (chunk.done) break
      if (offset + chunk.value.byteLength > source.sizeBytes) throw new Error("media_size_invalid")
      for (let written = 0; written < chunk.value.byteLength;) {
        const length = Math.min(buffer.length, chunk.value.byteLength - written)
        buffer.set(chunk.value.subarray(written, written + length))
        if (offset < prefix.length) prefix.set(buffer.subarray(0, Math.min(length, prefix.length - offset)), offset)
        for (let stored = 0; stored < length;) {
          live()
          const result = await handle.write(buffer, stored, length - stored, offset + stored)
          if (!result.bytesWritten) throw new Error("media_write_failed")
          stored += result.bytesWritten
        }
        digest.update(buffer.subarray(0, length))
        written += length
        offset += length
      }
    }
    if (offset !== source.sizeBytes || digest.digest("hex") !== source.checksum ||
        (source.mime && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.mime) &&
          AttachmentPreview.mime(prefix.subarray(0, Math.min(prefix.length, offset))) !== source.mime))
      throw new Error("media_integrity_failed")
    await handle.sync()
    const written = await handle.stat({ bigint: true })
    live()
    // Seal performs the original authenticated metadata read after all bytes;
    // neither a complete stream nor a matching hash permits publication alone.
    await source.seal()
    live()
    const file = await handle.stat()
    const named = await fs.lstat(temporary.filename)
    const folder = await fs.lstat(directory)
    const actualParent = await fs.lstat(parent)
    const sealed = await handle.stat({ bigint: true })
    if (!file.isFile() || file.size !== source.sizeBytes || (file.mode & 0o777) !== 0o600 || !sameInode(opened, file) ||
        !named.isFile() || !sameInode(file, named) || !folder.isDirectory() || !sameInode(owned, folder) ||
        (folder.mode & 0o777) !== 0o700 || !actualParent.isDirectory() || !sameInode(original, actualParent) ||
        await fs.realpath(path.dirname(path.resolve(filename))) !== parent ||
        written.size !== sealed.size || written.mtimeNs !== sealed.mtimeNs || written.ctimeNs !== sealed.ctimeNs)
      throw new Error("media_file_changed")
    live()
    const target = path.join(parent, path.basename(path.resolve(filename)))
    // link is a pathname operation. Post-link checks and compensation are needed;
    // Node does not offer descriptor-relative, identity-conditional publication.
    await fs.link(temporary.filename, target)
    try {
      live()
      const published = await fs.lstat(target)
      const publishedParent = await fs.lstat(parent)
      const publishedFile = await handle.stat({ bigint: true })
      if (!published.isFile() || !sameInode(file, published) || published.size !== source.sizeBytes ||
          !publishedParent.isDirectory() || !sameInode(original, publishedParent) ||
          await fs.realpath(path.dirname(path.resolve(filename))) !== parent ||
          sealed.size !== publishedFile.size || sealed.mtimeNs !== publishedFile.mtimeNs)
        throw new Error("media_file_changed")
      live()
    } catch (error: unknown) {
      if (!rollbackMediaPublication(target, parent, original, file)) throw new MediaPublicationError(error)
      throw error
    }
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    const opened = await handle?.stat().catch(() => undefined)
    await handle?.close()
    if (temporary && opened && sameInode(opened, await fs.lstat(temporary.filename).catch(() => undefined)))
      await fs.unlink(temporary.filename)
    if (temporary && sameInode(temporary, await fs.lstat(temporary.directory).catch(() => undefined)))
      await fs.rmdir(temporary.directory).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTEMPTY"].includes(String(error.code))) return
        throw error
      })
  }
}

function sameInode(original: { dev: number; ino: number }, current?: { dev: number; ino: number }) {
  return current !== undefined && original.dev === current.dev && original.ino === current.ino
}

function rollbackMediaPublication(
  target: string,
  parent: string,
  original: { dev: number; ino: number },
  expected: { dev: number; ino: number },
) {
  try {
    const directory = lstatSync(parent, { throwIfNoEntry: false })
    if (!directory?.isDirectory() || !sameInode(original, directory)) return false
    const file = lstatSync(target, { throwIfNoEntry: false })
    if (!file) return true
    if (!sameInode(expected, file)) return false
    // Keep the final identity check and unlink in one JS turn. A different process
    // can still race these pathname syscalls; stronger custody needs native APIs.
    unlinkSync(target)
    return true
  } catch {
    return false
  }
}

