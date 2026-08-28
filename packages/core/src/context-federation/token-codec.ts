export * as ContextTokenCodec from "./token-codec"

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Context, Effect, Schema } from "effect"
import { Version } from "./contract"
import { ContextRef, LocationKey, ProjectionSnapshotRevision, SecurityNamespaceID } from "./reference"

const Prefix = "ctx"
const Algorithm = "aes-256-gcm"
const IV_BYTES = 12
const TAG_BYTES = 16

export const CursorPage = Schema.Struct({
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastScore: Schema.Number.pipe(Schema.optional),
  lastEntityId: Schema.String.pipe(Schema.optional),
})

export const CursorSnapshot = Schema.Union([
  ProjectionSnapshotRevision,
  Schema.Struct({ kind: Schema.Literal("federated"), fingerprint: Schema.String }),
])
export type CursorSnapshot = typeof CursorSnapshot.Type

export const CursorBinding = Schema.Struct({
  securityNamespaceId: SecurityNamespaceID,
  locationKey: LocationKey,
  snapshotRevision: CursorSnapshot,
  queryFingerprint: Schema.String,
  authorizationFingerprint: Schema.String,
  page: CursorPage,
})
export type CursorBinding = typeof CursorBinding.Type

export const ArtifactBinding = Schema.Struct({
  securityNamespaceId: SecurityNamespaceID,
  sessionId: Schema.String,
  selectionId: Schema.String,
  artifactId: Schema.String,
})
export type ArtifactBinding = typeof ArtifactBinding.Type

const ContextRefPayload = Schema.Struct({
  version: Schema.Literal(Version.contextRefToken),
  purpose: Schema.Literal("context_ref"),
  issuedAt: Schema.Int,
  expiresAt: Schema.Int,
  value: ContextRef,
})
const CursorPayload = Schema.Struct({
  version: Schema.Literal(Version.cursor),
  purpose: Schema.Literal("cursor"),
  issuedAt: Schema.Int,
  expiresAt: Schema.Int,
  value: CursorBinding,
})
const ArtifactPayload = Schema.Struct({
  version: Schema.Literal(Version.artifactRefToken),
  purpose: Schema.Literal("artifact_ref"),
  issuedAt: Schema.Int,
  expiresAt: Schema.Int,
  value: ArtifactBinding,
})

const Payload = Schema.Union([ContextRefPayload, CursorPayload, ArtifactPayload])
type Payload = typeof Payload.Type
type Purpose = Payload["purpose"]

export type Key = {
  readonly id: string
  readonly secret: Uint8Array
  readonly decryptUntil?: number
}

export class InvalidKeyringError extends Schema.TaggedErrorClass<InvalidKeyringError>()(
  "ContextToken.InvalidKeyringError",
  { reason: Schema.String },
) {}

export class InvalidLifetimeError extends Schema.TaggedErrorClass<InvalidLifetimeError>()(
  "ContextToken.InvalidLifetimeError",
  {},
) {}

export class BrokenError extends Schema.TaggedErrorClass<BrokenError>()("ContextToken.BrokenError", {
  reason: Schema.Literals(["format", "unknown_key", "authentication", "payload", "purpose"]),
}) {}

export class ExpiredError extends Schema.TaggedErrorClass<ExpiredError>()("ContextToken.ExpiredError", {
  expiredAt: Schema.Int,
}) {}

export class KeyExpiredError extends Schema.TaggedErrorClass<KeyExpiredError>()("ContextToken.KeyExpiredError", {
  keyId: Schema.String,
  expiredAt: Schema.Int,
}) {}

export type DecodeError = BrokenError | ExpiredError | KeyExpiredError

export type Codec = {
  readonly sealContextRef: (value: ContextRef, lifetime: Lifetime) => string
  readonly sealCursor: (value: CursorBinding, lifetime: Lifetime) => string
  readonly sealArtifact: (value: ArtifactBinding, lifetime: Lifetime) => string
  readonly openContextRef: (token: string, now?: number) => Effect.Effect<ContextRef, DecodeError>
  readonly openCursor: (token: string, now?: number) => Effect.Effect<CursorBinding, DecodeError>
  readonly openArtifact: (token: string, now?: number) => Effect.Effect<ArtifactBinding, DecodeError>
}

export class Service extends Context.Service<Service, Codec>()("@deepagent-code/ContextTokenCodec") {}

export type Lifetime = {
  readonly issuedAt: number
  readonly expiresAt: number
}

export function make(input: { readonly activeKeyId: string; readonly keys: readonly Key[] }): Codec {
  const keys = new Map(input.keys.map((key) => [key.id, key]))
  const active = keys.get(input.activeKeyId)
  if (!active) throw new InvalidKeyringError({ reason: "active key is missing" })
  if (input.keys.some((key) => !/^[A-Za-z0-9_-]{1,64}$/.test(key.id))) {
    throw new InvalidKeyringError({ reason: "key IDs must be URL-safe and contain at most 64 characters" })
  }
  if (active.secret.byteLength !== 32 || input.keys.some((key) => key.secret.byteLength !== 32)) {
    throw new InvalidKeyringError({ reason: "AES-256-GCM keys must contain exactly 32 bytes" })
  }
  if (input.keys.length !== keys.size) throw new InvalidKeyringError({ reason: "key IDs must be unique" })

  const seal = (payload: Payload) => {
    if (
      !Number.isInteger(payload.issuedAt) ||
      !Number.isInteger(payload.expiresAt) ||
      payload.expiresAt <= payload.issuedAt
    ) {
      throw new InvalidLifetimeError()
    }
    const header = `${Prefix}${payload.version}.${active.id}`
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(Algorithm, active.secret, iv)
    cipher.setAAD(Buffer.from(header))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()])
    return `${header}.${Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64url")}`
  }

  const open = (token: string, purpose: Purpose, now: number): Effect.Effect<Payload, DecodeError> =>
    Effect.gen(function* () {
      const parts = token.split(".")
      if (parts.length !== 3 || !parts[0]?.startsWith(Prefix)) {
        return yield* new BrokenError({ reason: "format" })
      }
      const key = keys.get(parts[1] ?? "")
      if (!key) return yield* new BrokenError({ reason: "unknown_key" })
      if (key.decryptUntil !== undefined && now >= key.decryptUntil) {
        return yield* new KeyExpiredError({ keyId: key.id, expiredAt: key.decryptUntil })
      }
      const encoded = parts[2] ?? ""
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return yield* new BrokenError({ reason: "format" })
      const bytes = Buffer.from(encoded, "base64url")
      if (bytes.toString("base64url") !== encoded) return yield* new BrokenError({ reason: "format" })
      if (bytes.byteLength <= IV_BYTES + TAG_BYTES) return yield* new BrokenError({ reason: "format" })
      const decrypted = yield* Effect.try({
        try: () => {
          const decipher = createDecipheriv(Algorithm, key.secret, bytes.subarray(0, IV_BYTES))
          decipher.setAAD(Buffer.from(`${parts[0]}.${parts[1]}`))
          decipher.setAuthTag(bytes.subarray(bytes.byteLength - TAG_BYTES))
          return Buffer.concat([
            decipher.update(bytes.subarray(IV_BYTES, bytes.byteLength - TAG_BYTES)),
            decipher.final(),
          ]).toString("utf8")
        },
        catch: () => new BrokenError({ reason: "authentication" }),
      })
      const parsed = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Payload, { onExcessProperty: "error" })(JSON.parse(decrypted)),
        catch: () => new BrokenError({ reason: "payload" }),
      })
      if (parsed.purpose !== purpose) return yield* new BrokenError({ reason: "purpose" })
      if (now >= parsed.expiresAt) return yield* new ExpiredError({ expiredAt: parsed.expiresAt })
      return parsed
    })

  return {
    sealContextRef: (value, lifetime) =>
      seal({ version: Version.contextRefToken, purpose: "context_ref", ...lifetime, value }),
    sealCursor: (value, lifetime) => seal({ version: Version.cursor, purpose: "cursor", ...lifetime, value }),
    sealArtifact: (value, lifetime) =>
      seal({ version: Version.artifactRefToken, purpose: "artifact_ref", ...lifetime, value }),
    openContextRef: (token, now = Date.now()) =>
      open(token, "context_ref", now).pipe(
        Effect.flatMap((payload) =>
          payload.purpose === "context_ref"
            ? Effect.succeed(payload.value)
            : Effect.fail(new BrokenError({ reason: "purpose" })),
        ),
      ),
    openCursor: (token, now = Date.now()) =>
      open(token, "cursor", now).pipe(
        Effect.flatMap((payload) =>
          payload.purpose === "cursor"
            ? Effect.succeed(payload.value)
            : Effect.fail(new BrokenError({ reason: "purpose" })),
        ),
      ),
    openArtifact: (token, now = Date.now()) =>
      open(token, "artifact_ref", now).pipe(
        Effect.flatMap((payload) =>
          payload.purpose === "artifact_ref"
            ? Effect.succeed(payload.value)
            : Effect.fail(new BrokenError({ reason: "purpose" })),
        ),
      ),
  }
}
