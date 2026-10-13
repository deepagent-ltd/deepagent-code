import { describe, expect, test } from "bun:test"
import { Effect, Cause } from "effect"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { layer } from "@deepagent-code/core/database/sqlite.bun"
import { tmpdir } from "./fixture/tmpdir"

describe("cold upgrade preflight", () => {
  test("backs up a DELETE database before enabling WAL and migrating", async () => {
    await using tmp = await tmpdir()
    const filename = tmp.path + "/cold.db"
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run("PRAGMA foreign_keys = ON")
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, -1))
        yield* db.run("CREATE TABLE cold_upgrade_sentinel (id TEXT PRIMARY KEY, value TEXT NOT NULL)")
        yield* db.run("INSERT INTO cold_upgrade_sentinel VALUES ('original', '原始业务内容')")
      }).pipe(Effect.provide(layer({ filename, disableWAL: true })), Effect.scoped),
    )
    const before = await readColdStore(filename)
    expect(before.journalMode).toBe("delete")
    expect(before.migrationIDs).toEqual(migrations.slice(0, -1).map((migration) => migration.id).sort())
    expect(await Database.bootstrap(filename)).toMatchObject({ ready: true, phase: "backup_required" })

    const result = await Effect.runPromise(
      Database.Service.pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.exit),
    )
    if (result._tag === "Failure") console.error(Cause.pretty(result.cause))
    expect(result._tag).toBe("Success")
    const after = await readColdStore(filename)
    expect(after.sentinel).toEqual(before.sentinel)
    expect(after.migrationIDs).toEqual(migrations.map((migration) => migration.id).sort())
    expect(await Database.bootstrap(filename)).toMatchObject({ ready: true, phase: "ready" })
    const backupFiles = await Array.fromAsync(new Bun.Glob("*.db").scan(tmp.path + "/backups"))
    expect(backupFiles).toHaveLength(1)
    const backup = await readColdStore(tmp.path + "/backups/" + backupFiles[0])
    expect(backup.sentinel).toEqual(before.sentinel)
    expect(backup.migrationIDs).toEqual(before.migrationIDs)
  }, 60_000)
})

async function readColdStore(filename: string) {
  const { Database } = await import("bun:sqlite")
  const db = new Database(filename, { readonly: true, create: false })
  try {
    return {
      journalMode: db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
      migrationIDs: db.query<{ id: string }, []>("SELECT id FROM migration ORDER BY id").all().map((row) => row.id),
      sentinel: db.query("SELECT * FROM cold_upgrade_sentinel ORDER BY id").all(),
    }
  } finally {
    db.close()
  }
}
