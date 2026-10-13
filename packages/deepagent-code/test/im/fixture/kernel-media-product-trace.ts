export * as MediaProductTrace from "./kernel-media-product-trace"

import fs from "node:fs/promises"
import { writeSync } from "node:fs"
import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import path from "node:path"
import type JuggleIM from "@deepagent-code/im-kernel-sdk"
import { mediaMetadata } from "../../../../im-kernel-sdk/upstream/src/delivery/media-contract"

type Client = Pick<ReturnType<typeof JuggleIM.init>, "getProtectedMediaCapabilities" | "beginProtectedMedia" | "putProtectedMediaChunk" | "finalizeProtectedMedia" | "getProtectedMedia" | "cancelProtectedMedia" | "readProtectedMediaRange" | "sendProtectedMedia">
type Stage = "capabilities" | "begin" | "chunk" | "finalize" | "status" | "cancel" | "range" | "send"
type Fact = {
  stage: Stage
  phase: "start" | "dispatch" | "settled" | "error" | "http" | "http-body"
  callId: number
  at: number
  index?: number
  bytes?: number
  idHash?: string
  status?: number
  kind?: string
  code?: number
  declaredBytes?: number
  encodedBytes?: number
  noStore?: boolean
  nosniff?: boolean
  jsonContentType?: boolean
  canonicalJSON?: boolean
  schemaAccepted?: boolean
  requestMatched?: boolean
}

const kinds = new Set(["invalid_request", "invalid_response", "disconnected", "expired", "unknown", "cancelled", "transport_timeout", "denied", "not_found", "conflict", "capacity", "unavailable", "unsupported_capability"])
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const context = new AsyncLocalStorage<{ callId: number; stage: Stage }>()

// QA observations preserve the original SDK result/error and never expose an
// SDK error message, request body, bearer, navigator URL or filesystem path.
export function observe<C extends Client>(client: C, emit: (value: Fact) => void): C {
  const calls = { value: 0 }
  const report = (value: Fact) => { try { emit(value) } catch {} }
  const observation = <A>(stage: Stage, run: () => PromiseLike<A>, facts?: Pick<Fact, "index" | "bytes" | "idHash">) => {
    const callId = ++calls.value
    report({ stage, phase: "start", callId, at: Date.now(), ...facts })
    return Promise.resolve().then(() => context.run({ callId, stage }, () => {
      report({ stage, phase: "dispatch", callId, at: Date.now(), ...facts })
      return run()
    })).then((value) => {
      report({ stage, phase: "settled", callId, at: Date.now(), ...facts })
      return value
    }, (cause: unknown) => {
      const error = cause !== null && typeof cause === "object" ? cause as { kind?: unknown; code?: unknown } : undefined
      report({ stage, phase: "error", callId, at: Date.now(), ...facts,
        kind: typeof error?.kind === "string" && kinds.has(error.kind) ? error.kind : "native_error",
        ...(typeof error?.code === "number" && Number.isInteger(error.code) && error.code >= 0 && error.code <= 65535 ? { code: error.code } : {}),
      })
      throw cause
    })
  }
  return Object.freeze({ ...client,
    getProtectedMediaCapabilities: () => observation("capabilities", () => client.getProtectedMediaCapabilities()),
    beginProtectedMedia: (input: Parameters<Client["beginProtectedMedia"]>[0]) => observation("begin", () => client.beginProtectedMedia(input), { idHash: hash(input.upload.uploadID) }),
    putProtectedMediaChunk: (input: Parameters<Client["putProtectedMediaChunk"]>[0]) => observation("chunk", () => client.putProtectedMediaChunk(input), { index: input.index, bytes: input.body.byteLength, idHash: hash(input.objectID) }),
    finalizeProtectedMedia: (input: Parameters<Client["finalizeProtectedMedia"]>[0]) => observation("finalize", () => client.finalizeProtectedMedia(input), { idHash: hash(input.objectID) }),
    getProtectedMedia: (input: Parameters<Client["getProtectedMedia"]>[0]) => observation("status", () => client.getProtectedMedia(input), { idHash: hash(input.objectID) }),
    cancelProtectedMedia: (input: Parameters<Client["cancelProtectedMedia"]>[0]) => observation("cancel", () => client.cancelProtectedMedia(input), { idHash: hash(input.objectID) }),
    readProtectedMediaRange: (input: Parameters<Client["readProtectedMediaRange"]>[0]) => observation("range", () => client.readProtectedMediaRange(input), { idHash: hash(input.attachment.contentRef) }),
    sendProtectedMedia: (input: Parameters<Client["sendProtectedMedia"]>[0]) => observation("send", () => client.sendProtectedMedia(input), { idHash: hash(input.clientMsgId) }),
  }) as C
}

// A bounded tee is observed in parallel. Only booleans and byte counts leave
// this function; the original response stream and body remain untouched.
export async function responseFacts(response: Response, requestBody?: unknown) {
  const headers = { noStore: response.headers.get("cache-control") === "no-store", nosniff: response.headers.get("x-content-type-options") === "nosniff",
    jsonContentType: response.headers.get("content-type") === "application/json; charset=utf-8",
    ...(/^(0|[1-9][0-9]*)$/.test(response.headers.get("content-length") ?? "") && Number(response.headers.get("content-length")) <= 4096
      ? { declaredBytes: Number(response.headers.get("content-length")) } : {}),
  }
  const reader = response.clone().body?.getReader()
  if (!reader) return { ...headers, encodedBytes: 0, canonicalJSON: false, schemaAccepted: false }
  const bytes = new Uint8Array(4096)
  const deadline = setTimeout(() => { void reader.cancel().catch(() => {}) }, 1000)
  try {
    let size = 0
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (part.value.byteLength > bytes.length - size) return { ...headers, encodedBytes: 4097, canonicalJSON: false, schemaAccepted: false }
      bytes.set(part.value, size)
      size += part.value.byteLength
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))
    const value = JSON.parse(raw)
    const canonicalJSON = JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")) === raw
    const metadata = mediaMetadata(value)
    const request = typeof requestBody === "string" && requestBody.length <= 4096 ? JSON.parse(requestBody) : undefined
    return { ...headers, encodedBytes: size, canonicalJSON, schemaAccepted: true,
      ...(request ? { requestMatched: metadata?.uploadID === request.upload?.uploadID && metadata?.filename === request.upload?.filename && metadata?.sizeBytes === request.upload?.sizeBytes && metadata?.sha256 === request.upload?.sha256 } : {}),
    }
  } catch {
    return { ...headers, canonicalJSON: false, schemaAccepted: false }
  } finally {
    clearTimeout(deadline)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// Install only in a fresh private integration listener, before its Server
// import. The normal product and the SDK artifact remain unmodified.
export async function install(root: string) {
  if (!root.startsWith("/tmp/dac-im-media-product-") || !["A", "B"].includes(path.basename(root)))
    throw new Error("Private media observation scope required")
  const file = await fs.open(path.join(root, "media-trace-safe.jsonl"), "wx", 0o600)
  const count = { value: 0 }
  const emit = (value: Fact) => {
    if (count.value++ >= 4096) return
    // An observation failure must not change the original native request.
    try { writeSync(file.fd, JSON.stringify(value) + "\n") } catch {}
  }
  await import("../../../src/im/kernel/shims")
  const sdk = (await import("@deepagent-code/im-kernel-sdk")).default
  const init = sdk.init
  const nativeFetch = globalThis.fetch
  const pending = new Set<Promise<void>>()
  sdk.init = ((config: Parameters<typeof init>[0]) => observe(init(config), emit)) as typeof init
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const match = url.origin === "http://127.0.0.1:58642" && url.pathname.match(/^\/navigator\/protected-media\/v1\/(capabilities|objects(?:\/[a-f0-9]{64}(?:\/chunks\/[0-9]+|\/finalize|\/cancel|\/content)?)?)$/)
    const response = await nativeFetch(input, options)
    if (match) {
      const stage = match[1] === "capabilities" ? "capabilities" : url.pathname.endsWith("/objects") ? "begin" : /\/chunks\//.test(url.pathname) ? "chunk" : url.pathname.endsWith("/finalize") ? "finalize" : url.pathname.endsWith("/cancel") ? "cancel" : url.pathname.endsWith("/content") ? "range" : "status"
      const callId = context.getStore()?.callId ?? 0
      emit({ stage, phase: "http", callId, status: response.status, at: Date.now() })
      if (["begin", "chunk", "finalize", "status", "cancel"].includes(stage)) {
        const observation = responseFacts(response, stage === "begin" ? options?.body : undefined).then((facts) => {
          emit({ stage, phase: "http-body", callId, status: response.status, at: Date.now(), ...facts })
        }).catch(() => {}).finally(() => pending.delete(observation))
        pending.add(observation)
      }
    }
    return response
  }, { preconnect: nativeFetch.preconnect })
  return async () => {
    sdk.init = init
    globalThis.fetch = nativeFetch
    await Promise.all(pending)
    await file.close()
  }
}
