import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { AttachmentPreview } from "@deepagent-code/core/im/attachment-preview"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import type { IMClient, IMRemoteAttachmentRef } from "./im-client"

let current: { close: () => void } | undefined
let generation = 0

// A user-activated, single-resource viewer. The ticket routes a resource; every byte
// request still uses the original authenticated client. No bearer, paths or open() calls.
export async function createMediaPreview(
  input: { client: IMClient; signal: AbortSignal } & (
    | { attachment: MediaIntent.Attachment; remote?: never }
    | { remote: IMRemoteAttachmentRef; attachment?: never }
  ),
) {
  input.signal.throwIfAborted()
  const identity = input.client.scope()
  const captured = ++generation
  current?.close()
  const remote = input.remote ? { ...input.remote, attachment: { ...input.remote.attachment } } : undefined
  const value = remote
    ? await input.client.getRemoteAttachment(remote, input.signal)
    : MediaIntent.attachment(input.attachment)
  if (
    value.sizeBytes > AttachmentPreview.previewBytes ||
    !["image/png", "image/jpeg"].includes(value.mime) ||
    (!remote && !("messageID" in value && value.messageID)) ||
    value.expiresAt <= Date.now()
  )
    throw new Error("media_preview_unavailable")
  if (captured !== generation || input.client.scope() !== identity || input.signal.aborted)
    throw new Error("media_preview_unavailable")
  const abort = new AbortController()
  const ticket = randomBytes(32).toString("base64url")
  const expiresAt = Math.min(Date.now() + 60_000, value.expiresAt)
  const state = { host: "", origin: "", active: false, resources: 0, requests: 0, closed: false }
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox allow-same-origin",
    "cross-origin-resource-policy": "same-origin",
  }
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 },
    (request, response) => {
      const fail = (status: number) => {
        response.writeHead(status, headers)
        response.end("Preview unavailable")
      }
      if (state.closed || input.client.scope() !== identity || expiresAt <= Date.now()) {
        fail(410)
        close()
        return
      }
      if (++state.requests > 8) {
        fail(429)
        close()
        return
      }
      if (request.method !== "GET") {
        fail(405)
        return
      }
      if (
        request.headers.host !== state.host ||
        (request.headers.origin && request.headers.origin !== state.origin) ||
        (request.headers.referer && !request.headers.referer.startsWith(`${state.origin}/`)) ||
        ["cross-site", "same-site"].includes(String(request.headers["sec-fetch-site"]))
      ) {
        fail(403)
        return
      }
      if (request.url === `/view/${ticket}`) {
        response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" })
        response.end(
          `<!doctype html><html><head><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width"><title>DeepAgent Code image</title></head><body><img src="/image/${ticket}" alt="Shared image"></body></html>`,
        )
        return
      }
      if (request.url !== `/image/${ticket}`) {
        fail(404)
        return
      }
      if (state.active || state.resources >= 4) {
        fail(429)
        return
      }
      state.active = true
      state.resources++
      const operation = new AbortController()
      const signal = AbortSignal.any([
        input.signal,
        abort.signal,
        operation.signal,
        AbortSignal.timeout(Math.min(10_000, expiresAt - Date.now())),
      ])
      // Hold the one resource slot until the response finishes/closes, not just until fetch resolves.
      const done = () => {
        operation.abort()
        state.active = false
      }
      response.once("close", done)
      response.once("finish", done)
      void (async () => {
        const bytes = remote
          ? await input.client.downloadRemoteAttachment(remote, signal)
          : await input.client.downloadAttachment(MediaIntent.attachment(value), signal)
        const inspected = AttachmentPreview.inspect(bytes)
        if (!inspected || inspected.mime !== value.mime || state.closed || expiresAt <= Date.now())
          throw new Error("media_preview_unavailable")
        signal.throwIfAborted()
        response.writeHead(200, {
          ...headers,
          "content-type": value.mime,
          "content-length": bytes.length,
          "content-disposition": "inline",
        })
        response.end(bytes)
      })().catch(() => {
        if (!response.headersSent) fail(403)
        else response.destroy()
        close()
      })
    },
  )
  server.maxConnections = 2
  server.on("error", () => close())
  const timer = setTimeout(() => close(), expiresAt - Date.now())
  timer.unref()
  function close() {
    if (state.closed) return
    state.closed = true
    clearTimeout(timer)
    abort.abort()
    input.signal.removeEventListener("abort", close)
    server.closeAllConnections()
    server.close()
    if (current?.close === close) current = undefined
  }
  input.signal.addEventListener("abort", close, { once: true })
  current = { close }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  }).catch((error) => {
    close()
    throw error
  })
  if (captured !== generation || input.client.scope() !== identity || input.signal.aborted || state.closed) {
    close()
    throw new Error("media_preview_unavailable")
  }
  const address = server.address()
  if (!address || typeof address === "string") {
    close()
    throw new Error("media_preview_unavailable")
  }
  state.host = `127.0.0.1:${address.port}`
  state.origin = `http://${state.host}`
  return { url: `${state.origin}/view/${ticket}`, expiresAt, close }
}
