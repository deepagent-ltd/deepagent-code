import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import { Effect, Exit, Layer, Scope } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseBootstrapError } from "@deepagent-code/core/database/bootstrap"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { tmpdir } from "./fixture/tmpdir"

// C1A-01/C1A-02 end-to-end: the business Database layer runs read-only preflight
// first and fails closed (no business admission) when the DB is incompatible,
// rejecting the binary BEFORE migration runs.

describe("Database.layer bootstrap separation", () => {
  test("a required backup failure becomes a typed blocked-schema state before migration", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "backup-failure.db")
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Database.Service
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
    const latest = migrations.at(-1)!.id
    const seeded = new BunDatabase(filename)
    seeded.query("DELETE FROM migration WHERE id = ?").run(latest)
    seeded.close()
    await Bun.write(path.join(tmp.path, "backups"), "not a directory")
    expect(await Database.bootstrap(filename)).toMatchObject({ mode: "ready", phase: "backup_required" })

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Database.Service
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.flip),
    )
    expect(error).toBeInstanceOf(DatabaseBootstrapError)
    if (error instanceof DatabaseBootstrapError)
      expect(error.state).toMatchObject({
        mode: "blocked_schema",
        phase: "blocked_schema",
        diagnostics: { stableCode: "backup_failed" },
      })
    const untouched = new BunDatabase(filename, { readonly: true })
    expect(untouched.query("SELECT id FROM migration WHERE id = ?").get(latest)).toBeNull()
    untouched.close()
  }, 60_000)

  test("fresh DB builds the business layer and migrates to ready", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "fresh.db")

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const tables = yield* db.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'",
        )
        const capabilities = yield* db.all<{ capability: string }>("SELECT capability FROM database_capability")
        return { tables, capabilities }
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.exit),
    )

    expect(outcome._tag).toBe("Success")
    if (outcome._tag === "Success") {
      expect(outcome.value.tables).toEqual([{ name: "session" }])
      expect(outcome.value.capabilities).toEqual([{ capability: "bounded_event_snapshot_v1" }])
    }
  }, 60_000)

  test("incompatible binary rejects BEFORE migration and never admits business SQL", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "incompatible.db")
    // Seed a DB that a future binary requires a protocol this runtime does not support.
    const db = new BunDatabase(filename, { create: true })
    db.run("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
    db.run("CREATE TABLE database_capability (capability TEXT PRIMARY KEY, minimum_reader_protocol INTEGER, minimum_writer_protocol INTEGER)")
    db.run("INSERT INTO migration VALUES ('seed-a', 1)")
    db.run("INSERT INTO database_capability VALUES ('future_v2', 4, 4)")
    db.close()

    // Capture the bootstrap failure: it must be a catchable DatabaseBootstrapError
    // carrying the blocked_schema phase and the incompatible_binary stable code.
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return db
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.flip),
    )

    expect(error).toBeInstanceOf(DatabaseBootstrapError)
    if (error instanceof DatabaseBootstrapError) {
      expect(error.state.phase).toBe("blocked_schema")
      expect(error.state.mode).toBe("blocked_schema")
      expect(error.state.ready).toBe(false)
      expect(error.state.diagnostics.stableCode).toBe("incompatible_binary")
      expect(error.state.diagnostics.message).toContain("requires reader 4")
    }

    // Proof the binary was rejected BEFORE migration: the journal is unchanged.
    const after = new BunDatabase(filename, { readonly: true })
    expect(after.query("SELECT id FROM migration ORDER BY id").all()).toEqual([{ id: "seed-a" }])
    after.close()
  }, 60_000)

  test("ordinary restart runs the durable startup inventory even when no migration is pending", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "startup-inventory.db")

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Database.Service
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )

    const corrupt = new BunDatabase(filename)
    corrupt.run("PRAGMA ignore_check_constraints = ON")
    corrupt.run("INSERT INTO event_sequence (aggregate_id, seq) VALUES ('aggregate-inventory', 0)")
    corrupt.run(`
      INSERT INTO event_snapshot_attempt (
        snapshot_id, aggregate_id, through_seq, expected_latest, codec, schema_version,
        projection_revision, row_count, encoded_bytes, content_hash, tables, state,
        created_at, updated_at
      ) VALUES (
        'snapshot-unclassified', 'aggregate-inventory', 0, 0, 'json', 1,
        'test', 0, 0, '${"0".repeat(64)}', '{}', 'teleported', 1, 1
      )
    `)
    corrupt.close()

    const state = await Database.bootstrap(filename)
    expect(state).toMatchObject({
      mode: "read_only_recovery",
      ready: false,
      diagnostics: {
        stableCode: "startup_inventory_unclassified",
        table: "compaction",
        key: "snapshot:snapshot-unclassified",
      },
    })

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Database.Service
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.flip),
    )
    expect(error).toBeInstanceOf(DatabaseBootstrapError)
    if (error instanceof DatabaseBootstrapError)
      expect(error.state.diagnostics.stableCode).toBe("startup_inventory_unclassified")
  }, 60_000)

  test("holds one runtime process owner for the full Database layer scope", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "runtime-owner.db")
    const firstScope = await Effect.runPromise(Scope.make())
    const secondScope = await Effect.runPromise(Scope.make())

    await Effect.runPromise(Layer.buildWithScope(Database.layerFromPath(filename), firstScope))
    expect(await Database.bootstrap(filename)).toMatchObject({
      mode: "read_only_recovery",
      ready: false,
      phase: "recovery_reconciling",
      diagnostics: { stableCode: "another_process_active" },
    })

    const contender = await Effect.runPromise(
      Layer.buildWithScope(Database.layerFromPath(filename), secondScope).pipe(Effect.exit),
    )
    expect(Exit.isFailure(contender)).toBe(true)
    if (Exit.isFailure(contender)) {
      const error = contender.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      expect(error).toBeInstanceOf(DatabaseBootstrapError)
      if (error instanceof DatabaseBootstrapError)
        expect(error.state.diagnostics.stableCode).toBe("another_process_active")
    }

    await Effect.runPromise(Scope.close(firstScope, Exit.void))
    expect((await Database.bootstrap(filename)).ready).toBe(true)
    await Effect.runPromise(Scope.close(secondScope, Exit.void))
  }, 60_000)
})
