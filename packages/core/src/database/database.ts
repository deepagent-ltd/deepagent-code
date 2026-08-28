export * as Database from "./database"

import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { migrations } from "./migration.gen"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"
import { containsDataPath } from "../global-path"
import { Sqlite } from "./sqlite"
import { DatabasePreflight } from "./preflight"
import { DatabaseBootstrap, DatabaseBootstrapError, type BootstrapInput, type BootstrapState } from "./bootstrap"
import { createHash } from "node:crypto"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

// Compatibility protocol this runtime implements. Protocol 2 is the 1.4.5/1.4.6-era; protocol 3
// marks databases that carry provider-owner successor generations (provider-owner successor fence): an
// older binary that does not understand successor tokens must refuse to open such a database, or its
// startup recovery would re-quarantine the successor state.
export const SupportedReaderProtocol = 3
export const SupportedWriterProtocol = 3

/** The database file path used to derive the OS migration lock (skipped for in-memory databases). */
export const CurrentDatabaseFile = Context.Reference<{ filename?: string }>(
  "@deepagent-code/v2/storage/CurrentDatabaseFile",
  { defaultValue: () => ({}) },
)

export interface Interface {
  db: DatabaseShape
  /**
   * C1A-12: the bootstrap state that produced this layer. `mode` is present for the ready layer and
   * for the read-only maintenance opener; a bare `{ db }` (e.g. `openAndMigrate`) omits it. Business
   * write paths consult `DatabaseMode.assertWritable(DatabaseMode.snapshotOf(mode))` BEFORE writing.
   */
  mode?: BootstrapState
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/storage/Database") {}

const knownMigrationIds = migrations.map((migration) => migration.id)

/** Stable build/registry digest for diagnostics (design §10.3 / §10.5). */
const registryDigest = (ids: readonly string[]): string =>
  createHash("sha256").update(ids.join("\n")).digest("hex")

const preflightOptionsFor = (filename: string, buildVersion: string): DatabasePreflight.PreflightOptions => ({
  filename,
  readerProtocol: SupportedReaderProtocol,
  writerProtocol: SupportedWriterProtocol,
  knownMigrationIds,
  historicalAliases: Object.fromEntries(DatabaseMigration.historicalAliases),
  mergedHistoryAnchor: DatabaseMigration.mergedHistoryAnchor,
  mergedHistoryInsertions: DatabaseMigration.mergedHistoryInsertions,
  buildDigest: registryDigest(knownMigrationIds),
  buildVersion,
})

const toBootstrapInput = (preflightResult: DatabasePreflight.PreflightResult): BootstrapInput => {
  const observations = preflightResult.observations
  const completed = new Set(
    observations.journalRows.map((row) => DatabaseMigration.historicalAliases.get(row.id) ?? row.id),
  )
  const pendingMigrationIds = knownMigrationIds.filter((id) => !completed.has(id))
  const hasExistingDatabase = observations.exists && observations.size > 0
  const recoveryRequired =
    !preflightResult.ok &&
    preflightResult.issues.some(
      (issue) => issue.code === "unfinished_upgrade_run" || issue.code === "another_process_active",
    )
  const needsBackup = hasExistingDatabase && pendingMigrationIds.length > 0
  return {
    preflight: preflightResult,
    pendingMigrationIds,
    hasExistingDatabase,
    needsBackup,
    backupReady: false,
    recoveryRequired,
    recoveryComplete: true,
    postVerifyPassed: false,
  }
}

/**
 * Run the read-only preflight (§10.3) and derive the bootstrap state (§10.2).
 * This is the SAME first-phase step the application shell calls to show a phase
 * without opening the business Database layer; the business layer then fails
 * closed unless the state is ready.
 */
export const bootstrap = async (filename: string, buildVersion = InstallationVersion): Promise<BootstrapState> => {
  const buildDigest = registryDigest(knownMigrationIds)
  const preflightResult = await DatabasePreflight.preflight(preflightOptionsFor(filename, buildVersion))
  return DatabaseBootstrap.describeBootstrap(toBootstrapInput(preflightResult), { buildDigest })
}

/** Open the business DB and apply forward migrations. Failures are defects (existing semantics). */
const openAndMigrate = Effect.gen(function* () {
  const db = yield* makeDatabase

  yield* db.run("PRAGMA journal_mode = WAL")
  // Beta authority DB durability (design §10.6): WAL + synchronous=FULL is the default. FULL fsyncs
  // every commit to the WAL so a power-loss/crash cannot lose an acknowledged receipt or migration
  // (C1A-10). NORMAL is intentionally NOT used for any write path to the authority DB.
  yield* db.run("PRAGMA synchronous = FULL")
  yield* db.run("PRAGMA busy_timeout = 5000")
  yield* db.run("PRAGMA cache_size = -64000")
  yield* db.run("PRAGMA foreign_keys = ON")
  // Tune WAL autocheckpoint: default 1000 pages (~4MB) causes large infrequent merges that spike
  // write-lock hold time. 200 pages (~800KB) keeps each merge cheap while still amortizing I/O.
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

  return { db } satisfies Interface
}).pipe(Effect.orDie)

/**
 * The business Database layer. It runs the read-only preflight FIRST. If bootstrap
 * is not ready (incompatible binary, invalid DB, journal divergence, insufficient
 * space, non-local filesystem, unfinished upgrade run, active process) it fails
 * closed with a `DatabaseBootstrapError` and never admits business SQL. A `:memory:`
 * database (tests) skips the preflight and opens directly.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as { filename?: string } | null
    const filename = native?.filename ?? ""
    let mode: BootstrapState | undefined
    if (filename !== "" && filename !== ":memory:") {
      const bootState = yield* Effect.tryPromise(() => bootstrap(filename))
      mode = bootState
      if (!bootState.ready) return yield* Effect.fail(new DatabaseBootstrapError(bootState))
    }
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    // Beta authority DB durability (design §10.6): WAL + synchronous=FULL is the default. FULL fsyncs
    // every commit to the WAL so a power-loss/crash cannot lose an acknowledged receipt or migration
    // (C1A-10). NORMAL is intentionally NOT used for any write path to the authority DB.
    yield* db.run("PRAGMA synchronous = FULL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    // Tune WAL autocheckpoint: default 1000 pages (~4MB) causes large infrequent merges that spike
    // write-lock hold time. 200 pages (~800KB) keeps each merge cheap while still amortizing I/O.
    // Removed the blocking wal_checkpoint(PASSIVE) call (was 1-3s on large DBs); frequent small
    // autocheckpoints are a better long-term strategy.
    yield* db.run("PRAGMA wal_autocheckpoint = 200")
    const file = yield* CurrentDatabaseFile
    yield* DatabaseMigration.apply(db, {
      filename: file.filename,
      readerProtocol: String(SupportedReaderProtocol),
      writerProtocol: String(SupportedWriterProtocol),
    })

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

    return { db, mode }
  }),
)

export function layerFromPath(filename: string) {
  return layer.pipe(
    Layer.provide(Layer.effect(CurrentDatabaseFile, Effect.succeed({ filename }))),
    Layer.provide(sqliteLayer({ filename })),
  )
}

/**
 * C1A-12 read-only maintenance opener. Opens the business DB READ-ONLY (query_only-fenced) for the
 * browse/search/export/backup/descriptor surface available in `read_only_recovery` and `blocked_schema`
 * (design §10.8) — it NEVER runs migrations or writes, and it never opens the business DB writable.
 * The `layer` (writable) fails closed for any non-ready mode; this is the ONLY read path into a
 * non-ready store. A ready store should use the normal `layer`; opening it here is a caller defect.
 */
export function readOnlyLayerFromPath(filename: string) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const bootState = yield* Effect.tryPromise(() => bootstrap(filename))
      if (bootState.mode === "ready")
        return yield* Effect.die(
          new Error(
            "readOnlyLayer must only be used for a read_only_recovery / blocked_schema store; a ready store should go through the writable layer",
          ),
        )
      const db = yield* makeDatabase
      // Fence every write at the SQLite level so a read-only maintenance browse can never mutate.
      yield* db.run("PRAGMA query_only = ON")
      yield* db.run("PRAGMA busy_timeout = 5000")
      return { db, mode: bootState }
    }),
  ).pipe(
    Layer.provide(Layer.effect(CurrentDatabaseFile, Effect.succeed({ filename }))),
    Layer.provide(sqliteLayer({ filename, readonly: true })),
  )
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
