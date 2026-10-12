export * as IMActivation from "./activation"

import { createHash, randomBytes } from "node:crypto"
import { and, eq, inArray, or } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { IMActivationSchema } from "@deepagent-code/core/im/activation.schema"
import { IMActivationTable } from "@deepagent-code/core/im/activation.sql"
import { validateIMName } from "@deepagent-code/core/im/facade-contract"
import { Auth } from "@/auth"
import { Flag } from "@deepagent-code/core/flag/flag"
import { KernelConfig } from "./kernel/config"

const WireResult = Schema.Struct({
  transactionID: IMActivationSchema.Transaction.fields.transactionID,
  state: Schema.Literals(["succeeded", "rejected"]),
  method: IMActivationSchema.Submit.fields.method,
  chargedCredits: Schema.Literals([0, 1]),
  imCredential: Schema.optional(Schema.String.check(Schema.isPattern(/^iml1\.[a-f0-9]{64}$/))),
  entitlementExpiresAt: IMActivationSchema.Quote.fields.entitlementExpiresAt,
  rejectionCode: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
})
const Envelope = Schema.Struct({ success: Schema.Boolean, code: Schema.optional(Schema.String), data: Schema.optional(Schema.Unknown) })
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const failure = (code: string) => new IMActivationSchema.Error({ code })
const view = (row: typeof IMActivationTable.$inferSelect): IMActivationSchema.Transaction => ({
  transactionID: row.transaction_id, name: row.name, method: row.method, quoteID: row.quote_id,
  state: row.state, chargedCredits: row.charged_credits, credentialStored: row.credential_stored,
  ...(row.code ? { code: row.code } : {}),
})

// The ordinary credential store holds only recovery secrets and the dedicated IM
// login credential. A payer key is never discovered, retained, or used at boot.
export const make = Effect.fn("IMActivation.make")(function* (input: {
  db: Database.Interface["db"]
  auth: Auth.Interface
  http?: HttpClient.HttpClient
  facadeURL?: string
}) {
  const lock = yield* Semaphore.make(1)
  const source = Effect.try({ try: () => {
    const url = new URL(input.facadeURL ?? "")
    if (url.username || url.password || url.search || url.hash ||
      url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error()
    return { url: url.href.replace(/\/+$/, ""), hash: hash(url.href.replace(/\/+$/, "")) }
  }, catch: () => failure("im_activation_unavailable") })
  const call = <A>(request: HttpClientRequest.HttpClientRequest, decode: (data: unknown) => Option.Option<A>) =>
    Effect.gen(function* () {
      if (!input.http) return yield* failure("im_activation_unavailable")
      const response = yield* input.http.execute(request).pipe(Effect.mapError(() => failure("im_activation_unknown")))
      if (response.status >= 300 && response.status < 400) return yield* failure("im_activation_unknown")
      const body = yield* HttpClientResponse.schemaBodyJson(Envelope)(response).pipe(Effect.mapError(() => failure("im_activation_unknown")))
      if (!body.success || response.status >= 400) return yield* failure([
        "im_activation_invalid", "im_activation_quote_expired", "im_activation_source_unavailable", "im_identity_conflict",
        "im_activation_conflict", "im_activation_pending", "im_activation_receipt_denied", "im_activation_required",
      ].includes(body.code ?? "") ? body.code! : "im_activation_unknown")
      const result = decode(body.data)
      if (Option.isNone(result)) return yield* failure("im_activation_unknown")
      return result.value
    }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
      Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(failure("im_activation_unknown")) }))
  const row = (sourceHash: string, id: string) => input.db.select().from(IMActivationTable)
    .where(and(eq(IMActivationTable.source_hash, sourceHash), eq(IMActivationTable.transaction_id, id))).get()
    .pipe(Effect.mapError(() => failure("im_activation_storage_unavailable")))
  const pending = Effect.gen(function* () {
    const current = yield* source
    const value = yield* input.db.select().from(IMActivationTable)
      .where(and(eq(IMActivationTable.source_hash, current.hash), or(inArray(IMActivationTable.state, ["pending", "unknown"]),
        and(eq(IMActivationTable.state, "succeeded"), eq(IMActivationTable.credential_stored, false))))).get()
      .pipe(Effect.mapError(() => failure("im_activation_storage_unavailable")))
    return { transaction: value ? view(value) : null }
  })
  const finish = (current: { url: string; hash: string }, original: typeof IMActivationTable.$inferSelect, result: typeof WireResult.Type) =>
    Effect.gen(function* () {
      if (result.transactionID !== original.transaction_id || result.method !== original.method ||
        original.method === "activation_code" && result.chargedCredits !== 0 ||
        result.state === "rejected" && result.chargedCredits !== 0) return yield* failure("im_activation_unknown")
      // The payment receipt is authoritative even when writing the independent
      // login store fails. Paid-without-login remains recoverable and blocks POST.
      yield* input.db.update(IMActivationTable).set({ state: result.state, charged_credits: result.chargedCredits,
        credential_stored: false, code: result.rejectionCode ?? null, updated_at: Date.now() })
        .where(and(eq(IMActivationTable.transaction_id, original.transaction_id), eq(IMActivationTable.source_hash, current.hash))).run()
        .pipe(Effect.mapError(() => failure("im_activation_storage_unavailable")))
      if (result.state === "succeeded" && result.imCredential) {
        const saved = yield* input.auth.set("im-facade", new Auth.Api({ type: "api", key: result.imCredential,
          metadata: { imSource: current.hash } })).pipe(Effect.result)
        yield* input.db.update(IMActivationTable).set({ credential_stored: saved._tag === "Success",
          ...(saved._tag === "Failure" ? { code: "im_activation_credentials_unavailable" } : {}), updated_at: Date.now() })
          .where(eq(IMActivationTable.transaction_id, original.transaction_id)).run()
          .pipe(Effect.mapError(() => failure("im_activation_storage_unavailable")))
      }
      // Durable completion precedes removing the recovery secret. A failed cleanup
      // leaves a harmless receipt; it never causes a second purchase.
      const completed = (yield* row(current.hash, original.transaction_id))!
      if (result.state === "rejected" || completed.credential_stored) yield* input.auth.remove(`im-activation-${original.transaction_id}`).pipe(Effect.ignore)
      return view(completed)
    })
  const status = (id: string) => lock.withPermits(1)(Effect.gen(function* () {
    const current = yield* source
    const original = yield* row(current.hash, id)
    if (!original) return yield* failure("im_activation_not_found")
    if (original.state === "rejected" || original.state === "succeeded" && original.credential_stored) return view(original)
    const secret = yield* input.auth.get(`im-activation-${id}`).pipe(Effect.mapError(() => failure("im_activation_credentials_unavailable")))
    if (!secret || secret.type !== "api" || secret.metadata?.imSource !== current.hash) return yield* failure("im_activation_credentials_unavailable")
    const result = yield* call(HttpClientRequest.get(`${current.url}/api/im/activation/${encodeURIComponent(id)}`).pipe(
      HttpClientRequest.setHeaders({ authorization: `IM-Receipt ${secret.key}` })), Schema.decodeUnknownOption(WireResult)).pipe(Effect.result)
    if (result._tag === "Failure") return view(original)
    return yield* finish(current, original, result.success)
  }))
  return {
    quote: Effect.gen(function* () {
      const current = yield* source
      return yield* call(HttpClientRequest.get(`${current.url}/api/im/activation/quote`), Schema.decodeUnknownOption(IMActivationSchema.Quote))
    }),
    pending,
    status,
    activate: (request: IMActivationSchema.Submit) => lock.withPermits(1)(Effect.gen(function* () {
      if (Flag.DEEPAGENT_SERVER_MODE) return yield* failure("im_activation_local_required")
      const current = yield* source
      const name = validateIMName(request.name)
      if (!name.ok || name.name !== request.name) return yield* failure("im_activation_invalid")
      const requestHash = hash([request.name, request.method, request.quoteID, hash(request.credential)])
      const existing = yield* row(current.hash, request.transactionID)
      if (existing) {
        if (existing.request_hash !== requestHash) return yield* failure("im_activation_conflict")
        return view(existing)
      }
      if ((yield* pending).transaction) return yield* failure("im_activation_pending")
      const receiptSecret = randomBytes(32).toString("base64url")
      // Persist recovery authority BEFORE any request can consume credit. The raw
      // payment key is used once, only by this explicitly requested POST.
      yield* input.auth.set(`im-activation-${request.transactionID}`, new Auth.Api({ type: "api", key: receiptSecret,
        metadata: { imSource: current.hash } })).pipe(Effect.mapError(() => failure("im_activation_credentials_unavailable")))
      yield* input.db.insert(IMActivationTable).values({ transaction_id: request.transactionID, source_hash: current.hash,
        request_hash: requestHash, name: request.name, method: request.method, quote_id: request.quoteID, state: "unknown",
        charged_credits: null, credential_stored: false, created_at: Date.now(), updated_at: Date.now() }).run()
        .pipe(Effect.mapError(() => failure("im_activation_storage_unavailable")))
      const original = (yield* row(current.hash, request.transactionID))!
      const requestBody = yield* HttpClientRequest.bodyJson({ ...request, receiptSecret })(HttpClientRequest.post(`${current.url}/api/im/activation`))
        .pipe(Effect.mapError(() => failure("im_activation_invalid")))
      const result = yield* call(requestBody, Schema.decodeUnknownOption(WireResult)).pipe(Effect.result)
      if (result._tag === "Failure") {
        if (["im_activation_invalid", "im_activation_quote_expired", "im_activation_source_unavailable", "im_identity_conflict"].includes(result.failure.code))
          return yield* finish(current, original, { transactionID: request.transactionID, method: request.method, state: "rejected",
            chargedCredits: 0, entitlementExpiresAt: null, rejectionCode: result.failure.code })
        return view(original)
      }
      return yield* finish(current, original, result.success)
    })),
  }
})

export class Service extends Context.Service<Service, Effect.Success<ReturnType<typeof make>>>()("@deepagent-code/im/Activation") {}
export const layer = (env: Readonly<Record<string, string | undefined>> = process.env) => Layer.effect(Service, Effect.gen(function* () {
  return yield* make({ db: (yield* Database.Service).db, auth: yield* Auth.Service,
    http: Option.getOrUndefined(yield* Effect.serviceOption(HttpClient.HttpClient)), facadeURL: env[KernelConfig.facadeEnvKeys.url] })
}))
