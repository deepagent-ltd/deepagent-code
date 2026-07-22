export * as Database from "./database"

import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/storage/Database") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    // wal_checkpoint removed from startup: it blocked the "ready" signal by 1-3 s
    // on large databases. SQLite auto-checkpoints at wal_autocheckpoint = 1000 pages.
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

export function path() {
  if (Flag.DEEPAGENT_CODE_DB) {
    if (Flag.DEEPAGENT_CODE_DB === ":memory:" || isAbsolute(Flag.DEEPAGENT_CODE_DB)) return Flag.DEEPAGENT_CODE_DB
    return join(Global.Path.data, Flag.DEEPAGENT_CODE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.DEEPAGENT_CODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.DEEPAGENT_CODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "deepagent-code.db")
  return join(Global.Path.data, `deepagent-code-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return layerFromPath(path())
  }),
).pipe(Layer.provide(Global.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
