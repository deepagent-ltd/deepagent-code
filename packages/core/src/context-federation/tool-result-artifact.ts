export * as ToolResultArtifact from "./tool-result-artifact"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Database } from "../database/database"
import { Hash } from "../util/hash"
import { CanonicalJson } from "../util/canonical-json"
import { ContextArtifactTable } from "./session-sql"
import { SecurityNamespaceID } from "./reference"
import { type Principal } from "./authorization"

/**
 * C3-06a — tool-result artifact with same-session permission + expiry.
 *
 * A tool-result artifact is the opaque, JSON-serializable payload a Provider tool returns after a
 * turn has dispatched. It must be:
 *   - readable ONLY by the session that wrote it (cross-session read -> typed `artifact_cross_session_denied`);
 *   - cryptographically sealed at rest (AES-256-GCM, same algorithm as the ContextArtifactStore);
 *   - bounded by a TTL (default 24h) after which a read is a typed `artifact_expired`;
 *   - deterministically addressed, so re-writing the same identity yields the same `ref`/`contentHash`.
 *
 * Storage reuses the existing `context_artifact` table (ContextArtifactTable) and the same
 * same-session permission + retention semantics as ContextArtifactStore, but exposes a payload seam
 * that the AuditArtifact-bound store cannot express: the store's `write` requires a full AuditArtifact
 * (selectionId + authorizationFingerprint + graph statuses) and derives a randomized sealed-token ref
 * per write, and its TTL is a single module `retentionMs`. Neither supports an explicit `artifactId`,
 * an arbitrary `payload`, a per-write `ttlMs`, or a deterministic ref. See the F3 report for the full
 * API divergence.
 */

/** Default tool-result artifact TTL: 24 hours. */
export const DefaultToolResultTtlMs = 24 * 60 * 60_000

const SchemaVersion = 1
const Algorithm = "aes-256-gcm"
const IV_BYTES = 12

/** Deterministic reference prefix. `ref` = `ctx-tool:<artifactId>`. */
export const ToolResultRefPrefix = "ctx-tool:"

// ---------------------------------------------------------------------------
// typed errors
// ---------------------------------------------------------------------------

/** A read is rejected because the reader's principal does not own the artifact's session. */
export class ArtifactCrossSessionDeniedError extends Schema.TaggedErrorClass<ArtifactCrossSessionDeniedError>()(
  "artifact_cross_session_denied",
  {},
) {}

/** A read is rejected because the artifact has passed its expiry. */
export class ArtifactExpiredError extends Schema.TaggedErrorClass<ArtifactExpiredError>()(
  "artifact_expired",
  { expiredAt: Schema.Int },
) {}

/** No artifact with the given identity exists. */
export class ArtifactNotFoundError extends Schema.TaggedErrorClass<ArtifactNotFoundError>()("artifact_not_found", {}) {}

/** The artifact identity is reused with a different owner session or different content. */
export class ArtifactConflictError extends Schema.TaggedErrorClass<ArtifactConflictError>()(
  "artifact_conflict",
  { reason: Schema.String },
) {}

/** Encryption/encryption-key/decryption failure. */
export class ArtifactEncryptionError extends Schema.TaggedErrorClass<ArtifactEncryptionError>()(
  "artifact_encryption_error",
  {},
) {}

export type Error =
  | ArtifactCrossSessionDeniedError
  | ArtifactExpiredError
  | ArtifactNotFoundError
  | ArtifactConflictError
  | ArtifactEncryptionError

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type WriteInput = {
  /** The session that owns the artifact (the only principal allowed to read it). */
  readonly sessionId: string
  /** Caller-supplied artifact identity (globally unique). */
  readonly artifactId: string
  /** Arbitrary JSON-serializable payload stored encrypted. */
  readonly payload: unknown
  /** Retention window; defaults to {@link DefaultToolResultTtlMs}. */
  readonly ttlMs?: number
  /** Injectable clock for deterministic tests. */
  readonly now?: number
}

export type WriteResult = {
  readonly artifactId: string
  readonly ref: string
  readonly contentHash: string
  readonly expiresAt: number
}

export type ReadInput = {
  readonly artifactId: string
  readonly principal: Principal
  /** Injectable clock for deterministic tests. */
  readonly now?: number
}

export type ReadResult = {
  readonly artifactId: string
  readonly ref: string
  readonly contentHash: string
  readonly payload: unknown
}

export interface Interface {
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, Error>
  readonly read: (input: ReadInput) => Effect.Effect<ReadResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ToolResultArtifact") {}

export type Config = {
  readonly securityNamespaceId: SecurityNamespaceID
  readonly keyId: string
  readonly encryptionKey: Uint8Array
}

export function layer(config: Config) {
  if (config.encryptionKey.byteLength !== 32) throw new ArtifactEncryptionError()
  if (!config.keyId.trim()) throw new ArtifactEncryptionError()
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db

      const write = Effect.fn("ToolResultArtifact.write")(function* (input: WriteInput) {
        if (!input.artifactId.trim()) return yield* new ArtifactConflictError({ reason: "artifact_id_empty" })
        const now = input.now ?? Date.now()
        const ttlMs = input.ttlMs ?? DefaultToolResultTtlMs
        const plaintext = Buffer.from(CanonicalJson.stringify(input.payload))
        const contentHash = Hash.sha256(plaintext)
        const ref = toolResultRef(input.artifactId)
        const expiresAt = now + ttlMs

        const existing = yield* db
          .select()
          .from(ContextArtifactTable)
          .where(eq(ContextArtifactTable.artifact_id, input.artifactId))
          .get()
          .pipe(Effect.orDie)
        if (existing) {
          if (existing.session_id !== input.sessionId) {
            return yield* new ArtifactConflictError({ reason: "artifact_id_reused_across_sessions" })
          }
          if (existing.content_hash !== contentHash) {
            return yield* new ArtifactConflictError({ reason: "artifact_id_content_mismatch" })
          }
          return { artifactId: input.artifactId, ref, contentHash, expiresAt: existing.expires_at }
        }

        const encrypted = yield* encrypt({
          key: config.encryptionKey,
          plaintext,
          aad: artifactAAD({
            securityNamespaceId: String(config.securityNamespaceId),
            sessionId: input.sessionId,
            artifactId: input.artifactId,
            contentHash,
          }),
        })
        yield* db
          .insert(ContextArtifactTable)
          .values({
            artifact_id: input.artifactId,
            security_namespace_id: String(config.securityNamespaceId),
            session_id: input.sessionId,
            selection_id: input.artifactId,
            artifact_ref: ref,
            schema_version: SchemaVersion,
            content_hash: contentHash,
            authorization_fingerprint: "tool-result",
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
        return { artifactId: input.artifactId, ref, contentHash, expiresAt }
      })

      const read = Effect.fn("ToolResultArtifact.read")(function* (input: ReadInput) {
        const now = input.now ?? Date.now()
        const row = yield* db
          .select()
          .from(ContextArtifactTable)
          .where(eq(ContextArtifactTable.artifact_id, input.artifactId))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new ArtifactNotFoundError()
        if (row.deleted_at !== null || row.expires_at <= now) {
          return yield* new ArtifactExpiredError({ expiredAt: row.expires_at })
        }
        if (
          row.security_namespace_id !== input.principal.securityNamespaceId ||
          !input.principal.sessionIds.includes(row.session_id)
        ) {
          return yield* new ArtifactCrossSessionDeniedError()
        }
        if (!row.iv || !row.ciphertext || !row.auth_tag || row.encryption_key_id !== config.keyId) {
          return yield* new ArtifactEncryptionError()
        }
        const plaintext = yield* decrypt({
          key: config.encryptionKey,
          iv: row.iv,
          ciphertext: row.ciphertext,
          authTag: row.auth_tag,
          aad: artifactAAD({
            securityNamespaceId: row.security_namespace_id,
            sessionId: row.session_id,
            artifactId: row.artifact_id,
            contentHash: row.content_hash,
          }),
        })
        const payload = yield* Effect.try({
          try: () => JSON.parse(plaintext) as unknown,
          catch: () => new ArtifactEncryptionError(),
        })
        return {
          artifactId: row.artifact_id,
          ref: toolResultRef(row.artifact_id),
          contentHash: row.content_hash,
          payload,
        }
      })

      return Service.of({ write, read })
    }),
  )
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function toolResultRef(artifactId: string): string {
  return `${ToolResultRefPrefix}${artifactId}`
}

function artifactAAD(input: {
  readonly securityNamespaceId: string
  readonly sessionId: string
  readonly artifactId: string
  readonly contentHash: string
}) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: SchemaVersion,
      securityNamespaceId: input.securityNamespaceId,
      sessionId: input.sessionId,
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
    catch: () => new ArtifactEncryptionError(),
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
    catch: () => new ArtifactEncryptionError(),
  })
}
