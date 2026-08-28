export * as ContextArtifactStore from "./artifact-store"

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { Hash } from "../util/hash"
import { ContextAuthorization, Sensitivity, type EgressPolicy, type Principal } from "./authorization"
import { GraphQueryStatus } from "./federation"
import { ContextRef, SecurityNamespaceID } from "./reference"
import { ContextTokenCodec, type Codec } from "./token-codec"
import { ContextArtifactTable } from "./session-sql"

const Algorithm = "aes-256-gcm"
const IV_BYTES = 12
const SchemaVersion = 1

export const SelectedEvidence = Schema.Struct({
  ref: ContextRef,
  sensitivity: Sensitivity,
  score: Schema.Finite,
  reason: Schema.String,
  excerpt: Schema.String,
})

export const AuditArtifact = Schema.Struct({
  schemaVersion: Schema.Literal(SchemaVersion),
  selectionId: Schema.String,
  queryFingerprint: Schema.String,
  authorizationFingerprint: Schema.String,
  graphStatuses: Schema.Array(GraphQueryStatus),
  rankingVersion: Schema.String,
  selected: Schema.Array(SelectedEvidence),
  rejected: Schema.Array(
    Schema.Struct({ graph: Schema.Literals(["code", "knowledge", "memory", "documents"]), reasonCode: Schema.String }),
  ),
})
export type AuditArtifact = typeof AuditArtifact.Type

export type Limits = {
  readonly maxItemBytes: number
  readonly maxSessionBytes: number
  readonly maxGlobalBytes: number
  readonly retentionMs: number
  readonly tokenLifetimeMs: number
}

export type WriteResult = {
  readonly artifactId: string
  readonly ref: string
  readonly contentHash: string
  readonly expiresAt: number
}

export type ReadResult =
  | { readonly status: "available"; readonly artifact: AuditArtifact; readonly contentHash: string }
  | { readonly status: "redacted"; readonly contentHash: string }
  | { readonly status: "expired"; readonly contentHash: string; readonly reason: string }

export class QuotaExceededError extends Schema.TaggedErrorClass<QuotaExceededError>()(
  "ContextArtifact.QuotaExceededError",
  { scope: Schema.Literals(["item", "session", "global"]) },
) {}

export class EncryptionError extends Schema.TaggedErrorClass<EncryptionError>()(
  "ContextArtifact.EncryptionError",
  {},
) {}
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ContextArtifact.NotFoundError", {}) {}
export class BindingError extends Schema.TaggedErrorClass<BindingError>()("ContextArtifact.BindingError", {}) {}
export class ExpiredError extends Schema.TaggedErrorClass<ExpiredError>()("ContextArtifact.ExpiredError", {}) {}

export type Error =
  | QuotaExceededError
  | EncryptionError
  | NotFoundError
  | BindingError
  | ExpiredError
  | ContextTokenCodec.DecodeError

export interface Interface {
  readonly policy: "required" | "best_effort"
  readonly write: (input: {
    readonly securityNamespaceId: SecurityNamespaceID
    readonly sessionId: string
    readonly selectionId: string
    readonly authorizationFingerprint: string
    readonly artifact: AuditArtifact
    readonly now?: number
  }) => Effect.Effect<WriteResult, Error>
  readonly read: (input: {
    readonly ref: string
    readonly principal: Principal
    readonly egress: EgressPolicy
    readonly now?: number
  }) => Effect.Effect<ReadResult, Error>
  readonly sweep: (now?: number) => Effect.Effect<number>
  readonly sweepOrphans: (olderThan: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ContextArtifactStore") {}

export function layer(config: {
  readonly securityNamespaceId: SecurityNamespaceID
  readonly policy: "required" | "best_effort"
  readonly keyId: string
  readonly encryptionKey: Uint8Array
  readonly tokenCodec: Codec
  readonly limits: Limits
}) {
  if (config.encryptionKey.byteLength !== 32) throw new EncryptionError()
  if (!config.keyId.trim() || !validLimits(config.limits)) throw new BindingError()
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db

      const writeRaw = Effect.fn("ContextArtifact.write")(function* (input: {
        readonly securityNamespaceId: SecurityNamespaceID
        readonly sessionId: string
        readonly selectionId: string
        readonly authorizationFingerprint: string
        readonly artifact: AuditArtifact
        readonly now?: number
      }) {
        if (input.securityNamespaceId !== config.securityNamespaceId) return yield* new BindingError()
        const artifact = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(AuditArtifact, { onExcessProperty: "error" })(input.artifact),
          catch: () => new BindingError(),
        })
        if (
          artifact.selectionId !== input.selectionId ||
          artifact.authorizationFingerprint !== input.authorizationFingerprint
        ) {
          return yield* new BindingError()
        }
        const plaintext = Buffer.from(canonicalArtifact(artifact))
        if (plaintext.byteLength > config.limits.maxItemBytes) {
          return yield* new QuotaExceededError({ scope: "item" })
        }
        const now = input.now ?? Date.now()
        const contentHash = Hash.sha256(plaintext)
        const artifactId = `artifact_${Hash.sha256(
          JSON.stringify({
            securityNamespaceId: input.securityNamespaceId,
            sessionId: input.sessionId,
            selectionId: input.selectionId,
            contentHash,
          }),
        )}`
        const existing = yield* db
          .select()
          .from(ContextArtifactTable)
          .where(eq(ContextArtifactTable.artifact_id, artifactId))
          .get()
          .pipe(Effect.orDie)
        if (existing?.deleted_at !== null && existing?.deleted_at !== undefined) return yield* new ExpiredError()
        if (existing && existing.expires_at <= now) return yield* new ExpiredError()
        const expiresAt = now + config.limits.retentionMs
        const artifactRef =
          existing?.artifact_ref ??
          config.tokenCodec.sealArtifact(
            {
              securityNamespaceId: input.securityNamespaceId,
              sessionId: input.sessionId,
              selectionId: input.selectionId,
              artifactId,
            },
            { issuedAt: now, expiresAt: now + config.limits.tokenLifetimeMs },
          )
        if (!existing) {
          const totals = yield* db
            .select({
              global: sql<number>`coalesce(sum(${ContextArtifactTable.original_size}), 0)`,
              session: sql<number>`coalesce(sum(case when ${ContextArtifactTable.security_namespace_id} = ${input.securityNamespaceId} and ${ContextArtifactTable.session_id} = ${input.sessionId} then ${ContextArtifactTable.original_size} else 0 end), 0)`,
            })
            .from(ContextArtifactTable)
            .where(and(isNull(ContextArtifactTable.deleted_at), gt(ContextArtifactTable.expires_at, now)))
            .get()
            .pipe(Effect.orDie)
          if ((totals?.session ?? 0) + plaintext.byteLength > config.limits.maxSessionBytes) {
            return yield* new QuotaExceededError({ scope: "session" })
          }
          if ((totals?.global ?? 0) + plaintext.byteLength > config.limits.maxGlobalBytes) {
            return yield* new QuotaExceededError({ scope: "global" })
          }
          const encrypted = yield* encrypt({
            key: config.encryptionKey,
            plaintext,
            aad: artifactAAD({ ...input, artifactId, contentHash }),
          })
          yield* db
            .insert(ContextArtifactTable)
            .values({
              artifact_id: artifactId,
              security_namespace_id: input.securityNamespaceId,
              session_id: input.sessionId,
              selection_id: input.selectionId,
              artifact_ref: artifactRef,
              schema_version: SchemaVersion,
              content_hash: contentHash,
              authorization_fingerprint: input.authorizationFingerprint,
              encryption_key_id: config.keyId,
              iv: encrypted.iv,
              ciphertext: encrypted.ciphertext,
              auth_tag: encrypted.authTag,
              original_size: plaintext.byteLength,
              created_at: now,
              expires_at: expiresAt,
            })
            .run()
            .pipe(Effect.orDie)
        }
        return {
          artifactId,
          ref: artifactRef,
          contentHash,
          expiresAt: existing?.expires_at ?? expiresAt,
        }
      })
      const write = (input: Parameters<Interface["write"]>[0]) => writeRaw(input).pipe(preserveErrors)

      const readRaw = Effect.fn("ContextArtifact.read")(function* (input: {
        readonly ref: string
        readonly principal: Principal
        readonly egress: EgressPolicy
        readonly now?: number
      }) {
        const now = input.now ?? Date.now()
        const binding = yield* config.tokenCodec.openArtifact(input.ref, now)
        if (binding.securityNamespaceId !== config.securityNamespaceId) return yield* new BindingError()
        const row = yield* db
          .select()
          .from(ContextArtifactTable)
          .where(eq(ContextArtifactTable.artifact_id, binding.artifactId))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError()
        if (
          row.security_namespace_id !== binding.securityNamespaceId ||
          row.session_id !== binding.sessionId ||
          row.selection_id !== binding.selectionId
        ) {
          return yield* new BindingError()
        }
        if (row.deleted_at !== null || row.expires_at <= now) {
          return {
            status: "expired" as const,
            contentHash: row.content_hash,
            reason: row.delete_reason ?? "retention_expired",
          }
        }
        if (
          input.principal.securityNamespaceId !== binding.securityNamespaceId ||
          !input.principal.sessionIds.includes(binding.sessionId)
        ) {
          return { status: "redacted" as const, contentHash: row.content_hash }
        }
        if (!row.iv || !row.ciphertext || !row.auth_tag || row.encryption_key_id !== config.keyId) {
          return yield* new EncryptionError()
        }
        const plaintext = yield* decrypt({
          key: config.encryptionKey,
          iv: row.iv,
          ciphertext: row.ciphertext,
          authTag: row.auth_tag,
          aad: artifactAAD({
            securityNamespaceId: SecurityNamespaceID.make(row.security_namespace_id),
            sessionId: row.session_id,
            selectionId: row.selection_id,
            authorizationFingerprint: row.authorization_fingerprint,
            artifactId: row.artifact_id,
            contentHash: row.content_hash,
          }),
        })
        const artifact = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(AuditArtifact, { onExcessProperty: "error" })(JSON.parse(plaintext)),
          catch: () => new EncryptionError(),
        })
        if (
          artifact.selected.some(
            (selected) =>
              !ContextAuthorization.authorize({
                ref: selected.ref,
                principal: input.principal,
                egress: input.egress,
                sensitivity: selected.sensitivity,
              }).allowed,
          )
        ) {
          return { status: "redacted" as const, contentHash: row.content_hash }
        }
        return { status: "available" as const, artifact, contentHash: row.content_hash }
      })
      const read = (input: Parameters<Interface["read"]>[0]) => readRaw(input).pipe(preserveErrors)

      const sweep = Effect.fn("ContextArtifact.sweep")(function* (now = Date.now()) {
        const rows = yield* db
          .update(ContextArtifactTable)
          .set({ iv: null, ciphertext: null, auth_tag: null, deleted_at: now, delete_reason: "retention_expired" })
          .where(
            and(
              eq(ContextArtifactTable.security_namespace_id, config.securityNamespaceId),
              isNull(ContextArtifactTable.deleted_at),
              lte(ContextArtifactTable.expires_at, now),
            ),
          )
          .returning({ artifact_id: ContextArtifactTable.artifact_id })
          .all()
          .pipe(Effect.orDie)
        return rows.length
      })

      const sweepOrphans = Effect.fn("ContextArtifact.sweepOrphans")(function* (olderThan: number) {
        const rows = yield* db
          .all<{ artifact_id: string }>(
            sql`
            SELECT artifact_id FROM context_artifact a
            WHERE a.security_namespace_id = ${config.securityNamespaceId}
              AND a.deleted_at IS NULL
              AND a.created_at < ${olderThan}
              AND NOT EXISTS (
                SELECT 1 FROM session_context_selection s
                WHERE s.selection_id = a.selection_id AND s.artifact_ref = a.artifact_ref
              )
          `,
          )
          .pipe(Effect.orDie)
        if (rows.length === 0) return 0
        yield* db
          .run(
            sql`
            UPDATE context_artifact
            SET iv = NULL, ciphertext = NULL, auth_tag = NULL,
                deleted_at = ${olderThan}, delete_reason = 'orphaned_selection'
            WHERE artifact_id IN (${sql.join(
              rows.map((row) => sql`${row.artifact_id}`),
              sql`, `,
            )})
          `,
          )
          .pipe(Effect.orDie)
        return rows.length
      })

      return Service.of({ policy: config.policy, write, read, sweep, sweepOrphans })
    }),
  )
}

function canonicalArtifact(artifact: AuditArtifact) {
  return JSON.stringify({
    schemaVersion: artifact.schemaVersion,
    selectionId: artifact.selectionId,
    queryFingerprint: artifact.queryFingerprint,
    authorizationFingerprint: artifact.authorizationFingerprint,
    graphStatuses: artifact.graphStatuses,
    rankingVersion: artifact.rankingVersion,
    selected: artifact.selected.map((selected) => ({
      ref: selected.ref,
      sensitivity: selected.sensitivity,
      score: selected.score,
      reason: selected.reason,
      excerpt: selected.excerpt,
    })),
    rejected: artifact.rejected.map((rejected) => ({ graph: rejected.graph, reasonCode: rejected.reasonCode })),
  })
}

function validLimits(limits: Limits) {
  return (
    Number.isSafeInteger(limits.maxItemBytes) &&
    limits.maxItemBytes > 0 &&
    Number.isSafeInteger(limits.maxSessionBytes) &&
    limits.maxSessionBytes >= limits.maxItemBytes &&
    Number.isSafeInteger(limits.maxGlobalBytes) &&
    limits.maxGlobalBytes >= limits.maxSessionBytes &&
    Number.isSafeInteger(limits.retentionMs) &&
    limits.retentionMs > 0 &&
    Number.isSafeInteger(limits.tokenLifetimeMs) &&
    limits.tokenLifetimeMs > limits.retentionMs
  )
}

function artifactAAD(input: {
  readonly securityNamespaceId: SecurityNamespaceID
  readonly sessionId: string
  readonly selectionId: string
  readonly authorizationFingerprint: string
  readonly artifactId: string
  readonly contentHash: string
}) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: SchemaVersion,
      securityNamespaceId: input.securityNamespaceId,
      sessionId: input.sessionId,
      selectionId: input.selectionId,
      authorizationFingerprint: input.authorizationFingerprint,
      artifactId: input.artifactId,
      contentHash: input.contentHash,
    }),
  )
}

function encrypt(input: { readonly key: Uint8Array; readonly plaintext: Uint8Array; readonly aad: Uint8Array }) {
  return Effect.try({
    try: () => {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(Algorithm, input.key, iv)
      cipher.setAAD(input.aad)
      const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()])
      return { iv, ciphertext, authTag: cipher.getAuthTag() }
    },
    catch: () => new EncryptionError(),
  })
}

function decrypt(input: {
  readonly key: Uint8Array
  readonly iv: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authTag: Uint8Array
  readonly aad: Uint8Array
}) {
  return Effect.try({
    try: () => {
      const decipher = createDecipheriv(Algorithm, input.key, input.iv)
      decipher.setAAD(input.aad)
      decipher.setAuthTag(input.authTag)
      return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString("utf8")
    },
    catch: () => new EncryptionError(),
  })
}

function preserveErrors<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Error, R> {
  return effect.pipe(Effect.catch((error) => (isError(error) ? Effect.fail(error) : Effect.die(error))))
}

function isError(value: unknown): value is Error {
  if (!value || typeof value !== "object" || !("_tag" in value)) return false
  return [
    "ContextArtifact.QuotaExceededError",
    "ContextArtifact.EncryptionError",
    "ContextArtifact.NotFoundError",
    "ContextArtifact.BindingError",
    "ContextArtifact.ExpiredError",
    "ContextToken.BrokenError",
    "ContextToken.ExpiredError",
    "ContextToken.KeyExpiredError",
  ].includes(String(value._tag))
}
