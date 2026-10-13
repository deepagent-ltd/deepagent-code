import type { UploadData } from "electron"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"

/** Parses bytes observed by Electron's real earliest request hook. File and blob
 * references cannot be treated as empty text or opened through this capability. */
export function capturePublicBrowserPost(data: readonly UploadData[],
  fail: (code: "BROWSER_NETWORK_DENIED" | "BROWSER_OUTPUT_LIMIT") => never) {
  if (data.length > 64) return fail("BROWSER_OUTPUT_LIMIT")
  let bytes = 0
  const chunks = data.map((entry) => {
    if (entry.file !== undefined || entry.blobUUID !== undefined || !Buffer.isBuffer(entry.bytes))
      return fail("BROWSER_NETWORK_DENIED")
    if (entry.bytes.length > BrowserSchema.MAX_POST_BYTES - bytes) return fail("BROWSER_OUTPUT_LIMIT")
    bytes += entry.bytes.length
    return Buffer.from(entry.bytes)
  })
  return Buffer.concat(chunks, bytes)
}

export function allowsPublicBrowserPostContentType(value: string) {
  return /^(?:application\/(?:x-www-form-urlencoded|json)|text\/plain)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(value)
}

export function matchesPublicBrowserPost(url: string, sourceURL: string,
  targets: readonly { origin: string; path: string }[]) {
  if (!URL.canParse(url) || !URL.canParse(sourceURL)) return false
  const target = new URL(url)
  const source = new URL(sourceURL)
  return target.protocol === "https:" && !target.username && !target.password && !target.search && !target.hash &&
    source.protocol === "https:" && source.origin === target.origin &&
    targets.some((value) => value.origin === target.origin && value.path === target.pathname)
}
