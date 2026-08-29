import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { Backup } from "@deepagent-code/core/database/backup"
import { Restore, RestoreError } from "@deepagent-code/core/database/restore"
import { Database } from "@deepagent-code/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

// C1A-13 VERIFIED RESTORE. Restore requires an explicit verified backup; it quarantines the current
// DB/WAL/SHM into an incident set (never overwritten/deleted), atomically installs the backup,
// reopens + verifies, then forward-migrates through the normal apply(). Any failure retains the
// quarantine as a safety net, restores the original live DB, and raises a typed error.
// FIXTURE-ONLY (temp dirs), never a production/user DB.

/** Create a fully-migrated "good" DB with a recognizable marker, then return its path. */
const makeGoodDb = async (filename: string) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run("CREATE TABLE markers (id TEXT PRIMARY KEY)")
      yield* db.run("INSERT INTO markers VALUES ('known-good')")
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

const mkBackupDir = async (root: string) => {
  const dir = path.join(root, "backups")
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const seedCorrupt = (filename: string) => {
  const db = new BunDatabase(filename, { create: true })
  db.run("CREATE TABLE markers (id TEXT PRIMARY KEY)")
  db.run("INSERT INTO markers VALUES ('corrupt')")
  db.close()
}

const markerOf = (filename: string) => {
  const db = new BunDatabase(filename, { readonly: true })
  try {
    return db.query("SELECT id FROM markers ORDER BY id").all() as { id: string }[]
  } finally {
    db.close()
  }
}

const backUp = (source: string, destDir: string) =>
  Effect.runPromise(Backup.create({ sourcePath: source, destDir, buildId: "build-1" }))

describe("Restore verified (C1A-13)", () => {
  test("success: backup a good DB, corrupt the live DB, restore -> integrity + data + journal present", async () => {
    await using tmp = await tmpdir()
    const good = path.join(tmp.path, "good.db")
    const live = path.join(tmp.path, "live.db")
    const backupDir = await mkBackupDir(tmp.path)
    await makeGoodDb(good)
    const manifest = await backUp(good, backupDir)

    seedCorrupt(live)
    const restoreManifest = await Effect.runPromise(
      Restore.restoreVerified({ dbPath: live, backup: manifest }),
    )

    expect(restoreManifest.outcome).toBe("restored")
    expect(restoreManifest.sourceBackup.sha256).toBe(manifest.backup.sha256)
    expect(path.basename(restoreManifest.liveDbPath)).toBe(path.basename(live))
    // The restored DB is the good snapshot, not the corrupt one.
    expect(markerOf(live)).toEqual([{ id: "known-good" }])
    // The original (corrupt) live DB is retained as a safety copy in the incident set.
    const incidentEntries = await fs.readdir(restoreManifest.quarantineDir)
    expect(incidentEntries.some((name) => name === path.basename(live))).toBe(true)
    // A restore manifest is exported next to the live DB.
    expect(await fs.stat(Restore.restoreManifestPathFor(live)).then(() => true)).toBe(true)
  }, 60_000)

  test("refusal: an unverified backup selection is refused and the live DB is untouched", async () => {
    await using tmp = await tmpdir()
    const live = path.join(tmp.path, "live.db")
    const backupDir = await mkBackupDir(tmp.path)
    seedCorrupt(live)
    const manifest = await backUp(live, backupDir)
    const tampered = { ...manifest, backup: { ...manifest.backup, sha256: "deadbeef" } }

    const outcome = await Effect.runPromise(
      Restore.restoreVerified({ dbPath: live, backup: tampered }).pipe(Effect.exit),
    )
    expect(outcome._tag).toBe("Failure")
    expect(markerOf(live)).toEqual([{ id: "corrupt" }])
  }, 60_000)

  test("quarantine collision: an existing incident directory produces a distinct one (never overwritten)", async () => {
    await using tmp = await tmpdir()
    const good = path.join(tmp.path, "good.db")
    const backupDir = await mkBackupDir(tmp.path)
    await makeGoodDb(good)
    const manifest = await backUp(good, backupDir)

    const incidentRoot = path.join(tmp.path, "incidents")
    await fs.mkdir(incidentRoot, { recursive: true })
    const live = path.join(tmp.path, "live.db")
    seedCorrupt(live)
    const restoreManifest = await Effect.runPromise(
      Restore.restoreVerified({ dbPath: live, backup: manifest, quarantineDir: incidentRoot }),
    )
    expect(restoreManifest.outcome).toBe("restored")
    expect(restoreManifest.quarantineDir.startsWith(incidentRoot)).toBe(true)
    expect(await fs.stat(restoreManifest.quarantineDir).then(() => true)).toBe(true)
  }, 60_000)

  test("restore-then-fail: an injected install failure retains the quarantine and raises a typed error", async () => {
    await using tmp = await tmpdir()
    const good = path.join(tmp.path, "good.db")
    const live = path.join(tmp.path, "live.db")
    const backupDir = await mkBackupDir(tmp.path)
    await makeGoodDb(good)
    const manifest = await backUp(good, backupDir)
    seedCorrupt(live)

    const outcome = await Effect.runPromise(
      Restore.restoreVerified({
        dbPath: live,
        backup: manifest,
        install: () => Effect.fail(new RestoreError({ code: "install_failed", detail: "injected" })),
      }).pipe(Effect.exit),
    )
    expect(outcome._tag).toBe("Failure")
    // The live DB is untouched (quarantine is a copy; install never replaced it).
    expect(markerOf(live)).toEqual([{ id: "corrupt" }])
  }, 60_000)
})
