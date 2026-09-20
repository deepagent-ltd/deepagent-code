import { randomUUID } from "node:crypto"
import { open } from "node:fs/promises"

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENT_FILES = 64
export const MAX_PICKER_AUTHORIZATIONS = 128
export const PICKER_AUTHORIZATION_TTL_MS = 10 * 60 * 1000

export function createPickedFileAuthorizations(
  read: (path: string, maxBytes: number) => Promise<ArrayBuffer> = readAttachment,
  budget = MAX_ATTACHMENT_BYTES,
) {
  const selections = new Map<
    string,
    { sender: number; paths: Set<string>; remaining: number; expiresAt: number }
  >()

  const sweep = () => {
    const now = Date.now()
    for (const [token, selection] of selections) if (selection.expiresAt <= now) selections.delete(token)
  }

  return {
    add(sender: number, paths: string[]) {
      sweep()
      if (paths.length === 0 || paths.length > MAX_ATTACHMENT_FILES) {
        throw new Error(`Select between 1 and ${MAX_ATTACHMENT_FILES} attachment files`)
      }
      if (selections.size >= MAX_PICKER_AUTHORIZATIONS) {
        throw new Error(`Too many active file picker authorizations (limit ${MAX_PICKER_AUTHORIZATIONS})`)
      }
      const token = randomUUID()
      selections.set(token, {
        sender,
        paths: new Set(paths),
        remaining: budget,
        expiresAt: Date.now() + PICKER_AUTHORIZATION_TTL_MS,
      })
      return token
    },
    async read(sender: number, token: string, path: string) {
      sweep()
      const selection = selections.get(token)
      if (selection?.sender !== sender || !selection.paths.delete(path))
        throw new Error("File was not selected by the picker")
      const bytes = await read(path, selection.remaining)
      selection.remaining -= bytes.byteLength
      if (selection.paths.size === 0) selections.delete(token)
      return bytes
    },
    release(sender: number, token: string) {
      if (selections.get(token)?.sender === sender) selections.delete(token)
    },
    releaseSender(sender: number) {
      for (const [token, selection] of selections) if (selection.sender === sender) selections.delete(token)
    },
    active() {
      sweep()
      return selections.size
    },
  }
}

export function assertAttachmentBudget(files: { size: number }[]) {
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total <= MAX_ATTACHMENT_BYTES) return
  throw new Error(`Selected attachments exceed the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit`)
}

export async function readAttachment(filePath: string, maxBytes = MAX_ATTACHMENT_BYTES) {
  const file = await open(filePath, "r")
  try {
    const info = await file.stat()
    if (info.size > maxBytes)
      throw new Error(`Selected attachments exceed the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit`)
    const bytes = Buffer.allocUnsafe(info.size)
    let offset = 0
    while (offset < info.size) {
      const result = await file.read(bytes, offset, info.size - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + offset) as ArrayBuffer
  } finally {
    await file.close()
  }
}
