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
import { IMDeviceStore } from "./device-store"
import { IMDeviceProof } from "./device-proof"
import { IMDeviceTransport } from "./device-transport"
import { IMDeviceSchema } from "@deepagent-code/core/im/device.schema"

const WireResult = Schema.Struct({
  transactionID: IMActivationSchema.Transaction.fields.transactionID,
  state: Schema.Literals(["succeeded", "rejected"]),
  method: IMActivationSchema.Submit.fields.method,
  chargedCredits: Schema.Literals([0, 1]),
  imCredential: Schema.optional(Schema.String.check(Schema.isPattern(/^iml1\.[a-f0-9]{64}$/))),
  entitlementExpiresAt: IMActivationSchema.Quote.fields.entitlementExpiresAt,
  rejectionCode: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
})
const Envelope = Schema.Struct({
  success: Schema.Boolean,
  code: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
})
const BoundResult = Schema.Union([
  Schema.Struct({
    profile: Schema.Literal(IMDeviceProof.profile),
    transactionID: IMActivationSchema.Transaction.fields.transactionID,
    state: Schema.Literal("succeeded"),
    method: IMActivationSchema.Submit.fields.method,
    chargedCredits: Schema.Literals([0, 1]),
    entitlementExpiresAt: Schema.NullOr(Schema.Number),
    entitlementID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
    deviceJkt: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
    bindingVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    imCredential: Schema.String.check(Schema.isPattern(/^iml2\.[a-f0-9]{64}$/)),
    identity: Schema.Struct({
      uuid: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
      name: Schema.String,
      org_id: Schema.Int,
      org_all_group_id: Schema.String,
    }),
  }),
  Schema.Struct({
    profile: Schema.Literal(IMDeviceProof.profile),
    transactionID: IMActivationSchema.Transaction.fields.transactionID,
    state: Schema.Literals(["pending", "rejected"]),
    method: IMActivationSchema.Submit.fields.method,
    chargedCredits: Schema.Literals([0, 1]),
    entitlementExpiresAt: Schema.NullOr(Schema.Number),
    rejectionCode: Schema.optional(Schema.String),
  }),
])
const MigrationResult = Schema.Union([
  Schema.Struct({
    profile: Schema.Literal(IMDeviceProof.profile),
    migrationID: IMDeviceSchema.Migrate.fields.migrationID,
    state: Schema.Literal("succeeded"),
    chargedCredits: Schema.Literal(0),
    entitlementID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
    uuid: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
    deviceJkt: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
    bindingVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    imCredential: Schema.String.check(Schema.isPattern(/^iml2\.[a-f0-9]{64}$/)),
  }),
  Schema.Struct({
    profile: Schema.Literal(IMDeviceProof.profile),
    migrationID: IMDeviceSchema.Migrate.fields.migrationID,
    state: Schema.Literals(["pending", "rejected"]),
    chargedCredits: Schema.Literal(0),
    rejectionCode: Schema.optional(Schema.String),
  }),
])
const MigrationRecovery = Schema.Struct({
  ...IMDeviceSchema.Migration.fields,
  receiptSecret: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  requestHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  deviceJkt: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
})
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const failure = (code: string) => new IMActivationSchema.Error({ code })
const view = (row: typeof IMActivationTable.$inferSelect): IMActivationSchema.Transaction => ({
  transactionID: row.transaction_id,
  name: row.name,
  method: row.method,
  quoteID: row.quote_id,
  state: row.state,
  chargedCredits: row.charged_credits,
  credentialStored: row.credential_stored,
  ...(row.code ? { code: row.code } : {}),
})

// Production keeps only recovery secrets and the dedicated IM login in native
// custody. A payer key is never discovered, retained, or used at boot.
export const make = Effect.fn("IMActivation.make")(function* (input: {
  db: Database.Interface["db"]
  auth: Auth.Interface
  http?: HttpClient.HttpClient
  facadeURL?: string
  device?: ReturnType<typeof IMDeviceStore.make>
  allowLoopback?: boolean
}) {
  const lock = yield* Semaphore.make(1)
  const device = input.device
  const transport = device
    ? IMDeviceTransport.make({ store: device, http: input.http, allowLoopback: input.allowLoopback })
    : undefined
  const resultSchema: (value: unknown) => Option.Option<typeof WireResult.Type | typeof BoundResult.Type> = device
    ? Schema.decodeUnknownOption(BoundResult)
    : Schema.decodeUnknownOption(WireResult)
  const source = Effect.try({
    try: () => {
      const url = new URL(input.facadeURL ?? "")
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            (!device || input.allowLoopback) &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          ))
      )
        throw new Error()
      return { url: url.href.replace(/\/+$/, ""), hash: hash(url.href.replace(/\/+$/, "")) }
    },
    catch: () => failure("im_activation_unavailable"),
  })
  const call = <A>(request: HttpClientRequest.HttpClientRequest, decode: (data: unknown) => Option.Option<A>) =>
    Effect.gen(function* () {
      if (!input.http) return yield* failure("im_activation_unavailable")
      const response = yield* input.http.execute(request).pipe(Effect.mapError(() => failure("im_activation_unknown")))
      if (response.status >= 300 && response.status < 400) return yield* failure("im_activation_unknown")
      const body = yield* HttpClientResponse.schemaBodyJson(Envelope)(response).pipe(
        Effect.mapError(() => failure("im_activation_unknown")),
      )
      if (!body.success || response.status >= 400)
        return yield* failure(
          [
            "im_activation_invalid",
            "im_activation_quote_expired",
            "im_activation_source_unavailable",
            "im_identity_conflict",
            "im_activation_conflict",
            "im_activation_pending",
            "im_activation_receipt_denied",
            "im_activation_required",
            "im_device_proof_invalid",
            "im_device_upgrade_required",
            "im_activation_source_already_used",
          ].includes(body.code ?? "")
            ? body.code!
            : "im_activation_unknown",
        )
      if (device && body.data && typeof body.data === "object" && "state" in body.data) {
        if (
          (body.data.state !== "succeeded" && "imCredential" in body.data) ||
          (body.data.state === "rejected" &&
            (!("rejectionCode" in body.data) ||
              typeof body.data.rejectionCode !== "string" ||
              !body.data.rejectionCode))
        )
          return yield* failure("im_activation_unknown")
      }
      const result = decode(body.data)
      if (Option.isNone(result)) return yield* failure("im_activation_unknown")
      return result.value
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
      Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(failure("im_activation_unknown")) }),
    )
  const row = (sourceHash: string, id: string) =>
    input.db
      .select()
      .from(IMActivationTable)
      .where(and(eq(IMActivationTable.source_hash, sourceHash), eq(IMActivationTable.transaction_id, id)))
      .get()
      .pipe(Effect.mapError(() => failure("im_activation_storage_unavailable")))
  const pending = Effect.gen(function* () {
    const current = yield* source
    const value = yield* input.db
      .select()
      .from(IMActivationTable)
      .where(
        and(
          eq(IMActivationTable.source_hash, current.hash),
          or(
            inArray(IMActivationTable.state, ["pending", "unknown"]),
            and(eq(IMActivationTable.state, "succeeded"), eq(IMActivationTable.credential_stored, false)),
            and(eq(IMActivationTable.state, "rejected"), eq(IMActivationTable.charged_credits, 1)),
          ),
        ),
      )
      .get()
      .pipe(Effect.mapError(() => failure("im_activation_storage_unavailable")))
    return { transaction: value ? view(value) : null }
  })
  const finish = (
    current: { url: string; hash: string },
    original: typeof IMActivationTable.$inferSelect,
    result: typeof WireResult.Type | typeof BoundResult.Type,
  ) =>
    Effect.gen(function* () {
      if (
        result.transactionID !== original.transaction_id ||
        result.method !== original.method ||
        (original.charged_credits === 1 && result.chargedCredits !== 1) ||
        (original.method === "activation_code" && result.chargedCredits !== 0) ||
        (!device && result.state === "rejected" && result.chargedCredits !== 0)
      )
        return yield* failure("im_activation_unknown")
      if (device && result.state === "succeeded") {
        const key = yield* device.identity.pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
        if (!("deviceJkt" in result) || result.deviceJkt !== key.jkt) return yield* failure("im_activation_unknown")
      }
      // The payment receipt is authoritative even when writing the independent
      // login store fails. Paid-without-login remains recoverable and blocks POST.
      yield* input.db
        .update(IMActivationTable)
        .set({
          state: result.state,
          charged_credits: result.chargedCredits,
          credential_stored: false,
          code:
            "rejectionCode" in result
              ? (result.rejectionCode ?? null)
              : result.state === "pending"
                ? "im_activation_pending"
                : null,
          updated_at: Date.now(),
        })
        .where(
          and(
            eq(IMActivationTable.transaction_id, original.transaction_id),
            eq(IMActivationTable.source_hash, current.hash),
          ),
        )
        .run()
        .pipe(Effect.mapError(() => failure("im_activation_storage_unavailable")))
      if (result.state === "succeeded" && "imCredential" in result && result.imCredential) {
        const saved = yield* device && "deviceJkt" in result
          ? device
              .put(
                current.url,
                "login",
                JSON.stringify({
                  profile: result.profile,
                  imCredential: result.imCredential,
                  entitlementID: result.entitlementID,
                  deviceJkt: result.deviceJkt,
                  bindingVersion: result.bindingVersion,
                  uuid: result.identity.uuid,
                }),
              )
              .pipe(Effect.result)
          : input.auth
              .set(
                "im-facade",
                new Auth.Api({ type: "api", key: result.imCredential, metadata: { imSource: current.hash } }),
              )
              .pipe(Effect.result)
        yield* input.db
          .update(IMActivationTable)
          .set({
            credential_stored: saved._tag === "Success",
            ...(saved._tag === "Failure" ? { code: "im_activation_credentials_unavailable" } : {}),
            updated_at: Date.now(),
          })
          .where(eq(IMActivationTable.transaction_id, original.transaction_id))
          .run()
          .pipe(Effect.mapError(() => failure("im_activation_storage_unavailable")))
      }
      // Durable completion precedes removing the recovery secret. A failed cleanup
      // leaves a harmless receipt; it never causes a second purchase.
      const completed = (yield* row(current.hash, original.transaction_id))!
      if ((result.state === "rejected" && result.chargedCredits === 0) || completed.credential_stored)
        yield* (
          device
            ? device
                .remove(current.url, `activation-${original.transaction_id}`)
                .pipe(Effect.andThen(device.remove(current.url, `activation-context-${original.transaction_id}`)))
            : input.auth.remove(`im-activation-${original.transaction_id}`)
        ).pipe(Effect.ignore)
      return view(completed)
    })
  const status = (id: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* source
        const original = yield* row(current.hash, id)
        if (!original) return yield* failure("im_activation_not_found")
        if (
          (original.state === "rejected" && original.charged_credits === 0) ||
          (original.state === "succeeded" && original.credential_stored)
        )
          return view(original)
        const stored = device
          ? yield* device
              .get(current.url, `activation-${id}`)
              .pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
          : undefined
        const secret = device
          ? stored
            ? new Auth.Api({ type: "api", key: stored, metadata: { imSource: current.hash } })
            : undefined
          : yield* input.auth
              .get(`im-activation-${id}`)
              .pipe(Effect.mapError(() => failure("im_activation_credentials_unavailable")))
        if (!secret || secret.type !== "api" || secret.metadata?.imSource !== current.hash)
          return yield* failure("im_activation_credentials_unavailable")
        const url = `${current.url}/api/im/activation/${encodeURIComponent(id)}`
        const key = device
          ? yield* device.identity.pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
          : undefined
        const headers =
          transport && key
            ? yield* transport
                .headers({
                  realm: current.url,
                  method: "GET",
                  url,
                  purpose: "activation-status",
                  transactionID: id,
                  credential: secret.key,
                  requestHash: IMDeviceProof.digest([
                    "dac.im.activation-status.v2",
                    current.url,
                    id,
                    IMDeviceProof.sha256(secret.key),
                    key.jkt,
                  ]),
                })
                .pipe(Effect.mapError(() => failure("im_activation_unknown")))
            : { authorization: `IM-Receipt ${secret.key}` }
        const result = yield* call(
          HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)),
          resultSchema,
        ).pipe(Effect.result)
        if (result._tag === "Failure") return view(original)
        return yield* finish(current, original, result.success)
      }),
    )
  const migrationRecord = Effect.gen(function* () {
    const current = yield* source
    if (!device) return null
    const value = yield* device
      .get(current.url, "migration")
      .pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
    if (!value) return null
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(MigrationRecovery))(value)
    if (Option.isNone(decoded)) return yield* failure("im_device_store_unavailable")
    return decoded.value
  })
  const migrationView = (record: typeof MigrationRecovery.Type): IMDeviceSchema.Migration => ({
    migrationID: record.migrationID,
    state: record.state,
    chargedCredits: 0,
    credentialStored: record.credentialStored,
    ...(record.code ? { code: record.code } : {}),
    ...(record.entitlementID ? { entitlementID: record.entitlementID } : {}),
    ...(record.uuid ? { uuid: record.uuid } : {}),
  })
  const unfinishedMigration = (record: typeof MigrationRecovery.Type | null) =>
    record !== null &&
    (record.state === "pending" ||
      record.state === "unknown" ||
      (record.state === "succeeded" && !record.credentialStored))
  const finishMigration = (
    realm: string,
    original: typeof MigrationRecovery.Type,
    result: typeof MigrationResult.Type,
  ) =>
    Effect.gen(function* () {
      if (!device || result.migrationID !== original.migrationID) return yield* failure("im_migration_unknown")
      if (result.state === "succeeded" && result.deviceJkt !== original.deviceJkt)
        return yield* failure("im_migration_unknown")
      const next: typeof MigrationRecovery.Type = {
        ...original,
        state: result.state,
        credentialStored: false,
        code:
          result.state === "pending"
            ? "im_migration_pending"
            : "rejectionCode" in result
              ? result.rejectionCode
              : undefined,
        ...(result.state === "succeeded" ? { entitlementID: result.entitlementID, uuid: result.uuid } : {}),
      }
      yield* device
        .put(realm, "migration", JSON.stringify(next))
        .pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
      if (result.state !== "succeeded") return migrationView(next)
      const saved = yield* device
        .put(
          realm,
          "login",
          JSON.stringify({
            profile: result.profile,
            imCredential: result.imCredential,
            entitlementID: result.entitlementID,
            deviceJkt: result.deviceJkt,
            bindingVersion: result.bindingVersion,
            uuid: result.uuid,
          }),
        )
        .pipe(Effect.result)
      const completed = {
        ...next,
        credentialStored: saved._tag === "Success",
        code: saved._tag === "Failure" ? "paid_login_storage_pending" : undefined,
      }
      yield* device
        .put(realm, "migration", JSON.stringify(completed))
        .pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
      return migrationView(completed)
    })
  const migrationStatus = (id: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (!device || !transport) return yield* failure("im_device_store_unavailable")
        const current = yield* source
        const original = yield* migrationRecord
        if (!original || original.migrationID !== id) return yield* failure("im_migration_not_found")
        if (!unfinishedMigration(original)) return migrationView(original)
        const key = yield* device.identity.pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
        if (key.jkt !== original.deviceJkt) return yield* failure("im_device_proof_invalid")
        const url = `${current.url}/api/im/device/migrations/${encodeURIComponent(id)}`
        const headers = yield* transport
          .headers({
            realm: current.url,
            method: "GET",
            url,
            purpose: "migration-status",
            transactionID: id,
            credential: original.receiptSecret,
            requestHash: IMDeviceProof.digest([
              "dac.im.migration-status.v1",
              current.url,
              id,
              IMDeviceProof.sha256(original.receiptSecret),
              key.jkt,
            ]),
          })
          .pipe(Effect.mapError(() => failure("im_migration_unknown")))
        const result = yield* call(
          HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)),
          Schema.decodeUnknownOption(MigrationResult),
        ).pipe(Effect.result)
        if (result._tag === "Failure") return migrationView(original)
        return yield* finishMigration(current.url, original, result.success)
      }),
    )
  return {
    quote: Effect.gen(function* () {
      const current = yield* source
      return yield* call(
        HttpClientRequest.get(`${current.url}/api/im/activation/quote`),
        Schema.decodeUnknownOption(IMActivationSchema.Quote),
      )
    }),
    pending,
    status,
    deviceInfo: Effect.gen(function* () {
      if (!device) return yield* failure("im_device_store_unavailable")
      return {
        ...(yield* device.preflight.pipe(Effect.mapError(() => failure("im_device_store_unavailable")))),
        storeAvailable: true as const,
      }
    }),
    migrationPending: migrationRecord.pipe(
      Effect.map((record) => ({ migration: record && unfinishedMigration(record) ? migrationView(record) : null })),
    ),
    migrationStatus,
    migrate: (request: IMDeviceSchema.Migrate) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (Flag.DEEPAGENT_SERVER_MODE) return yield* failure("im_activation_local_required")
          if (!device || !transport) return yield* failure("im_device_store_unavailable")
          const current = yield* source
          yield* device.preflight.pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
          if ((yield* pending).transaction) return yield* failure("im_activation_pending")
          const previous = yield* migrationRecord
          const key = yield* device.identity.pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
          if (previous?.migrationID === request.migrationID) {
            if (
              previous.deviceJkt !== key.jkt ||
              previous.requestHash !==
                IMDeviceProof.digest([
                  "dac.im.migrate.v1",
                  current.url,
                  request.migrationID,
                  IMDeviceProof.sha256(request.voucher),
                  IMDeviceProof.sha256(previous.receiptSecret),
                  key.jkt,
                ])
            )
              return yield* failure("im_migration_conflict")
            if (!request.retryOriginal || previous.state !== "unknown") return migrationView(previous)
          }
          if (request.retryOriginal && previous?.migrationID !== request.migrationID)
            return yield* failure("im_migration_conflict")
          if (!request.retryOriginal && unfinishedMigration(previous))
            return yield* failure("im_device_migration_pending")
          if (
            !request.retryOriginal &&
            (yield* device
              .get(current.url, "login")
              .pipe(Effect.mapError(() => failure("im_device_store_unavailable"))))
          )
            return yield* failure("im_device_binding_exists")
          const receiptSecret =
            previous?.migrationID === request.migrationID
              ? previous.receiptSecret
              : randomBytes(32).toString("base64url")
          const requestHash = IMDeviceProof.digest([
            "dac.im.migrate.v1",
            current.url,
            request.migrationID,
            IMDeviceProof.sha256(request.voucher),
            IMDeviceProof.sha256(receiptSecret),
            key.jkt,
          ])
          const url = `${current.url}/api/im/device/migrate`
          const headers = yield* transport
            .headers({
              realm: current.url,
              method: "POST",
              url,
              purpose: "migration-bind",
              transactionID: request.migrationID,
              credential: request.voucher,
              requestHash,
            })
            .pipe(Effect.mapError(() => failure("im_device_challenge_unavailable")))
          const wire = yield* HttpClientRequest.bodyJson({
            ...request,
            profile: IMDeviceProof.profile,
            receiptSecret,
            publicJwk: key.publicJwk,
            challengeID: headers["X-IM-Challenge-ID"],
          })(HttpClientRequest.post(url).pipe(HttpClientRequest.setHeaders(headers))).pipe(
            Effect.mapError(() => failure("im_activation_invalid")),
          )
          const original: typeof MigrationRecovery.Type = {
            migrationID: request.migrationID,
            requestHash,
            receiptSecret,
            deviceJkt: key.jkt,
            state: "unknown",
            chargedCredits: 0,
            credentialStored: false,
          }
          if (!request.retryOriginal)
            yield* device
              .put(current.url, "migration", JSON.stringify(original))
              .pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
          const result = yield* call(wire, Schema.decodeUnknownOption(MigrationResult)).pipe(Effect.result)
          if (result._tag === "Failure") {
            if (request.retryOriginal) return migrationView(previous!)
            if (
              ["im_device_proof_invalid", "im_device_upgrade_required", "im_activation_invalid"].includes(
                result.failure.code,
              )
            )
              return yield* finishMigration(current.url, original, {
                profile: IMDeviceProof.profile,
                migrationID: request.migrationID,
                state: "rejected",
                chargedCredits: 0,
                rejectionCode: result.failure.code,
              })
            return migrationView(original)
          }
          return yield* finishMigration(current.url, original, result.success)
        }),
      ),
    activate: (request: IMActivationSchema.Submit) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (Flag.DEEPAGENT_SERVER_MODE) return yield* failure("im_activation_local_required")
          const current = yield* source
          if (device) yield* device.preflight.pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
          const name = validateIMName(request.name)
          if (!name.ok || name.name !== request.name) return yield* failure("im_activation_invalid")
          const requestHash = hash([request.name, request.method, request.quoteID, hash(request.credential)])
          const existing = yield* row(current.hash, request.transactionID)
          if (existing) {
            if (existing.request_hash !== requestHash) return yield* failure("im_activation_conflict")
            if (!request.retryOriginal || existing.state !== "unknown" || existing.charged_credits !== null)
              return view(existing)
          }
          if (request.retryOriginal && (!existing || !device)) return yield* failure("im_activation_conflict")
          if (!request.retryOriginal && (yield* pending).transaction) return yield* failure("im_activation_pending")
          if (
            !request.retryOriginal &&
            device &&
            (yield* device
              .get(current.url, "login")
              .pipe(Effect.mapError(() => failure("im_device_store_unavailable"))))
          )
            return yield* failure("im_device_binding_exists")
          if (unfinishedMigration(yield* migrationRecord)) return yield* failure("im_device_migration_pending")
          const receiptSecret = request.retryOriginal
            ? yield* device!
                .get(current.url, `activation-${request.transactionID}`)
                .pipe(Effect.mapError(() => failure("im_activation_credentials_unavailable")))
            : randomBytes(32).toString("base64url")
          if (!receiptSecret) return yield* failure("im_activation_credentials_unavailable")
          // Persist recovery authority BEFORE any request can consume credit. The raw
          // payment key is used once, only by this explicitly requested POST.
          if (!request.retryOriginal)
            yield* device
              ? device
                  .put(current.url, `activation-${request.transactionID}`, receiptSecret)
                  .pipe(Effect.mapError(() => failure("im_activation_credentials_unavailable")))
              : input.auth
                  .set(
                    `im-activation-${request.transactionID}`,
                    new Auth.Api({ type: "api", key: receiptSecret, metadata: { imSource: current.hash } }),
                  )
                  .pipe(Effect.mapError(() => failure("im_activation_credentials_unavailable")))
          const key = device
            ? yield* device.identity.pipe(Effect.mapError(() => failure("im_device_store_unavailable")))
            : undefined
          const boundHash = key
            ? IMDeviceProof.digest([
                "dac.im.activation.v2",
                current.url,
                request.transactionID,
                request.name,
                request.method,
                request.quoteID,
                IMDeviceProof.sha256(request.credential),
                IMDeviceProof.sha256(receiptSecret),
                key.jkt,
              ])
            : undefined
          if (request.retryOriginal) {
            const raw = yield* device!
              .get(current.url, `activation-context-${request.transactionID}`)
              .pipe(Effect.mapError(() => failure("im_activation_credentials_unavailable")))
            const saved = raw
              ? Schema.decodeUnknownOption(
                  Schema.UnknownFromJsonString.pipe(
                    Schema.decodeTo(Schema.Struct({ deviceJkt: Schema.String, requestHash: Schema.String })),
                  ),
                )(raw)
              : Option.none()
            if (Option.isNone(saved) || saved.value.deviceJkt !== key!.jkt || saved.value.requestHash !== boundHash)
              return yield* failure("im_activation_conflict")
          }
          if (!request.retryOriginal && device && key)
            yield* device
              .put(
                current.url,
                `activation-context-${request.transactionID}`,
                JSON.stringify({ deviceJkt: key.jkt, requestHash: boundHash }),
              )
              .pipe(Effect.mapError(() => failure("im_activation_credentials_unavailable")))
          const url = `${current.url}/api/im/activation`
          const headers: Record<string, string> =
            transport && key
              ? yield* transport
                  .headers({
                    realm: current.url,
                    method: "POST",
                    url,
                    purpose: "activation",
                    transactionID: request.transactionID,
                    requestHash: boundHash!,
                  })
                  .pipe(Effect.mapError(() => failure("im_device_challenge_unavailable")))
              : {}
          const requestBody = yield* HttpClientRequest.bodyJson({
            ...request,
            receiptSecret,
            ...(key
              ? { profile: IMDeviceProof.profile, publicJwk: key.publicJwk, challengeID: headers["X-IM-Challenge-ID"] }
              : {}),
          })(HttpClientRequest.post(url).pipe(HttpClientRequest.setHeaders(headers))).pipe(
            Effect.mapError(() => failure("im_activation_invalid")),
          )
          // Challenge/encoding failures are pre-payment refusals. Only persist an unknown outcome
          // once a complete, signed request is ready; receipt custody still precedes dispatch.
          if (!request.retryOriginal)
            yield* input.db
              .insert(IMActivationTable)
              .values({
                transaction_id: request.transactionID,
                source_hash: current.hash,
                request_hash: requestHash,
                name: request.name,
                method: request.method,
                quote_id: request.quoteID,
                state: "unknown",
                charged_credits: null,
                credential_stored: false,
                created_at: Date.now(),
                updated_at: Date.now(),
              })
              .run()
              .pipe(Effect.mapError(() => failure("im_activation_storage_unavailable")))
          const original = (yield* row(current.hash, request.transactionID))!
          const result = yield* call(requestBody, resultSchema).pipe(Effect.result)
          if (result._tag === "Failure") {
            if (request.retryOriginal) return view(original)
            if (
              [
                "im_activation_invalid",
                "im_activation_quote_expired",
                "im_activation_source_unavailable",
                "im_identity_conflict",
                "im_device_proof_invalid",
                "im_device_upgrade_required",
                "im_activation_source_already_used",
              ].includes(result.failure.code)
            )
              return yield* finish(current, original, {
                transactionID: request.transactionID,
                method: request.method,
                state: "rejected",
                chargedCredits: 0,
                entitlementExpiresAt: null,
                rejectionCode: result.failure.code,
              })
            return view(original)
          }
          return yield* finish(current, original, result.success)
        }),
      ),
  }
})

export class Service extends Context.Service<Service, Effect.Success<ReturnType<typeof make>>>()(
  "@deepagent-code/im/Activation",
) {}
export const layer = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      return yield* make({
        db: (yield* Database.Service).db,
        auth: yield* Auth.Service,
        device: yield* IMDeviceStore.Service,
        http: Option.getOrUndefined(yield* Effect.serviceOption(HttpClient.HttpClient)),
        facadeURL: env[KernelConfig.facadeEnvKeys.url],
      })
    }),
  )
