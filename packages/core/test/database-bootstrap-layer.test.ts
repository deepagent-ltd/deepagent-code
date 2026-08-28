import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseBootstrapError } from "@deepagent-code/core/database/bootstrap"
import { tmpdir } from "./fixture/tmpdir"

// C1A-01/C1A-02 end-to-end: the business Database layer runs read-only preflight
// first and fails closed (no business admission) when the DB is incompatible,
// rejecting the binary BEFORE migration runs.

describe("Database.layer bootstrap separation", () => {
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
})
