import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Cause } from "effect"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { layer } from "../../src/database/sqlite.bun"
import { Database } from "../../src/database/database"
import { IMRepository, IMRepositoryLive, IMRepositoryError } from "../../src/im/repository"

const root = process.argv[2]
const suffix = process.argv[3]
// Exercise the module's real transaction through independent SQLite connections.
// Production Root bootstrap still rejects competing lifetime DB owners.
const database = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA synchronous = FULL")
    yield* db.run("PRAGMA foreign_keys = ON")
    return { db }
  }),
).pipe(Layer.provide(layer({ filename: path.join(root, "media.sqlite") })))
const reserved = await Effect.runPromise(
  Effect.gen(function* () {
    const repo = yield* IMRepository
    yield* Effect.promise(() => fs.writeFile(path.join(root, `ready-${suffix}`), "ready", { mode: 0o600 }))
    for (let index = 0; ; index++) {
      if (
        yield* Effect.promise(() =>
          fs.stat(path.join(root, "reserve-now")).then(
            () => true,
            () => false,
          ),
        )
      )
        break
      if (index === 500) throw new Error("Private capacity start was not confirmed")
      yield* Effect.sleep("10 millis")
    }
    const result = yield* repo
      .createAttachment({
        id: `ima_concurrent_${suffix}`,
        workspaceID: "private-capacity",
        uploadedBy: "server",
        storagePath: "/private/fixture",
        filename: "large.bin",
        mime: "application/octet-stream",
        sizeBytes: 2 * 1024 * 1024,
        checksum: "a".repeat(64),
      })
      .pipe(Effect.exit)
    if (result._tag === "Success") return true
    const error = Cause.squash(result.cause)
    if (!(error instanceof IMRepositoryError) || error.operation !== "attachment_capacity") throw error
    return false
  }).pipe(Effect.provide(Layer.provideMerge(IMRepositoryLive, database))),
)
console.log(JSON.stringify({ reserved }))
