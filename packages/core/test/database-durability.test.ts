import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { Database } from "@deepagent-code/core/database/database"
import { Backup, type BackupManifest } from "@deepagent-code/core/database/backup"
import { BackupVerify, type BackupVerification } from "@deepagent-code/core/database/backup-verify"
import { Effect } from "effect"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

// C1A-10 authority DB durability (design §10.6): the Beta authority DB default is WAL +
// synchronous=FULL, and migration/backup/recovery connections must never be at NORMAL. FULL fsyncs
// every commit to the WAL so a power-loss/crash cannot lose an acknowledged receipt or migration.
//
// Oracle: on base the authority DB is opened at synchronous=NORMAL (1), so the `synchronous === 2`
// assertion FAILS on base and PASSES after the change. The backup/verify connections are separate
// read-only connections; they must be at FULL (2), never NORMAL.

const isOk = (v: BackupVerification): v is Extract<BackupVerification, { ok: true }> => v.ok === true

describe("Database durability (C1A-10)", () => {
  test("the authority DB opens at WAL + synchronous=FULL through the real open path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "dur.db")

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const sync = yield* db.all<{ synchronous: number }>("PRAGMA synchronous")
        const journal = yield* db.all<{ journal_mode: string }>("PRAGMA journal_mode")
        return { synchronous: sync[0]?.synchronous, journalMode: journal[0]?.journal_mode }
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )

    expect(outcome.journalMode).toBe("wal")
    expect(outcome.synchronous).toBe(2) // FULL
  }, 60_000)

  test("backup and verify connections stay at synchronous=FULL, never NORMAL", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "dur.db")

    // Build a real migrated authority DB (the production open path).
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Database.Service
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )

    // Back up on a separate read-only connection; its synchronous value must be FULL (2), never NORMAL.
    const manifest: BackupManifest = await Effect.runPromise(
      Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x" }),
    )
    expect(manifest.source.synchronous).toBe(2)

    const verdict = await Effect.runPromise(BackupVerify.verify(manifest))
    expect(isOk(verdict)).toBe(true)
    if (isOk(verdict)) expect(verdict.synchronous).toBe(2)
  }, 60_000)
})
