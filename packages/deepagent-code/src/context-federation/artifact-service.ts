export * as LiveContextArtifactStore from "./artifact-service"

import { ContextArtifactStore } from "@deepagent-code/core/context-federation/artifact-store"
import type { SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { Context, Effect, Layer, Schema } from "effect"
import { randomBytes } from "node:crypto"
import { chmod, mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"

const KeyFile = Schema.Struct({ keyId: Schema.String, secret: Schema.String })
const decodeKeyFile = Schema.decodeUnknownSync(Schema.fromJsonString(KeyFile), { onExcessProperty: "error" })

export function layer(config: {
  readonly filename: string
  readonly policy: "required" | "best_effort"
  readonly limits: ContextArtifactStore.Limits
}) {
  return Layer.effect(
    ContextArtifactStore.Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const codec = yield* ContextTokenCodec.Service
      const key = yield* Effect.tryPromise(() => load(config.filename)).pipe(Effect.orDie)
      const stores = new Map<SecurityNamespaceID, ContextArtifactStore.Interface>()

      const store = Effect.fn("ContextArtifact.namespace")((securityNamespaceId: SecurityNamespaceID) => Effect.scoped(Effect.gen(function* () {
        const existing = stores.get(securityNamespaceId)
        if (existing) return existing
        const built = yield* Layer.build(
          ContextArtifactStore.layer({
            securityNamespaceId,
            policy: config.policy,
            keyId: key.keyId,
            encryptionKey: decodeSecret(key.secret),
            tokenCodec: codec,
            limits: config.limits,
          }).pipe(Layer.provide(Layer.succeed(Database.Service, database))),
        )
        const created = Context.get(built, ContextArtifactStore.Service)
        stores.set(securityNamespaceId, created)
        return created
      })))

      return ContextArtifactStore.Service.of({
        policy: config.policy,
        write: (input) => store(input.securityNamespaceId).pipe(Effect.flatMap((service) => service.write(input))),
        read: (input) => codec.openArtifact(input.ref, input.now).pipe(
          Effect.flatMap((binding) => store(binding.securityNamespaceId)),
          Effect.flatMap((service) => service.read(input)),
        ),
        sweep: (now) => Effect.forEach([...stores.values()], (service) => service.sweep(now)).pipe(
          Effect.map((counts) => counts.reduce((total, count) => total + count, 0)),
        ),
        sweepOrphans: (olderThan) => Effect.forEach(
          [...stores.values()],
          (service) => service.sweepOrphans(olderThan),
        ).pipe(Effect.map((counts) => counts.reduce((total, count) => total + count, 0))),
      })
    }),
  )
}

export const defaultLayer = layer({
  filename: path.join(Global.Path.state, "context-federation", "artifact-key.json"),
  policy: "best_effort",
  limits: {
    maxItemBytes: 512_000,
    maxSessionBytes: 25_000_000,
    maxGlobalBytes: 500_000_000,
    retentionMs: 30 * 24 * 60 * 60_000,
    tokenLifetimeMs: 15 * 60_000,
  },
})

async function load(filename: string) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const generated = { keyId: `artifact_${randomBytes(8).toString("hex")}`, secret: randomBytes(32).toString("base64url") }
  const handle = await open(filename, "wx", 0o600).catch((error: unknown) => {
    if (record(error) && error.code === "EEXIST") return undefined
    throw error
  })
  if (handle) {
    await handle.writeFile(`${JSON.stringify(generated)}\n`, { encoding: "utf8" })
    await handle.sync()
    await handle.close()
  }
  await chmod(filename, 0o600)
  return decodeKeyFile(await readFile(filename, "utf8"))
}

function decodeSecret(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid artifact key encoding")
  const secret = Buffer.from(value, "base64url")
  if (secret.toString("base64url") !== value || secret.byteLength !== 32) throw new Error("invalid artifact key")
  return secret
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object")
}
