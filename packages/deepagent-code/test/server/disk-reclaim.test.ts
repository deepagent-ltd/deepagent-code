import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DiskReclaim } from "../../src/server/disk-reclaim"
import { MigrationOrchestrator } from "../../src/server/migration-orchestrator"
import { tmpdir } from "../fixture/fixture"

// W-02 M-5 acceptance (design §3.3/§3.4): the whole data root is measured and classified; residue
// candidates are safety-checked against manifest references; NOTHING is deleted without
// confirm:true; restore-incidents/ is never touched (red line, asserted); the report carries exact
// before/after byte counts (MiB rendered); the optional VACUUM runs only with confirm.

type DatabaseService = Database.Interface["db"]

const exists = async (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)

describe("DiskReclaim (W-02 M-5)", () => {
  test("inventory + confirm gate: without confirm nothing is deleted; with confirm residue goes", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "store", "deepagent-code.db")
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await Effect.runPromise(Effect.gen(function* () {
      yield* Database.Service.pipe(Effect.scoped)
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.ignore))
    const backupDir = path.join(tmp.path, "store", "backups")
    await fs.mkdir(backupDir, { recursive: true })
    await Bun.write(path.join(backupDir, "keep.db"), "consistency backup")
    // Operational residue in the store directory + the red-line incident set.
    await Bun.write(path.join(tmp.path, "store", "repro.db"), "repro residue")
    await Bun.write(path.join(tmp.path, "store", "old.bak"), "bak residue")
    await Bun.write(path.join(tmp.path, "store", "deepagent-code-other.db"), "other live channel db")
    await Bun.write(path.join(tmp.path, "store", "deepagent-code-repro.db"), "repro live channel db")
    await fs.mkdir(path.join(tmp.path, "store", "restore-incidents"), { recursive: true })
    await Bun.write(path.join(tmp.path, "store", "restore-incidents", "incident-1.db"), "incident copy")
    await fs.mkdir(path.join(tmp.path, "cache"), { recursive: true })
    await Bun.write(path.join(tmp.path, "cache", "operational.bin"), "operational data")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service

        // No confirm: a candidate inventory only — every file still on disk.
        const dry = yield* DiskReclaim.reclaim({ db, dbPath: filename, backupDir, dataRoot: tmp.path })
        expect(dry.executed).toBe(false)
        expect(dry.reclaimedBytes).toBe(0)
        const dryCandidates = new Map(dry.candidates.map((candidate) => [path.basename(candidate.path), candidate]))
        expect([...dryCandidates.keys()].sort()).toEqual(["old.bak", "repro.db"])
        expect([...dryCandidates.values()].every((candidate) => candidate.safe && !candidate.deleted)).toBe(true)
        // The full measurement classified the data root.
        const categories = new Map(dry.inventory.map((entry) => [entry.category, entry]))
        expect(categories.get("main_db")?.path).toBe(path.resolve(filename))
        expect(categories.get("restore_incident")?.note).toContain("NEVER deleted")
        expect(categories.has("operational")).toBe(true)
        expect(categories.get("backup")?.path).toContain(path.join("backups", "keep.db"))
        expect(dry.beforeMiB).toMatch(/MiB$/)

        // The user confirms: residue is deleted, everything protected survives.
        const executed = yield* DiskReclaim.reclaim({
          db,
          dbPath: filename,
          backupDir,
          dataRoot: tmp.path,
          confirm: true,
        })
        expect(executed.executed).toBe(true)
        expect(executed.reclaimedBytes).toBe("repro residue".length + "bak residue".length)
        expect(executed.candidates.filter((candidate) => candidate.deleted).map((candidate) => path.basename(candidate.path)).sort()).toEqual([
          "old.bak",
          "repro.db",
        ])
        // Exact before/after accounting.
        expect(executed.totalBytesBefore - executed.totalBytesAfter).toBe(executed.reclaimedBytes)
        expect(executed.afterMiB).toMatch(/MiB$/)

        // RED LINE: the incident set is byte-identical and untouched.
        expect(executed.restoreIncidentsBytes).toBe("incident copy".length)
        expect(executed.restoreIncidentsNeverDeleted).toBe(true)
        expect(yield* Effect.promise(() => exists(path.join(tmp.path, "store", "restore-incidents", "incident-1.db")))).toBe(true)
        // The live db, its sidecars, operational data and the backups root survive.
        expect(yield* Effect.promise(() => exists(filename))).toBe(true)
        expect(yield* Effect.promise(() => exists(path.join(tmp.path, "store", "deepagent-code-other.db")))).toBe(true)
        expect(yield* Effect.promise(() => exists(path.join(tmp.path, "store", "deepagent-code-repro.db")))).toBe(true)
        expect(yield* Effect.promise(() => exists(path.join(tmp.path, "cache", "operational.bin")))).toBe(true)
        // The report persisted under the backups root.
        const stored = yield* Effect.promise(() => Bun.file(DiskReclaim.reportPathFor(backupDir)).json())
        expect(stored.kind).toBe("disk-reclaim-report")
        expect(stored.executed).toBe(true)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("safety oracle: a file referenced by a backup manifest is blocked even when it looks like residue", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "store", "deepagent-code.db")
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await Effect.runPromise(Effect.gen(function* () {
      yield* Database.Service
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.ignore))
    const backupDir = path.join(tmp.path, "store", "backups")
    await fs.mkdir(backupDir, { recursive: true })
    // A .bak-looking file that a backup manifest legitimately references as its source.
    const referenced = path.join(tmp.path, "store", "manual.bak")
    await Bun.write(referenced, "referenced by a manifest")
    await Bun.write(
      path.join(backupDir, "b.db.manifest.json"),
      JSON.stringify({
        version: 1,
        backup: { fileName: "b.db", filePath: path.join(backupDir, "b.db"), sizeBytes: 1, sha256: "s", createdAt: 0 },
        source: { filePath: referenced, sizeBytes: 1, mtimeMs: 0, journalMode: "wal", synchronous: 2, pageCount: 1, pageSize: 4096, dbLogicalSizeBytes: 4096, walSizeBytes: 0, appliedMigrationIds: [], migrationCount: 0, schemaDigest: "d", capability: [] },
        build: { buildId: "t", registryDigest: "r" },
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const report = yield* DiskReclaim.reclaim({ db, dbPath: filename, backupDir, dataRoot: tmp.path, confirm: true })
        const blocked = report.candidates.find((candidate) => candidate.path === referenced)
        expect(blocked?.safe).toBe(false)
        expect(blocked?.blockedReason).toBe("referenced by a backup manifest")
        expect(blocked?.deleted).toBe(false)
        // Failure injection acceptance: the referenced file survived execution.
        expect(yield* Effect.promise(() => exists(referenced))).toBe(true)
        expect(report.reclaimedBytes).toBe(0)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("advisory input: M-2 disk advisory residue candidates feed the reclaim list", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "store", "deepagent-code.db")
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await Effect.runPromise(Effect.gen(function* () {
      yield* Database.Service
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.ignore))
    const backupDir = path.join(tmp.path, "store", "backups")
    await fs.mkdir(backupDir, { recursive: true })
    await Bun.write(path.join(tmp.path, "store", "advisory-only.bak"), "advisory listed")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        // Stage the chain through disk_advisory so the advisory exists and lists the residue.
        const staged = yield* MigrationOrchestrator.run({
          db,
          dbPath: filename,
          backupDir,
          backupFileName: "advisory",
          stopAfter: "disk_advisory",
        })
        // A staged stop leaves the journal in_progress with every phase up to disk_advisory done.
        expect(staged.status).toBe("in_progress")
        expect(
          staged.journal.phases.findLast((record) => record.phase === "disk_advisory")?.state,
        ).toBe("completed")

        const report = yield* DiskReclaim.reclaim({ db, dbPath: filename, backupDir, dataRoot: tmp.path })
        const candidate = report.candidates.find((item) => item.path.endsWith("advisory-only.bak"))
        expect(candidate?.fromAdvisory).toBe(true)
        expect(candidate?.safe).toBe(true)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  // Cross-review F-2 regression: a tampered/corrupted advisory must never widen the delete
  // set — advisory-sourced paths are re-validated against the live-scan containment rules.
  test("a tampered advisory listing an arbitrary outside path is refused", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "store", "deepagent-code.db")
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await Effect.runPromise(Effect.gen(function* () {
      yield* Database.Service
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.ignore))
    const backupDir = path.join(tmp.path, "store", "backups")
    await fs.mkdir(backupDir, { recursive: true })
    const victim = path.join(tmp.path, "precious.txt")
    await Bun.write(victim, "must survive")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        // Stage a real chain through disk_advisory, then TAMPER the advisory it produced:
        // a corrupted or hand-edited advisory listing an arbitrary outside path.
        yield* MigrationOrchestrator.run({
          db,
          dbPath: filename,
          backupDir,
          backupFileName: "tampered",
          stopAfter: "disk_advisory",
        })
        const journal = yield* MigrationOrchestrator.readJournal(MigrationOrchestrator.journalPathFor(backupDir))
        const advisoryPath = journal?.phases.findLast(
          (record) => record.phase === "disk_advisory" && record.state === "completed",
        )?.outcome
        if (advisoryPath?.kind !== "disk_advisory") throw new Error("advisory not staged")
        const advisory = (yield* Effect.promise(() => Bun.file(advisoryPath.advisoryPath).json())) as {
          entries: { category?: string; path?: string }[]
        }
        advisory.entries.push({ category: "residue_candidate", path: victim })
        yield* Effect.promise(() => Bun.write(advisoryPath.advisoryPath, JSON.stringify(advisory)))

        const report = yield* DiskReclaim.reclaim({ db, dbPath: filename, backupDir, dataRoot: tmp.path, confirm: true })
        expect(report.candidates.find((item) => item.path === victim)).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(victim).text())).toBe("must survive")
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("VACUUM: runs only with confirm and is recorded", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "store", "deepagent-code.db")
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await Effect.runPromise(Effect.gen(function* () {
      yield* Database.Service
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.ignore))
    const backupDir = path.join(tmp.path, "store", "backups")
    await fs.mkdir(backupDir, { recursive: true })

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const noConfirm = yield* DiskReclaim.reclaim({ db, dbPath: filename, backupDir, dataRoot: tmp.path, vacuum: true })
        expect(noConfirm.vacuumed).toBe(false)
        const vacuumed = yield* DiskReclaim.reclaim({ db, dbPath: filename, backupDir, dataRoot: tmp.path, confirm: true, vacuum: true })
        expect(vacuumed.vacuumed).toBe(true)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })
})
