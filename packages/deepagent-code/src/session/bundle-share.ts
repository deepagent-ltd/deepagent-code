import { BUNDLE_MAX_BYTES, parseSessionBundle } from "./bundle"

function serviceURL(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    throw new Error("bundle share service requires HTTPS")
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("invalid bundle share service URL")
  return url
}

function shareLink(value: string, service: URL) {
  const url = new URL(value)
  if (url.origin !== service.origin || !/^\/b\/[a-f0-9]{32}$/.test(url.pathname) || !url.hash || url.search)
    throw new Error("invalid bundle share link")
  const id = url.pathname.slice(3)
  const secret = url.hash.slice(1)
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("invalid bundle share secret")
  return { id, secret }
}

export async function uploadSessionBundle(input: { bytes: Uint8Array; service: string; uploadToken: string }) {
  const service = serviceURL(input.service)
  const response = await fetch(new URL("/api/bundles", service), {
    method: "POST",
    headers: { authorization: `Bearer ${input.uploadToken}`, "content-type": "application/zip" },
    body: new Blob([new Uint8Array(input.bytes)]),
    redirect: "error",
  })
  if (!response.ok) throw new Error(`bundle share upload failed: ${response.status}`)
  const result = await response.json() as { id?: unknown; url?: unknown; revokeToken?: unknown; expiresAt?: unknown }
  if (typeof result.url !== "string" || typeof result.revokeToken !== "string" ||
      typeof result.id !== "string" || typeof result.expiresAt !== "number")
    throw new Error("invalid bundle share response")
  if (shareLink(result.url, service).id !== result.id) throw new Error("bundle share response ID mismatch")
  return { id: result.id, url: result.url, revokeToken: result.revokeToken, expiresAt: result.expiresAt }
}

export async function downloadSessionBundle(input: { url: string; service: string }) {
  const service = serviceURL(input.service)
  const link = shareLink(input.url, service)
  const response = await fetch(new URL(`/api/bundles/${link.id}`, service), {
    headers: { authorization: `Bearer ${link.secret}` }, redirect: "error",
  })
  if (!response.ok) throw new Error(`bundle share download failed: ${response.status}`)
  if (Number(response.headers.get("content-length") ?? 0) > BUNDLE_MAX_BYTES)
    throw new Error("bundle share download exceeds 64 MiB limit")
  if (!response.body) throw new Error("bundle share download has no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    size += result.value.byteLength
    if (size > BUNDLE_MAX_BYTES) {
      await reader.cancel()
      throw new Error("bundle share download exceeds 64 MiB limit")
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return parseSessionBundle(bytes)
}

export async function revokeSessionBundle(input: { url: string; service: string; revokeToken: string }) {
  const service = serviceURL(input.service)
  const link = shareLink(input.url, service)
  const response = await fetch(new URL(`/api/bundles/${link.id}`, service), {
    method: "DELETE", headers: { authorization: `Bearer ${input.revokeToken}` }, redirect: "error",
  })
  if (!response.ok && response.status !== 404) throw new Error(`bundle share revoke failed: ${response.status}`)
}
