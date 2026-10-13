import nodePath from "node:path"
import { createHash } from "node:crypto"
import { AttachmentPreview } from "./attachment-preview"

export * as AttachmentStorage from "./attachment-storage"

/**
 * §B3 文件上传 — pure policy + storage-path derivation for IM attachments.
 *
 * This module deliberately contains NO I/O and NO effect wiring: it is the security-critical core of the
 * upload path (mime allow-list, size cap, sha256, and — most importantly — the server-derived storage
 * path that makes path traversal impossible). Keeping it pure means it can be unit-tested directly and
 * fast, decoupled from the multipart HTTP transport. The route handler calls these functions after the
 * multipart parser has persisted the bytes to a temp file.
 */

export const hardMaxBytes = AttachmentPreview.maxBytes
export const capacityBytes = 1024 * 1024 * 1024
export const maxRecords = 100_000
export const recordOverheadBytes = 8192

// A deployment may shrink the common cap, never enlarge it beyond the wire contract.
export const maxAttachmentBytes = (): number => {
  const parsed = Number(process.env.IM_MAX_ATTACHMENT_BYTES)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, hardMaxBytes) : hardMaxBytes
}

// Generous but explicit mime allow-list. Extend via IM_ATTACHMENT_EXTRA_MIME (comma-separated).
const BASE_ALLOWED_MIME = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",
  "application/pdf",
  "application/json",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/octet-stream",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/xml",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]

export const allowedMimeSet = (): Set<string> =>
  new Set<string>([
    ...BASE_ALLOWED_MIME,
    ...String(process.env.IM_ATTACHMENT_EXTRA_MIME || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  ])

// Normalize a raw Content-Type header value to a bare lowercase mime (drop parameters like `; charset`).
export const normalizeMime = (raw: string | undefined | null): string =>
  (raw || "application/octet-stream").split(";")[0].trim().toLowerCase()

// Any text/* subtype is permitted (source files, logs, etc.) in addition to the explicit allow-list.
export const isAllowedMime = (mime: string, allow: Set<string> = allowedMimeSet()): boolean =>
  allow.has(mime) || mime.startsWith("text/")

// Sanitize an arbitrary id into a single safe path segment: only [A-Za-z0-9._-], no `..`, bounded length.
// This is what prevents a crafted workspace id from introducing a separator or traversal.
export const sanitizeSegment = (s: string): string => {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_")
  return cleaned.length > 0 ? cleaned.slice(0, 128) : "default"
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

// Fixed until expiry is persisted: changing a runtime TTL could revive an expired record after restart.
export const ttlMs = (): number => 86_400_000

export const expiresAt = (createdAt: number): number => createdAt + ttlMs()

// Only raster signatures may become an image preview. SVG/HTML remain download-only files.
export const previewMime = (bytes: Uint8Array): string | undefined => {
  if (
    bytes.length >= 24 &&
    Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    Buffer.from(bytes.subarray(12, 16)).toString("ascii") === "IHDR"
  )
    return "image/png"
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(Buffer.from(bytes.subarray(0, 6)).toString("ascii")))
    return "image/gif"
  if (
    bytes.length >= 20 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  )
    return "image/webp"
}

export const isPreviewMime = (mime: string): boolean =>
  ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)

/**
 * Derive the server-controlled storage path for an attachment: `<dataDir>/im-attachments/<ws>/<id>`.
 *
 * CRITICAL: the path is built ONLY from server-generated / server-resolved ids (never the client
 * filename). The workspace segment is sanitized, and the result is verified to stay within the
 * attachments base directory — so no client-supplied value can redirect where bytes land.
 *
 * Returns `{ ok: false }` if (defensively) the resolved path escapes the base directory.
 */
export const deriveStoragePath = (input: {
  dataDir: string
  workspaceID: string
  attachmentID: string
}):
  | { readonly ok: true; readonly baseDir: string; readonly storagePath: string }
  | { readonly ok: false; readonly error: "path_escape" } => {
  const baseDir = nodePath.join(input.dataDir, "im-attachments", sanitizeSegment(input.workspaceID))
  // The attachment id is also sanitized as belt-and-suspenders (it is server-generated `ima_…`, but we
  // never want a single unexpected id to write outside the base).
  const storagePath = nodePath.join(baseDir, sanitizeSegment(input.attachmentID))

  const resolvedBase = nodePath.resolve(baseDir)
  const resolvedTarget = nodePath.resolve(storagePath)
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + nodePath.sep)) {
    return { ok: false, error: "path_escape" }
  }
  return { ok: true, baseDir, storagePath }
}

export type ValidateResult =
  | { readonly ok: true; readonly mime: string; readonly sizeBytes: number; readonly checksum: string }
  | { readonly ok: false; readonly error: "unsupported_media_type"; readonly mime: string }
  | { readonly ok: false; readonly error: "file_too_large"; readonly maxBytes: number }

/**
 * Validate an uploaded file's mime + size and compute its checksum. Pure over the already-read bytes.
 */
export const validateUpload = (input: {
  contentType: string | undefined | null
  bytes: Uint8Array
  maxBytes?: number
  allow?: Set<string>
}): ValidateResult => {
  const declared = normalizeMime(input.contentType)
  if (!isAllowedMime(declared, input.allow ?? allowedMimeSet())) {
    return { ok: false, error: "unsupported_media_type", mime: declared }
  }
  const maxBytes = Math.min(input.maxBytes ?? maxAttachmentBytes(), maxAttachmentBytes())
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || input.bytes.byteLength > maxBytes) {
    return { ok: false, error: "file_too_large", maxBytes: Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : maxAttachmentBytes() }
  }
  const raster = previewMime(input.bytes)
  if (isPreviewMime(declared) && !raster) return { ok: false, error: "unsupported_media_type", mime: declared }
  return { ok: true, mime: raster ?? declared, sizeBytes: input.bytes.byteLength, checksum: sha256Hex(input.bytes) }
}
