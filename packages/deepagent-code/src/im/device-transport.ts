export * as IMDeviceTransport from "./device-transport"

import { Effect, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { IMDeviceStore } from "./device-store"
import { IMDeviceProof } from "./device-proof"

const Envelope = Schema.Struct({
  success: Schema.Boolean,
  code: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
})
const Challenge = Schema.Struct({
  profile: Schema.Literal(IMDeviceProof.profile),
  challengeID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  expiresAt: Schema.Int,
  deviceJkt: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  purpose: Schema.String,
})

export class Error extends Schema.TaggedErrorClass<Error>()("IMDeviceTransportError", {
  code: Schema.String,
  status: Schema.optional(Schema.Number),
  retryAfterMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
}) {}

/** A missing or invalid hint leaves the caller's conservative fallback intact. */
export function retryAfter(hint: string | undefined, now = Date.now()) {
  const value = hint?.trim()
  if (!value) return
  if (/^\d{1,16}$/.test(value)) return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER)
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, date - now)) : undefined
}

type Diagnostic = {
  stage:
    | "headers_identity"
    | "challenge_identity"
    | "challenge_target"
    | "challenge_sign"
    | "challenge_encode"
    | "challenge_transport"
    | "challenge_status"
    | "challenge_decode"
    | "challenge_validate"
    | "request_sign"
  status?: number
  transportReason?: "TransportError" | "EncodeError" | "InvalidUrlError" | "unclassified"
  causeCode?: string
  totalDeadline?: true
}
const diagnostics = new WeakMap<object, Diagnostic & { code: string }>()
const diagnosticCodes = new Set([
  "im_device_store_unavailable",
  "im_device_transport_unavailable",
  "im_device_target_invalid",
  "im_device_proof_invalid",
  "im_device_challenge_unavailable",
  "im_device_response_invalid",
])

/** Metadata never retains the underlying cause, target, proof or credential. */
export function diagnostic(error: unknown) {
  return error !== null && typeof error === "object" ? diagnostics.get(error) : undefined
}

function remember(error: unknown, trace: Diagnostic) {
  if (error === null || typeof error !== "object" || diagnostics.has(error)) return
  const code = "code" in error && typeof error.code === "string" ? error.code : ""
  diagnostics.set(error, { ...trace, code: diagnosticCodes.has(code) ? code : "unclassified" })
}

// Only fixed transport classes/codes cross this boundary; causes can retain URLs and proofs.
function transportDiagnostic(error: { reason: { _tag: string; cause?: unknown } }) {
  const transportReason =
    error.reason._tag === "TransportError" ||
    error.reason._tag === "EncodeError" ||
    error.reason._tag === "InvalidUrlError"
      ? error.reason._tag
      : ("unclassified" as const)
  try {
    const cause = error.reason.cause
    const nested =
      cause !== null && typeof cause === "object" ? Object.getOwnPropertyDescriptor(cause, "cause")?.value : undefined
    const errors =
      cause !== null && typeof cause === "object" ? Object.getOwnPropertyDescriptor(cause, "errors")?.value : undefined
    const causeCode = [
      cause,
      nested,
      ...(Array.isArray(errors)
        ? [0, 1, 2, 3].map((index) => Object.getOwnPropertyDescriptor(errors, String(index))?.value)
        : []),
    ].flatMap((value) => {
      if (value === null || typeof value !== "object") return []
      const code = Object.getOwnPropertyDescriptor(value, "code")?.value
      return typeof code === "string" &&
        [
          "EACCES",
          "EPERM",
          "ERR_ACCESS_DENIED",
          "ERR_NETWORK_ACCESS_DENIED",
          "ABORT_ERR",
          "ENOTFOUND",
          "EAI_AGAIN",
          "ECONNREFUSED",
          "ECONNRESET",
          "ETIMEDOUT",
          "EHOSTUNREACH",
          "ENETUNREACH",
          "UND_ERR_CONNECT_TIMEOUT",
          "UND_ERR_HEADERS_TIMEOUT",
          "UND_ERR_BODY_TIMEOUT",
          "UND_ERR_SOCKET",
          "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
          "ERR_INVALID_ARG_TYPE",
          "ERR_INVALID_ARG_VALUE",
          "ERR_TLS_CERT_ALTNAME_INVALID",
          "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
          "CERT_HAS_EXPIRED",
          "DEPTH_ZERO_SELF_SIGNED_CERT",
          "SELF_SIGNED_CERT_IN_CHAIN",
          "ERR_SSL_WRONG_VERSION_NUMBER",
        ].includes(code)
        ? [code]
        : []
    })[0]
    return { transportReason, ...(causeCode ? { causeCode } : {}) }
  } catch {
    // A foreign cause may be a Proxy; diagnostic inspection must not replace the original failure.
    return { transportReason }
  }
}

export function make(input: {
  store: Pick<ReturnType<typeof IMDeviceStore.make>, "identity" | "bootstrap" | "http">
  http?: HttpClient.HttpClient
  allowLoopback?: boolean
}) {
  const cached = new Map<string, { challenge: typeof Challenge.Type; deviceJkt: string }>()
  const pending = new Map<string, Promise<typeof Challenge.Type>>()
  const challenge = (request: {
    realm: string
    purpose: IMDeviceProof.Purpose
    requestHash: string
    transactionID?: string
  }) => {
    const trace: Diagnostic = { stage: "challenge_identity" }
    return Effect.gen(function* () {
      trace.stage = "challenge_identity"
      trace.status = undefined
      const http = input.http
      if (!http) return yield* new Error({ code: "im_device_transport_unavailable" })
      const key = yield* input.store.identity
      trace.stage = "challenge_target"
      const realm = yield* Effect.try({
        try: () => IMDeviceProof.target(request.realm, input.allowLoopback).replace(/\/$/, ""),
        catch: () => new Error({ code: "im_device_target_invalid" }),
      })
      trace.stage = "challenge_sign"
      const proof = yield* input.store.bootstrap({ ...request, realm, allowLoopback: input.allowLoopback })
      trace.stage = "challenge_encode"
      const wire = yield* HttpClientRequest.bodyJson({
        profile: IMDeviceProof.profile,
        purpose: request.purpose,
        publicJwk: key.publicJwk,
        requestHash: request.requestHash,
        ...(request.transactionID ? { transactionID: request.transactionID } : {}),
      })(
        HttpClientRequest.post(`${realm}/api/im/device/challenges`).pipe(HttpClientRequest.setHeader("DPoP", proof)),
      ).pipe(Effect.mapError(() => new Error({ code: "im_device_proof_invalid" })))
      trace.stage = "challenge_transport"
      const response = yield* http.execute(wire).pipe(
        Effect.mapError((error) => {
          Object.assign(trace, transportDiagnostic(error))
          return new Error({ code: "im_device_challenge_unavailable" })
        }),
      )
      trace.stage = "challenge_status"
      trace.status = response.status
      if (response.status !== 200)
        return yield* new Error({
          code: "im_device_challenge_unavailable",
          ...(response.status === 429
            ? { status: 429, retryAfterMs: retryAfter(response.headers["retry-after"]) }
            : {}),
        })
      trace.stage = "challenge_decode"
      const body = yield* HttpClientResponse.schemaBodyJson(Envelope)(response).pipe(
        Effect.mapError(() => new Error({ code: "im_device_response_invalid" })),
      )
      trace.stage = "challenge_validate"
      const result = body.success ? Schema.decodeUnknownOption(Challenge)(body.data) : Option.none()
      const now = Date.now()
      if (
        Option.isNone(result) ||
        result.value.deviceJkt !== key.jkt ||
        result.value.purpose !== request.purpose ||
        result.value.expiresAt <= now ||
        result.value.expiresAt > now + 60000 + IMDeviceProof.maxServerClockLeadMs
      )
        return yield* new Error({ code: "im_device_response_invalid" })
      return result.value
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => {
          trace.totalDeadline = true
          return Effect.fail(new Error({ code: "im_device_challenge_unavailable" }))
        },
      }),
      Effect.tapError((error) => Effect.sync(() => remember(error, trace))),
    )
  }
  return {
    headers: (request: {
      realm: string
      method: "GET" | "POST" | "PUT" | "DELETE"
      url: string
      purpose: IMDeviceProof.Purpose
      requestHash: string
      transactionID?: string
      credential?: string
      kernelRealm?: string
    }) => {
      const trace: Diagnostic = { stage: "headers_identity" }
      return Effect.gen(function* () {
        trace.stage = "headers_identity"
        const key = yield* input.store.identity
        const cacheKey = IMDeviceProof.digest([request.realm, request.kernelRealm ?? "", request.requestHash, key.jkt])
        const previous = request.purpose === "kernel-http" ? cached.get(cacheKey) : undefined
        trace.stage = "challenge_transport"
        const selected =
          // Retire the cache before the earliest server expiry under supported skew.
          previous &&
          previous.deviceJkt === key.jkt &&
          previous.challenge.expiresAt > Date.now() + IMDeviceProof.maxServerClockLeadMs + 1000
            ? previous.challenge
            : yield* Effect.tryPromise({
                try: async () => {
                  if (request.purpose !== "kernel-http") return Effect.runPromise(challenge(request))
                  const shared = pending.get(cacheKey)
                  if (shared) return shared
                  const work = Effect.runPromise(challenge(request))
                  pending.set(cacheKey, work)
                  try {
                    const result = await work
                    if (cached.size >= 4) cached.clear()
                    cached.set(cacheKey, { challenge: result, deviceJkt: key.jkt })
                    return result
                  } finally {
                    pending.delete(cacheKey)
                  }
                },
                catch: (error) => {
                  const failure =
                    error instanceof Error ? error : new Error({ code: "im_device_challenge_unavailable" })
                  const detail = diagnostic(error)
                  if (detail) diagnostics.set(failure, detail)
                  return failure
                },
              })
        trace.stage = "request_sign"
        const proof = yield* input.store.http({
          method: request.method,
          url: request.url,
          nonce: selected.nonce,
          credential: request.credential,
          allowLoopback: input.allowLoopback,
        })
        return {
          DPoP: proof,
          "X-IM-Challenge-ID": selected.challengeID,
          ...(request.credential
            ? { authorization: `${request.purpose.endsWith("-status") ? "IM-Receipt" : "DPoP"} ${request.credential}` }
            : {}),
        }
      }).pipe(Effect.tapError((error) => Effect.sync(() => remember(error, trace))))
    },
  }
}
