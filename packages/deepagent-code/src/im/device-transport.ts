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

export class Error extends Schema.TaggedErrorClass<Error>()("IMDeviceTransportError", { code: Schema.String }) {}

export function make(input: {
  store: ReturnType<typeof IMDeviceStore.make>
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
  }) =>
    Effect.gen(function* () {
      const http = input.http
      if (!http) return yield* new Error({ code: "im_device_transport_unavailable" })
      const key = yield* input.store.identity
      const realm = yield* Effect.try({
        try: () => IMDeviceProof.target(request.realm, input.allowLoopback).replace(/\/$/, ""),
        catch: () => new Error({ code: "im_device_target_invalid" }),
      })
      const proof = yield* input.store.bootstrap({ ...request, realm, allowLoopback: input.allowLoopback })
      const wire = yield* HttpClientRequest.bodyJson({
        profile: IMDeviceProof.profile,
        purpose: request.purpose,
        publicJwk: key.publicJwk,
        requestHash: request.requestHash,
        ...(request.transactionID ? { transactionID: request.transactionID } : {}),
      })(
        HttpClientRequest.post(`${realm}/api/im/device/challenges`).pipe(HttpClientRequest.setHeader("DPoP", proof)),
      ).pipe(Effect.mapError(() => new Error({ code: "im_device_proof_invalid" })))
      const response = yield* http
        .execute(wire)
        .pipe(Effect.mapError(() => new Error({ code: "im_device_challenge_unavailable" })))
      if (response.status !== 200) return yield* new Error({ code: "im_device_challenge_unavailable" })
      const body = yield* HttpClientResponse.schemaBodyJson(Envelope)(response).pipe(
        Effect.mapError(() => new Error({ code: "im_device_response_invalid" })),
      )
      const result = body.success ? Schema.decodeUnknownOption(Challenge)(body.data) : Option.none()
      if (
        Option.isNone(result) ||
        result.value.deviceJkt !== key.jkt ||
        result.value.purpose !== request.purpose ||
        result.value.expiresAt <= Date.now() ||
        result.value.expiresAt > Date.now() + 60000
      )
        return yield* new Error({ code: "im_device_response_invalid" })
      return result.value
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error({ code: "im_device_challenge_unavailable" })),
      }),
    )
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
    }) =>
      Effect.gen(function* () {
        const key = yield* input.store.identity
        const cacheKey = IMDeviceProof.digest([request.realm, request.kernelRealm ?? "", request.requestHash, key.jkt])
        const previous = request.purpose === "kernel-http" ? cached.get(cacheKey) : undefined
        const selected =
          previous && previous.deviceJkt === key.jkt && previous.challenge.expiresAt > Date.now() + 1000
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
                catch: (error) =>
                  error instanceof Error ? error : new Error({ code: "im_device_challenge_unavailable" }),
              })
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
      }),
  }
}
