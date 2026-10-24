export * as IMEntitlement from "./entitlement"

import { Effect, Option, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ConfigIM } from "@deepagent-code/core/config/im"
import { IMEntitlementSchema } from "@deepagent-code/core/im/entitlement.schema"
import type { IMDeviceStore } from "./device-store"
import { IMDeviceProof } from "./device-proof"
import { IMDeviceTransport } from "./device-transport"

const Envelope = Schema.fromJsonString(
  Schema.Struct({ success: Schema.Boolean, data: Schema.optional(Schema.Unknown) }),
)
const Login = Schema.fromJsonString(
  Schema.Struct({
    profile: Schema.Literal(IMDeviceProof.profile),
    imCredential: Schema.String.check(Schema.isPattern(/^iml2\.[a-f0-9]{64}$/)),
    entitlementID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
    deviceJkt: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
    bindingVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    uuid: Schema.String,
  }),
)
class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("IMEntitlementUnavailable", {
  reason: IMEntitlementSchema.UnknownReason,
}) {}
const unavailable = (reason: typeof IMEntitlementSchema.UnknownReason.Type) => new Unavailable({ reason })

// Reads use the existing binding, including after login has expired or failed.
// No branch provisions a key, logs in, renews a token or creates a transaction.
export function make(input: {
  resolveURL: Effect.Effect<string | null, unknown>
  device?: ReturnType<typeof IMDeviceStore.make>
  http?: HttpClient.HttpClient
  scope: () => object | undefined
  allowLoopback?: boolean
}) {
  const source = input.resolveURL.pipe(
    Effect.mapError(() => unavailable("service_unavailable")),
    Effect.flatMap((url) => {
      if (!url) return Effect.fail(unavailable("service_unconfigured"))
      const realm = ConfigIM.normalizeServiceURL(url, input.allowLoopback)
      return realm ? Effect.succeed(realm) : Effect.fail(unavailable("invalid_response"))
    }),
  )
  const current = (realm: string, scope: object | undefined) =>
    Effect.gen(function* () {
      if (!scope || input.scope() !== scope || (yield* source) !== realm) return yield* unavailable("scope_changed")
    })
  const call = <A>(url: string, decode: (data: unknown) => Option.Option<A>, headers: Record<string, string> = {}) =>
    Effect.gen(function* () {
      if (!input.http) return yield* unavailable("service_unavailable")
      const response = yield* input.http
        .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)))
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
          Effect.mapError(() => unavailable("service_unavailable")),
        )
      if ([404, 405, 501].includes(response.status)) return yield* unavailable("unsupported")
      if (response.status !== 200) return yield* unavailable("service_unavailable")
      const body = yield* response.stream.pipe(
        Stream.runFoldEffect(
          () => ({ bytes: 0, chunks: [] as Uint8Array[] }),
          (state, chunk) =>
            state.bytes + chunk.length > 65536
              ? Effect.fail(unavailable("invalid_response"))
              : Effect.succeed({ bytes: state.bytes + chunk.length, chunks: [...state.chunks, chunk] }),
        ),
        Effect.mapError(() => unavailable("invalid_response")),
      )
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(body.chunks)),
        catch: () => unavailable("invalid_response"),
      })
      const envelope = Schema.decodeUnknownOption(Envelope)(text)
      if (Option.isNone(envelope) || !envelope.value.success) return yield* unavailable("invalid_response")
      const value = decode(envelope.value.data)
      return Option.isSome(value) ? value.value : yield* unavailable("invalid_response")
    }).pipe(
      Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(unavailable("service_unavailable")) }),
    )
  return {
    plans: Effect.gen(function* () {
      const scope = input.scope()
      const realm = yield* source
      yield* current(realm, scope)
      const catalog = yield* call(`${realm}/api/im/plans`, Schema.decodeUnknownOption(IMEntitlementSchema.Plans))
      yield* current(realm, scope)
      return { state: "known" as const, catalog }
    }).pipe(Effect.catch((error) => Effect.succeed({ state: "unknown" as const, reason: error.reason }))),
    entitlement: Effect.gen(function* () {
      const scope = input.scope()
      const realm = yield* source
      yield* current(realm, scope)
      if (!input.device) return yield* unavailable("custody_unavailable")
      const observed = yield* input.device
        .observe(realm, "login")
        .pipe(Effect.mapError(() => unavailable("custody_unavailable")))
      if (!observed) return yield* unavailable("not_bound")
      const decoded = Schema.decodeUnknownOption(Login)(observed.value)
      if (Option.isNone(decoded) || decoded.value.deviceJkt !== observed.deviceJkt)
        return yield* unavailable("custody_unavailable")
      const binding = decoded.value
      const requireCurrent = Effect.gen(function* () {
        yield* current(realm, scope)
        if (!(yield* observed.current.pipe(Effect.mapError(() => unavailable("custody_unavailable")))))
          return yield* unavailable("scope_changed")
      })
      const transport = IMDeviceTransport.make({
        store: observed.signer,
        http: input.http,
        allowLoopback: input.allowLoopback,
      })
      const url = `${realm}/api/im/entitlement`
      const headers = yield* transport
        .headers({
          realm,
          method: "GET",
          url,
          purpose: "entitlement-read",
          transactionID: binding.entitlementID,
          credential: binding.imCredential,
          requestHash: IMDeviceProof.digest([
            "dac.im.entitlement-read.v1",
            realm,
            binding.entitlementID,
            IMDeviceProof.sha256(binding.imCredential),
            binding.deviceJkt,
          ]),
        })
        .pipe(Effect.mapError(() => unavailable("service_unavailable")))
      yield* requireCurrent
      const entitlement = yield* call(url, Schema.decodeUnknownOption(IMEntitlementSchema.Entitlement), {
        ...headers,
        "X-IM-Entitlement-ID": binding.entitlementID,
      })
      yield* requireCurrent
      if (
        entitlement.realm !== realm ||
        entitlement.entitlementID !== binding.entitlementID ||
        entitlement.deviceJkt !== binding.deviceJkt ||
        entitlement.bindingVersion !== binding.bindingVersion ||
        entitlement.uuid !== binding.uuid
      )
        return yield* unavailable("invalid_response")
      return { state: "known" as const, entitlement }
    }).pipe(Effect.catch((error) => Effect.succeed({ state: "unknown" as const, reason: error.reason }))),
  }
}
