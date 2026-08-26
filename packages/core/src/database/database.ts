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
import { containsDataPath } from "../global-path"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

// Compatibility protocol this runtime implements. Protocol 2 is the 1.4.5/1.4.6-era; protocol 3
// marks databases that carry provider-owner successor generations (provider-owner successor fence): an
// older binary that does not understand successor tokens must refuse to open such a database, or its
// startup recovery would re-quarantine the successor state.
export const SupportedReaderProtocol = 3
export const SupportedWriterProtocol = 3

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
    // Tune WAL autocheckpoint: default 1000 pages (~4MB) causes large infrequent merges that spike
    // write-lock hold time. 200 pages (~800KB) keeps each merge cheap while still amortizing I/O.
    // Removed the blocking wal_checkpoint(PASSIVE) call (was 1-3s on large DBs); frequent small
    // autocheckpoints are a better long-term strategy.
    yield* db.run("PRAGMA wal_autocheckpoint = 200")
    yield* DatabaseMigration.apply(db)

    const capabilities = yield* db.all<{
      capability: string
      minimum_reader_protocol: number
      minimum_writer_protocol: number
    }>("SELECT capability, minimum_reader_protocol, minimum_writer_protocol FROM database_capability")
    for (const capability of capabilities) {
      if (capability.minimum_reader_protocol > SupportedReaderProtocol || capability.minimum_writer_protocol > SupportedWriterProtocol)
        return yield* Effect.die(
          new Error(
            `Database capability ${capability.capability} requires reader protocol ${capability.minimum_reader_protocol} and writer protocol ${capability.minimum_writer_protocol}; this runtime supports protocol ${SupportedWriterProtocol}`,
          ),
        )
    }

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

export function path() {
  if (Flag.DEEPAGENT_CODE_DB) {
    if (Flag.DEEPAGENT_CODE_DB === ":memory:") return Flag.DEEPAGENT_CODE_DB
    const filename = isAbsolute(Flag.DEEPAGENT_CODE_DB)
      ? Flag.DEEPAGENT_CODE_DB
      : join(Global.Path.data, Flag.DEEPAGENT_CODE_DB)
    if (process.env.DEEPAGENT_CODE_TEST_HOME || containsDataPath(filename)) return filename
    throw new Error(`DEEPAGENT_CODE_DB must stay under ${Global.Path.data}`)
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
