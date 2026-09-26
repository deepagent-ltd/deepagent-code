import { randomBytes } from "node:crypto"
import { Effect, Layer } from "effect"
import { ContextArtifactStore } from "../../src/context-federation/artifact-store"
import { SecurityNamespaceID } from "../../src/context-federation/reference"
import { SessionContext } from "../../src/context-federation/session-context"
import { ContextTokenCodec } from "../../src/context-federation/token-codec"
import { Database } from "../../src/database/database"
import { SessionSchema } from "../../src/session/schema"

// Use the durable admission path when a focused test needs an active activity
// but supplies the surrounding project, session, and promoted input itself.
export function openFixtureActivity(input: {
  sessionId: SessionSchema.ID
  triggerInputId: string
  securityNamespaceId: SecurityNamespaceID
  now: number
}) {
  return Effect.gen(function* () {
    const database = Layer.succeed(Database.Service, yield* Database.Service)
    const secret = randomBytes(32)
    const artifacts = ContextArtifactStore.layer({
      securityNamespaceId: input.securityNamespaceId,
      policy: "best_effort",
      keyId: "fixture",
      encryptionKey: secret,
      tokenCodec: ContextTokenCodec.make({ activeKeyId: "fixture", keys: [{ id: "fixture", secret }] }),
      limits: {
        maxItemBytes: 1_000_000,
        maxSessionBytes: 1_000_000,
        maxGlobalBytes: 1_000_000,
        retentionMs: 60_000,
        tokenLifetimeMs: 120_000,
      },
    }).pipe(Layer.provide(database))
    const context = SessionContext.layer.pipe(Layer.provide(Layer.merge(database, artifacts)))
    return yield* Effect.gen(function* () {
      return yield* (yield* SessionContext.Service).openActivity({
        sessionId: input.sessionId,
        triggerInputId: input.triggerInputId,
        now: input.now,
      })
    }).pipe(Effect.provide(context))
  })
}
