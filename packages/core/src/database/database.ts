export * as Database from "./database"

import fs from "node:fs/promises"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { dirname, isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { migrations } from "./migration.gen"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"
import { containsDataPath } from "../global-path"
import { Sqlite } from "./sqlite"
import { DatabasePreflight } from "./preflight"
import { DatabaseBootstrap, DatabaseBootstrapError, type BootstrapInput, type BootstrapState } from "./bootstrap"
import { Backup } from "./backup"
import { BackupVerify } from "./backup-verify"
import { createHash } from "node:crypto"
import { StartupInventory } from "../session/runner/startup-inventory"
import { DatabaseMigrationLease } from "./migration-lease"
import { DatabaseUpgradeRun } from "./upgrade-run"

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

const CurrentPreflightState = Context.Reference<{ state?: BootstrapState }>(
  "@deepagent-code/v2/storage/CurrentPreflightState",
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

const backupFailure = (message: string) =>
  new DatabaseBootstrapError(
    DatabaseBootstrap.backupFailureState({ buildDigest: registryDigest(knownMigrationIds) }, message),
  )

const preflightOptionsFor = (filename: string, buildVersion: string): DatabasePreflight.PreflightOptions => ({
  filename,
  readerProtocol: SupportedReaderProtocol,
  writerProtocol: SupportedWriterProtocol,
  knownMigrationIds,
  historicalAliases: Object.fromEntries(DatabaseMigration.historicalAliases),
  knownContentHashes: Object.fromEntries(
    migrations.map((migration) => [migration.id, DatabaseUpgradeRun.migrationContentHash(migration)]),
  ),
  legacyContentIdentityBoundary: DatabaseMigration.legacyContentIdentityBoundary,
  mergedHistoryAnchor: DatabaseMigration.mergedHistoryAnchor,
  mergedHistoryInsertions: DatabaseMigration.mergedHistoryInsertions,
  buildDigest: registryDigest(knownMigrationIds),
  buildVersion,
})

const verifyStartupInventory = Effect.fn("Database.verifyStartupInventory")(function* (db: DatabaseShape) {
  const verdict = yield* StartupInventory.verifyStartupInventory(db)
  if (verdict.ok) return
  const first = verdict.unclassifiedItems[0]
  return yield* Effect.fail(
    new DatabaseBootstrapError(
      DatabaseBootstrap.startupRecoveryState(
        { buildDigest: registryDigest(knownMigrationIds) },
        {
          stableCode: "startup_inventory_unclassified",
          message: `${verdict.unclassifiedItems.length} durable startup item(s) could not be classified`,
          table: first?.category,
          key: first?.id,
        },
      ),
    ),
  )
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
    recoveryComplete: !recoveryRequired,
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
  const input = toBootstrapInput(preflightResult)
  const state = DatabaseBootstrap.describeBootstrap(input, { buildDigest })
  if (!state.ready || !input.hasExistingDatabase || input.pendingMigrationIds.length > 0) return state

  const inventory = await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDatabase
      yield* db.run("PRAGMA query_only = ON")
      return yield* StartupInventory.verifyStartupInventory(db)
    }).pipe(Effect.provide(sqliteLayer({ filename, readonly: true })), Effect.scoped, Effect.exit),
  )
  if (inventory._tag === "Failure")
    return DatabaseBootstrap.startupRecoveryState(
      { buildDigest },
      {
        stableCode: "startup_inventory_check_failed",
        message: "durable startup inventory could not be read safely",
      },
    )
  if (inventory.value.ok) return state
  return DatabaseBootstrap.startupRecoveryState(
    { buildDigest },
    {
      stableCode: "startup_inventory_unclassified",
      message: `${inventory.value.unclassifiedItems.length} durable startup item(s) could not be classified`,
      table: inventory.value.unclassifiedItems[0]?.category,
      key: inventory.value.unclassifiedItems[0]?.id,
    },
  )
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
  const file = yield* CurrentDatabaseFile
  yield* DatabaseMigration.apply(db, {
    filename: file.filename,
    readerProtocol: String(SupportedReaderProtocol),
    writerProtocol: String(SupportedWriterProtocol),
  })
  yield* verifyStartupInventory(db)

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

  return { db, mode: DatabaseBootstrap.readyState({ buildDigest: registryDigest(knownMigrationIds) }) } satisfies Interface
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
      const preflight = yield* CurrentPreflightState
      const bootState = preflight.state ?? (yield* Effect.tryPromise(() => bootstrap(filename)))
      mode = bootState
      if (!bootState.ready) return yield* Effect.fail(new DatabaseBootstrapError(bootState))
      // §10.4 executor (DATA-P2-3 close): the state machine reports an existing DB with
      // pending migrations as `backup_required` (mode=ready), but no production path ran
      // the pre-migration backup — open+apply would migrate WITHOUT the safety snapshot.
      // Before the migrate layer: create the consistency backup and verify it. A backup
      // failure BLOCKS the migration (design §10.4: any failure here means do not migrate;
      // the shell surfaces backup_failed/upgrade guidance with the retained previous backup).
      if (bootState.phase === "backup_required") {
        const destDir = join(dirname(filename), "backups")
        yield* Effect.tryPromise({
          try: () => fs.mkdir(destDir, { recursive: true }),
          catch: () => backupFailure("could not create the consistency backup directory"),
        })
        // Any backup failure blocks the open (fail-closed per §10.4: the previous
        // known-good backup + incident set are retained; the shell surfaces guidance).
        const manifest = yield* Backup.create({ sourcePath: filename, destDir, buildId: InstallationVersion }).pipe(
          Effect.mapError(() => backupFailure("could not create the required consistency backup")),
        )
        const outcome = yield* BackupVerify.verify(manifest)
        if (!outcome.ok)
          return yield* Effect.fail(backupFailure(`consistency backup verification failed: ${outcome.reason}`))
      }
      // Close the preflight→writable-open TOCTOU window. The read-only probe can only report the
      // owner state it observed; this exact process must acquire the lifetime owner before SQLite
      // is opened read-write, WAL is selected, or migrations are considered.
      yield* Effect.acquireRelease(
        DatabaseMigrationLease.acquireProcessLock(`${filename}.runtime.lock`, {
          staleMs: 15_000,
          timeoutMs: 5_000,
        }).pipe(
          Effect.mapError(
            () =>
              new DatabaseBootstrapError(
                DatabaseBootstrap.startupRecoveryState(
                  { buildDigest: registryDigest(knownMigrationIds) },
                  {
                    stableCode: "another_process_active",
                    message: "another process acquired the database runtime owner lock",
                  },
                ),
              ),
          ),
        ),
        (runtimeLock) => runtimeLock.release,
      )
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
    // Post-migration verification only runs while a migration is pending. Startup recovery
    // classification is a separate admission gate and must run on every ordinary restart too.
    yield* verifyStartupInventory(db)
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

    // The owning process has now completed every writable admission gate. Do not re-run the
    // external-process preflight here: its lifetime lock is intentionally visible and would be
    // mistaken for a second process. Publish the terminal state from the gates just completed.
    mode = DatabaseBootstrap.readyState({ buildDigest: registryDigest(knownMigrationIds) })

    return { db, mode }
  }),
)

export function layerFromPath(filename: string) {
  // Resolve the physical read-only preflight before the SQLite business dependency is even built.
  // This ordering prevents a fresh store from being created/opened writable before compatibility
  // and process-owner checks have completed.
  return Layer.unwrap(
    Effect.promise(() => bootstrap(filename)).pipe(
      Effect.map((state) =>
        layer.pipe(
          Layer.provide(Layer.succeed(CurrentPreflightState, { state })),
          Layer.provide(Layer.succeed(CurrentDatabaseFile, { filename })),
          Layer.provide(sqliteLayer({ filename })),
        ),
      ),
    ),
  )
}

/**
 * Open and forward-migrate a database while the caller already owns the lifetime runtime lock.
 * This narrow layer exists for verified restore only: it deliberately skips external-owner
 * preflight so the caller is not mistaken for a competing process, while preserving migration,
 * inventory, capability, WAL and durability gates.
 */
export function ownedLayerFromPath(filename: string) {
  return Layer.effect(Service, openAndMigrate).pipe(
    Layer.provide(Layer.succeed(CurrentDatabaseFile, { filename })),
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

/**
 * Short-lived maintenance writer for exact recovery commands. It is intentionally unavailable to
 * the ordinary route graph: callers must already be in read_only_recovery, acquire the same
 * lifetime owner as the business runtime, and close the scope after one maintenance operation.
 * It never runs migrations or admits provider/tool work.
 */
export function maintenanceLayerFromPath(filename: string) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const bootState = yield* Effect.tryPromise(() => bootstrap(filename))
      if (bootState.mode !== "read_only_recovery")
        return yield* Effect.fail(new DatabaseBootstrapError(bootState))
      yield* Effect.acquireRelease(
        DatabaseMigrationLease.acquireProcessLock(`${filename}.runtime.lock`, {
          staleMs: 15_000,
          timeoutMs: 1_000,
        }).pipe(
          Effect.mapError(
            () =>
              new DatabaseBootstrapError(
                DatabaseBootstrap.startupRecoveryState(
                  { buildDigest: registryDigest(knownMigrationIds) },
                  {
                    stableCode: "another_process_active",
                    message: "another process owns the database maintenance target",
                  },
                ),
              ),
          ),
        ),
        (runtimeLock) => runtimeLock.release,
      )
      const db = yield* makeDatabase
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = FULL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA foreign_keys = ON")
      return { db, mode: bootState }
    }),
  ).pipe(
    Layer.provide(Layer.succeed(CurrentDatabaseFile, { filename })),
    Layer.provide(sqliteLayer({ filename })),
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
