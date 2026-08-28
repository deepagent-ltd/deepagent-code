import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseBootstrapError } from "@deepagent-code/core/database/bootstrap"
import { DatabaseMode } from "@deepagent-code/core/database/mode"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { tmpdir } from "./fixture/tmpdir"

// C1A-12 STARTUP MODE ENFORCEMENT (design §10.8). The Bootstrap state machine models ready /
// read_only_recovery / blocked_schema; this is the CORE typed enforcement so a write can never
// silently proceed against a non-writable store. blocked_schema never mounts the business DB writable
// (the writable layer fails closed) and read_only_recovery refuses writable admission + provider /
// mutating tool while allowing read-only browse/export through the read-only opener.

const snapshot = DatabaseMode.snapshotOf

describe("DatabaseMode guard (C1A-12)", () => {
  test("assertWritable passes in ready mode", () => {
    expect(() => DatabaseMode.assertWritable(snapshot({ mode: "ready", ready: true, phase: "ready" } as never))).not.toThrow()
  })

  test("read_only_recovery refuses writable admission (typed, C0-03 service_unavailable)", () => {
    try {
      DatabaseMode.assertWritable(snapshot({ mode: "read_only_recovery", ready: false, phase: "post_verify" } as never))
      expect.unreachable("expected a refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseMode.DatabaseModeWriteRefused)
      const refusal = error as DatabaseMode.DatabaseModeWriteRefused
      expect(refusal.stableCode).toBe("read_only_recovery_write_refused")
      expect(refusal.wireCode).toBe("service_unavailable")
      expect(refusal.mode).toBe("read_only_recovery")
    }
  })

  test("blocked_schema refuses with blocked_schema_business_write_refused", () => {
    try {
      DatabaseMode.assertWritable(snapshot({ mode: "blocked_schema", ready: false, phase: "blocked_schema" } as never))
      expect.unreachable("expected a refusal")
    } catch (error) {
      const refusal = error as DatabaseMode.DatabaseModeWriteRefused
      expect(refusal.stableCode).toBe("blocked_schema_business_write_refused")
      expect(refusal.wireCode).toBe("service_unavailable")
    }
  })

  test("read_only_recovery refuses provider / mutating tool (typed, C0-03 permission_denied)", () => {
    try {
      DatabaseMode.assertProviderAllowed(snapshot({ mode: "read_only_recovery", ready: false, phase: "post_verify" } as never))
      expect.unreachable("expected a refusal")
    } catch (error) {
      const refusal = error as DatabaseMode.DatabaseModeWriteRefused
      expect(refusal.stableCode).toBe("read_only_recovery_provider_refused")
      expect(refusal.wireCode).toBe("permission_denied")
    }
  })

  test("assertProviderAllowed passes in ready mode", () => {
    expect(() => DatabaseMode.assertProviderAllowed(snapshot({ mode: "ready", ready: true, phase: "ready" } as never))).not.toThrow()
  })

  test("ensureReady refuses a non-ready state (typed)", () => {
    expect(() =>
      DatabaseMode.ensureReady({ mode: "blocked_schema", ready: false, phase: "blocked_schema" } as never),
    ).toThrow(DatabaseMode.DatabaseModeWriteRefused)
  })
})

const seedIncompatible = (filename: string) => {
  const db = new BunDatabase(filename, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
  db.run("CREATE TABLE database_capability (capability TEXT PRIMARY KEY, minimum_reader_protocol INTEGER, minimum_writer_protocol INTEGER)")
  db.run("INSERT INTO migration VALUES ('seed-a', 1)")
  db.run("INSERT INTO database_capability VALUES ('future_v2', 4, 4)")
  db.close()
}

/** Fully migrate a fresh DB, then leave a recovery_required upgrade run so bootstrap resolves to read_only_recovery. */
const seedRecoveryRequired = (filename: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const run = yield* DatabaseUpgradeRun.beginRun(db, {
        sourceRegistryDigest: "source",
        targetRegistryDigest: DatabaseUpgradeRun.registryDigest(migrations),
        sourceProtocol: { reader: "2", writer: "2" },
        targetProtocol: { reader: "3", writer: "3" },
        buildIdentity: "build-1",
        packageVersion: "2.0.0-alpha.0",
        pendingMigrationIds: migrations.map((m) => m.id),
        totalMigrations: migrations.length,
      })
      yield* DatabaseUpgradeRun.advanceRun(db, run.runId, "backup_verified")
      yield* DatabaseUpgradeRun.failRun(db, run.runId, "upgrade_run_explicit_recovery")
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )

describe("database startup mode enforcement (C1A-12)", () => {
  test("blocked_schema: the writable business layer refuses (typed) and never admits business SQL", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blocked.db")
    seedIncompatible(filename)

    const bootState = await Database.bootstrap(filename)
    expect(bootState.mode).toBe("blocked_schema")
    expect(bootState.ready).toBe(false)

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return db
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.flip),
    )
    expect(error).toBeInstanceOf(DatabaseBootstrapError)
    const refusal = error as DatabaseBootstrapError
    expect(refusal.state.mode).toBe("blocked_schema")
    expect(refusal.state.ready).toBe(false)

    // The DB is untouched (no migration ran on it).
    const after = new BunDatabase(filename, { readonly: true })
    expect(after.query("SELECT id FROM migration ORDER BY id").all()).toEqual([{ id: "seed-a" }])
    after.close()
  }, 60_000)

  test("read_only_recovery: writable refused, browse/export allowed, provider refused", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "recovery.db")
    await seedRecoveryRequired(filename)

    const bootState = await Database.bootstrap(filename)
    expect(bootState.mode).toBe("read_only_recovery")
    expect(bootState.ready).toBe(false)

    // The writable layer refuses admission.
    const writable = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return db
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.flip),
    )
    expect(writable).toBeInstanceOf(DatabaseBootstrapError)
    expect((writable as DatabaseBootstrapError).state.mode).toBe("read_only_recovery")

    // The read-only maintenance opener allows browse/export...
    const readOnly = await Effect.runPromise(
      Effect.gen(function* () {
        const { db, mode } = yield* Database.Service
        const sessionCount = yield* db.all<{ c: number }>("SELECT count(*) AS c FROM session")
        return { mode: mode!.mode, sessionCount: sessionCount[0]!.c }
      }).pipe(Effect.provide(Database.readOnlyLayerFromPath(filename)), Effect.scoped, Effect.exit),
    )
    expect(readOnly._tag).toBe("Success")
    if (readOnly._tag === "Success") {
      expect(readOnly.value.mode).toBe("read_only_recovery")
      expect(readOnly.value.sessionCount).toBe(0)
    }

    // ...but a write is physically fenced (query_only) and the typed guard refuses provider/mutating tool.
    const writeAttempt = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run("CREATE TABLE probe (id INTEGER)")
        return "written"
      }).pipe(Effect.provide(Database.readOnlyLayerFromPath(filename)), Effect.scoped, Effect.exit),
    )
    expect(writeAttempt._tag).toBe("Failure")

    expect(() => DatabaseMode.assertWritable(snapshot(bootState))).toThrow(DatabaseMode.DatabaseModeWriteRefused)
    expect(() => DatabaseMode.assertProviderAllowed(snapshot(bootState))).toThrow(
      DatabaseMode.DatabaseModeWriteRefused,
    )
  }, 60_000)
})
