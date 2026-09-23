import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { Cause, Effect, Exit } from "effect"
import { Backup } from "@deepagent-code/core/database/backup"
import { BackupGovernor } from "../../src/server/backup-governor"
import { MigrationOrchestrator } from "../../src/server/migration-orchestrator"
import { tmpdir } from "../fixture/fixture"

// W-02 M-4 acceptance (design §3.3/§3.4): retention keeps the newest N backups plus every
// migration-milestone backup; over-aged backups are gzip-compressed and MOVED into archive/
// (never silently deleted — the report records every action); retained manifests are stamped
// with the md-export pairing (BackupManifest.mdExports); governance is idempotent.

async function makeBackup(destDir: string, fileName: string, payload: string, createdOffsetMs: number) {
  await fs.mkdir(destDir, { recursive: true })
  const filePath = path.join(destDir, `${fileName}.db`)
  await Bun.write(filePath, payload)
  await Bun.write(
    `${filePath}.manifest.json`,
    `${JSON.stringify(
      {
        version: 1,
        backup: {
          fileName: `${fileName}.db`,
          filePath,
          sizeBytes: payload.length,
          sha256: createHash("sha256").update(payload).digest("hex"),
          createdAt: Date.now() + createdOffsetMs,
        },
        source: {
          filePath: "/source/live.db",
          sizeBytes: payload.length,
          mtimeMs: 0,
          journalMode: "wal",
          synchronous: 2,
          pageCount: 1,
          pageSize: 4096,
          dbLogicalSizeBytes: 4096,
          walSizeBytes: 0,
          appliedMigrationIds: [],
          migrationCount: 0,
          schemaDigest: "digest",
          capability: [],
        },
        build: { buildId: "test", registryDigest: "registry" },
      },
      null,
      2,
    )}\n`,
  )
  return filePath
}

const readManifest = async (manifestPath: string) => (await Bun.file(manifestPath).json()) as Backup.BackupManifest

describe("BackupGovernor (W-02 M-4)", () => {
  test("retention: keeps the newest N, archives the over-aged by gzip+move, stamps mdExports", async () => {
    await using tmp = await tmpdir()
    const backupDir = path.join(tmp.path, "backups")
    // Five backups at increasing age (b1 oldest); keep=2 → b4/b5 kept, b1..b3 archived.
    await makeBackup(backupDir, "b1", "backup-one", 1_000)
    await makeBackup(backupDir, "b2", "backup-two", 2_000)
    await makeBackup(backupDir, "b3", "backup-three", 3_000)
    await makeBackup(backupDir, "b4", "backup-four", 4_000)
    await makeBackup(backupDir, "b5", "backup-five", 5_000)

    const report = await Effect.runPromise(BackupGovernor.govern({ backupDir, keep: 2 }))
    expect(report.version).toBe(1)
    expect(report.kind).toBe("backup-governance-report")
    expect(report.policy).toEqual({ keep: 2, milestoneRule: "migration-archive" })

    const byName = new Map(report.backups.map((entry) => [entry.fileName, entry]))
    expect(byName.get("b4.db")?.action).toBe("kept")
    expect(byName.get("b5.db")?.action).toBe("kept")
    expect(byName.get("b1.db")?.action).toBe("archived")
    expect(byName.get("b2.db")?.action).toBe("archived")
    expect(byName.get("b3.db")?.action).toBe("archived")
    expect(report.archivedCount).toBe(3)
    expect(report.archivedBytes).toBe("backup-one".length + "backup-two".length + "backup-three".length)

    // Archived = compressed + moved, not deleted: the gzip round-trips to the original bytes.
    const restored = gunzipSync(await Bun.file(path.join(backupDir, "archive", "b1.db.gz")).bytes())
    expect(new TextDecoder().decode(restored)).toBe("backup-one")
    // The originals are gone from the live root, their manifests moved beside the archives.
    for (const name of ["b1", "b2", "b3"]) {
      await expect(fs.access(path.join(backupDir, `${name}.db`))).rejects.toThrow()
      await expect(fs.access(path.join(backupDir, `${name}.db.manifest.json`))).rejects.toThrow()
      await fs.access(path.join(backupDir, "archive", `${name}.db.manifest.json`))
    }
    // Kept manifests still live at the live root (the restore surface is unchanged).
    await fs.access(path.join(backupDir, "b4.db.manifest.json"))

    // The governance report persisted.
    const stored = await Bun.file(BackupGovernor.reportPathFor(backupDir)).json()
    expect(stored.kind).toBe("backup-governance-report")
  })

  test("a mismatched archive round-trip leaves the original backup and manifest in place", async () => {
    await using tmp = await tmpdir()
    const backupDir = path.join(tmp.path, "backups")
    const original = await makeBackup(backupDir, "old", "original bytes", 1_000)
    await makeBackup(backupDir, "new", "new bytes", 2_000)
    const manifestPath = `${original}.manifest.json`
    const manifest = await readManifest(manifestPath)
    await Bun.write(manifestPath, JSON.stringify({
      ...manifest,
      backup: { ...manifest.backup, sha256: "0".repeat(64) },
    }))

    const failure = await Effect.runPromise(Effect.flip(BackupGovernor.govern({ backupDir, keep: 1 })))
    expect(failure).toMatchObject({ _tag: "BackupGovernor.BackupGovernorError", code: "archive_failed" })
    expect(await Bun.file(original).text()).toBe("original bytes")
    expect(await Bun.file(manifestPath).exists()).toBeTrue()
  })

  test("milestones: a migration archive record shields its backup from retention eviction", async () => {
    await using tmp = await tmpdir()
    const backupDir = path.join(tmp.path, "backups")
    await makeBackup(backupDir, "old-milestone", "milestone bytes", 1_000)
    await makeBackup(backupDir, "plain-old", "plain old", 2_000)
    await makeBackup(backupDir, "fresh", "fresh bytes", 3_000)
    // An M-2 archive record references the OLDEST backup as its pre-migration restore point.
    await fs.mkdir(path.join(backupDir, "migration-archive"), { recursive: true })
    await Bun.write(
      path.join(backupDir, "migration-archive", "mo_test.json"),
      JSON.stringify({
        version: 1,
        kind: "migration-archive",
        orchestrationId: "mo_test",
        dbPath: "/source/live.db",
        startedAt: 0,
        completedAt: 1,
        backup: { manifestPath: path.join(backupDir, "old-milestone.db.manifest.json"), sha256: "sha-old-milestone", sizeBytes: 15 },
      }),
    )

    const report = await Effect.runPromise(BackupGovernor.govern({ backupDir, keep: 1 }))
    const byName = new Map(report.backups.map((entry) => [entry.fileName, entry]))
    // keep=1 keeps `fresh`; the milestone bypasses the count and survives; `plain-old` archives.
    expect(byName.get("fresh.db")).toMatchObject({ action: "kept", milestone: false })
    expect(byName.get("old-milestone.db")).toMatchObject({ action: "kept", milestone: true })
    expect(byName.get("plain-old.db")?.action).toBe("archived")
    await fs.access(path.join(backupDir, "old-milestone.db"))
  })

  test("mdExports: retained manifests record the md-export manifest path", async () => {
    await using tmp = await tmpdir()
    const backupDir = path.join(tmp.path, "backups")
    await makeBackup(backupDir, "only", "only backup", 1_000)
    // An M-1 md export manifest exists under the same root.
    await fs.mkdir(path.join(backupDir, "md"), { recursive: true })
    await Bun.write(
      path.join(backupDir, "md", "manifest.json"),
      JSON.stringify({ version: 1, kind: "md-export-manifest", sourceDatabase: "x", createdAt: 0, updatedAt: 0, entries: [] }),
    )

    const report = await Effect.runPromise(BackupGovernor.govern({ backupDir }))
    expect(report.mdExports).toEqual([path.join(backupDir, "md", "manifest.json")])
    const manifest = await readManifest(path.join(backupDir, "only.db.manifest.json"))
    expect(manifest.mdExports).toEqual([path.join(backupDir, "md", "manifest.json")])
  })

  test("idempotent: a second govern run is a no-op over the already-governed root", async () => {
    await using tmp = await tmpdir()
    const backupDir = path.join(tmp.path, "backups")
    await makeBackup(backupDir, "a", "aaa", 1_000)
    await makeBackup(backupDir, "b", "bbb", 2_000)
    await makeBackup(backupDir, "c", "ccc", 3_000)

    const first = await Effect.runPromise(BackupGovernor.govern({ backupDir, keep: 1 }))
    expect(first.archivedCount).toBe(2)
    const second = await Effect.runPromise(BackupGovernor.govern({ backupDir, keep: 1 }))
    expect(second.archivedCount).toBe(0)
    expect(second.backups.map((entry) => entry.fileName)).toEqual(["c.db"])
    // Nothing new landed in archive/.
    expect((await fs.readdir(path.join(backupDir, "archive"))).sort()).toEqual([
      "a.db.gz",
      "a.db.manifest.json",
      "b.db.gz",
      "b.db.manifest.json",
    ])
  })

  // Cross-review F-3 regression: a mid-stream archive failure (unreadable source) surfaces as
  // the typed archive_failed error instead of an unhandled stream 'error' event crashing the
  // maintenance process; the original backup is left in place.
  test("an unreadable archive source fails typed, never crashes, and keeps the original", async () => {
    await using tmp = await tmpdir()
    const backupDir = path.join(tmp.path, "backups")
    await makeBackup(backupDir, "kept", "newest", 0)
    await makeBackup(backupDir, "broken", "older", -10 * 60_000)
    // Corrupt the source: replace the over-aged backup FILE with a directory — the read stream
    // cannot open it and errors mid-chain.
    await fs.rm(path.join(backupDir, "broken.db"))
    await fs.mkdir(path.join(backupDir, "broken.db"))

    const outcome = await Effect.runPromiseExit(BackupGovernor.govern({ backupDir, keep: 1 }))
    expect(Exit.isFailure(outcome)).toBe(true)
    if (Exit.isFailure(outcome)) expect(Cause.pretty(outcome.cause)).toContain("BackupGovernorError")
    // The corrupted source was never moved away (a partial destination artifact is
    // acceptable; the original staying in place is the interruption-safety contract).
    expect((await fs.stat(path.join(backupDir, "broken.db")).catch(() => undefined))?.isDirectory()).toBe(true)
  })

  test("invalid policy: keep < 1 is refused", async () => {
    await using tmp = await tmpdir()
    const failure = await Effect.runPromise(Effect.flip(BackupGovernor.govern({ backupDir: tmp.path, keep: 0 })))
    expect(failure.code).toBe("invalid_policy")
  })
})

describe("BackupGovernor with a real chain (M-2 integration)", () => {
  test("a completed orchestration's backup is a milestone after govern", async () => {
    await using tmp = await tmpdir()
    const backupDir = path.join(tmp.path, "backups")
    // Simulate the archive-record path a completed M-2 chain writes, referencing a real manifest.
    await makeBackup(backupDir, "chain", "chain backup", 1_000)
    await makeBackup(backupDir, "newer", "newer backup", 2_000)
    await fs.mkdir(path.join(backupDir, "migration-archive"), { recursive: true })
    await Bun.write(
      path.join(backupDir, "migration-archive", "mo_chain.json"),
      JSON.stringify({
        version: 1,
        kind: "migration-archive",
        orchestrationId: "mo_chain",
        dbPath: "/source/live.db",
        startedAt: 0,
        completedAt: 1,
        backup: { manifestPath: path.join(backupDir, "chain.db.manifest.json"), sha256: "sha-chain", sizeBytes: 12 },
      }),
    )
    // Journal files under the root must not be mistaken for backups (no .manifest.json suffix).
    await Bun.write(MigrationOrchestrator.journalPathFor(backupDir), JSON.stringify({ version: 1, kind: "migration-orchestration-journal" }))

    const report = await Effect.runPromise(BackupGovernor.govern({ backupDir, keep: 1 }))
    expect(report.backups.find((entry) => entry.fileName === "chain.db")?.action).toBe("kept")
  })
})
