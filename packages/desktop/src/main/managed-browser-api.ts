import { createHash } from "node:crypto"

export type ManagedBrowserAPIRequest = {
  actionTag: "browser-api-post.v1"
  profileVersion: 1
  url: string
  contentType: "application/json" | "application/x-www-form-urlencoded" | "text/plain"
  body: string
}

export type ManagedBrowserAPITarget = {
  url: string
  contentTypes: readonly ManagedBrowserAPIRequest["contentType"][]
  maxBodyBytes: number
}

/** This is a payload capture, not authority. The original Main network owner
 * separately checks its own window, document, action and current permit. */
export function captureManagedBrowserAPIRequest(
  input: ManagedBrowserAPIRequest,
  targets: readonly ManagedBrowserAPITarget[],
  origin: string,
  fail: () => never,
) {
  if (input.actionTag !== "browser-api-post.v1" || input.profileVersion !== 1 ||
    Buffer.byteLength(input.url, "utf8") > 2048 || !URL.canParse(input.url)) return fail()
  const url = new URL(input.url)
  const target = targets.find((target) => target.url === input.url && target.contentTypes.includes(input.contentType))
  if (url.protocol !== "https:" || url.href !== input.url || url.origin !== origin || url.username || url.password || input.url.includes("#") ||
    !target || !Number.isSafeInteger(target.maxBodyBytes) || target.maxBodyBytes < 1 || target.maxBodyBytes > 65536)
    return fail()
  const body = Buffer.from(input.body, "utf8")
  if (body.length > target.maxBodyBytes || body.toString("utf8") !== input.body) return fail()
  return Object.freeze({ url: input.url, contentType: input.contentType, body,
    bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") })
}

export function summarizeManagedBrowserAPIResponse(status: number, contentType: string, body: Buffer, fail: () => never) {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599 || Buffer.byteLength(contentType, "utf8") > 256 || body.length > 65536)
    return fail()
  const text = body.toString("utf8")
  const textual = /^(?:text\/[^;\s]+|application\/(?:json|[a-z0-9.+-]+\+json))(?:\s*;|$)/i.test(contentType)
  return Object.freeze({ version: 1 as const, status, contentType, bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    ...(textual && Buffer.from(text, "utf8").equals(body) ? { text } : {}) })
}
