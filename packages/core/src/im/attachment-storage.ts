import nodePath from "node:path"
import { createHash } from "node:crypto"

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

// 50MB default cap, overridable via IM_MAX_ATTACHMENT_BYTES.
export const maxAttachmentBytes = (): number => {
  const parsed = parseInt(process.env.IM_MAX_ATTACHMENT_BYTES || "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50 * 1024 * 1024
}

// Generous but explicit mime allow-list. Extend via IM_ATTACHMENT_EXTRA_MIME (comma-separated).
const BASE_ALLOWED_MIME = [
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp", "image/tiff",
  "application/pdf", "application/json", "application/zip", "application/gzip", "application/x-tar",
  "application/octet-stream",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain", "text/markdown", "text/csv", "text/html", "text/xml",
  "audio/mpeg", "audio/wav", "audio/ogg",
  "video/mp4", "video/webm", "video/quicktime",
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
  const mime = normalizeMime(input.contentType)
  if (!isAllowedMime(mime, input.allow ?? allowedMimeSet())) {
    return { ok: false, error: "unsupported_media_type", mime }
  }
  const maxBytes = input.maxBytes ?? maxAttachmentBytes()
  if (input.bytes.byteLength > maxBytes) {
    return { ok: false, error: "file_too_large", maxBytes }
  }
  return { ok: true, mime, sizeBytes: input.bytes.byteLength, checksum: sha256Hex(input.bytes) }
}
