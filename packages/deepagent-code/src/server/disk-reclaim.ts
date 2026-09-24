export * as DiskReclaim from "./disk-reclaim"

import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Data, Effect } from "effect"
import { Backup } from "@deepagent-code/core/database/backup"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { isResidue, MigrationOrchestrator, sizeOf, walk } from "./migration-orchestrator"

// W-02 M-5 (design §3.3) — disk reclaim. Codes the full measurement of the data root
// (~/.deepagent/code, resolved through Global.Path — never a hardcoded string) into an inventory,
// classifies deletion candidates, safety-checks them against every manifest/journal reference,
// and ONLY with an explicit user confirmation executes the deletion (plus an optional VACUUM of
// the main database). RED LINE (design §3.1 ruling / restore.ts): restore-incidents/ is NEVER
// deleted — it is excluded from candidates AND re-asserted after execution.
//
// Inputs: the M-2 disk advisory's residue_candidate list (from the orchestration journal) UNION a
// live re-scan of the store directory with the same residue patterns — the advisory may be stale,
// the filesystem is the truth the safety checks run against.
//
// The exact-bytes report is persisted under <backupDir>/disk-reclaim.json; sizes are exact bytes
// with a rendered MiB string for human readability.

type DatabaseService = Database.Interface["db"]

export class DiskReclaimError extends Data.TaggedError("DiskReclaim.DiskReclaimError")<{
  readonly code: "reclaim_failed" | "write_failed"
  readonly detail: string
}> {}

export type InventoryCategory =
  | "main_db"
  | "wal_sidecar"
  | "backup"
  | "backup_archived"
  | "md_export"
  | "migration_archive"
  | "restore_incident"
  | "operational"
  | "residue_candidate"
  | "other_data"

export interface InventoryEntry {
  readonly path: string
  readonly sizeBytes: number
  readonly category: InventoryCategory
  readonly note: string
}

export interface ReclaimCandidate {
  readonly path: string
  readonly sizeBytes: number
  /** True when the M-2 disk advisory listed this path as a residue candidate. */
  readonly fromAdvisory: boolean
  readonly safe: boolean
  readonly blockedReason?: string
  readonly deleted: boolean
}

export interface ReclaimReport {
  readonly version: 1
  readonly kind: "disk-reclaim-report"
  readonly dataRoot: string
  readonly dbPath: string
  readonly backupDir: string
  readonly generatedAt: number
  /** False when confirm was not supplied — the report is then an inventory + candidate list only. */
  readonly executed: boolean
  readonly vacuumed: boolean
  readonly inventory: readonly InventoryEntry[]
  readonly totalBytesBefore: number
  readonly totalBytesAfter: number
  readonly reclaimedBytes: number
  readonly beforeMiB: string
  readonly afterMiB: string
  readonly reclaimedMiB: string
  readonly candidates: readonly ReclaimCandidate[]
  readonly restoreIncidentsBytes: number
  readonly restoreIncidentsNeverDeleted: true
}

export interface ReclaimInput {
  /** The live business database connection (VACUUM runs on it when requested). */
  readonly db: DatabaseService
  /** Absolute path of the live SQLite database. */
  readonly dbPath: string
  /** Backups root (advisory/journal source; its subtree is never a deletion candidate). */
  readonly backupDir: string
  /** Data root override (tests). Defaults to Global.Path.data. */
  readonly dataRoot?: string
  /** The user confirmation gate: nothing is deleted unless this is exactly true. */
  readonly confirm?: boolean
  /** VACUUM the main database after the residue deletion. Requires confirm. */
  readonly vacuum?: boolean
}

export const reportPathFor = (backupDir: string) => path.join(backupDir, "disk-reclaim.json")

const mibOf = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`

const writeJsonAtomic = (filePath: string, value: unknown) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp-${Math.random().toString(36).slice(2)}`
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
    await fs.rename(tmp, filePath)
  }).pipe(
    Effect.catchCause(
      (cause) =>
        new DiskReclaimError({
          code: "write_failed",
          detail: `cannot write reclaim report ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
  )

const within = (candidate: string, root: string) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Operational roots resolved through Global.Path (design: never hardcode the layout). The
 * relative layout under Global.Path.data is re-projected onto the (possibly overridden) dataRoot
 * so tests exercising an isolated root classify identically to production.
 */
const operationalRoots = (dataRoot: string) =>
  [Global.Path.cache, Global.Path.state, Global.Path.tmp, Global.Path.log, Global.Path.bin, Global.Path.repos]
    .map((root) => path.relative(Global.Path.data, root))
    .filter((relative) => !relative.startsWith(".."))
    .map((relative) => path.join(dataRoot, relative))

const classify = (input: {
  readonly file: string
  readonly dataRoot: string
  readonly dbPath: string
  readonly backupDir: string
}): InventoryCategory => {
  const { file, dbPath, backupDir } = input
  if (path.resolve(file) === path.resolve(dbPath)) return "main_db"
  if (file === `${dbPath}-wal` || file === `${dbPath}-shm`) return "wal_sidecar"
  if (within(file, path.join(backupDir, "archive"))) return "backup_archived"
  if (within(file, path.join(backupDir, "migration-archive"))) return "migration_archive"
  if (within(file, path.join(backupDir, "md"))) return "md_export"
  if (within(file, backupDir)) return "backup"
  if (within(file, path.join(path.dirname(path.resolve(dbPath)), "restore-incidents"))) return "restore_incident"
  if (operationalRoots(input.dataRoot).some((root) => within(file, root))) return "operational"
  if (
    path.dirname(path.resolve(file)) === path.dirname(path.resolve(dbPath)) &&
    isResidue(path.basename(file), dbPath)
  )
    return "residue_candidate"
  return "other_data"
}

const inventoryOf = async (input: { dataRoot: string; dbPath: string; backupDir: string }) => {
  const files = await walk(input.dataRoot)
  const entries: InventoryEntry[] = []
  for (const file of files) {
    const category = classify({ file, ...input })
    entries.push({
      path: file,
      sizeBytes: await sizeOf(file),
      category,
      note:
        category === "restore_incident"
          ? "Incident quarantine copy. NEVER deleted (design §3.1 ruling / restore.ts)."
          : category === "residue_candidate"
            ? "Operational residue candidate. Reclaimable after the safety checks and user confirmation."
            : category === "main_db"
              ? "Live authority database. Kept (VACUUM compacts it in place when requested)."
              : category === "wal_sidecar"
                ? "WAL/SHM sidecar of the live database. Kept."
                : "Kept — managed by its owning feature (retention: M-4; incidents: never).",
    })
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** The M-2 advisory's residue_candidate paths, when a chain has produced an advisory. */
const advisoryResiduePaths = Effect.fn("DiskReclaim.advisoryResiduePaths")(function* (backupDir: string) {
  const journal = yield* MigrationOrchestrator.readJournal(MigrationOrchestrator.journalPathFor(backupDir)).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  const advisoryPath = journal?.phases.findLast(
    (record) => record.phase === "disk_advisory" && record.state === "completed",
  )?.outcome
  if (advisoryPath?.kind !== "disk_advisory") return new Set<string>()
  const advisory = yield* Effect.promise(() =>
    fs.readFile(advisoryPath.advisoryPath, "utf8").then((t) => JSON.parse(t)).catch(() => undefined),
  )
  return new Set(
    ((advisory as { entries?: { category?: string; path?: string }[] } | undefined)?.entries ?? [])
      .filter((entry) => entry.category === "residue_candidate" && typeof entry.path === "string")
      .map((entry) => entry.path as string),
  )
})

/** Every filesystem path referenced by a backup manifest under the backups root (the keep-set). */
const manifestReferencedPaths = Effect.fn("DiskReclaim.manifestReferencedPaths")(function* (backupDir: string) {
  const referenced = new Set<string>()
  for (const dir of [backupDir, path.join(backupDir, "archive")]) {
    const names = yield* Effect.promise(() => fs.readdir(dir).catch(() => [] as string[]))
    for (const name of names.filter((entry) => entry.endsWith(".manifest.json"))) {
      const manifest = yield* Backup.readManifest(path.join(dir, name)).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      if (manifest === undefined) continue
      referenced.add(path.resolve(manifest.backup.filePath))
      referenced.add(path.resolve(manifest.source.filePath))
    }
  }
  return referenced
})

/** The safety oracle: a candidate is deletable only when nothing references or protects it. */
const blockedReasonFor = (input: {
  readonly candidate: string
  readonly dbPath: string
  readonly backupDir: string
  readonly referenced: ReadonlySet<string>
}): string | undefined => {
  const { candidate, dbPath, backupDir, referenced } = input
  if (within(candidate, path.join(path.dirname(path.resolve(dbPath)), "restore-incidents")))
    return "restore-incidents is never deleted (design §3.1 ruling)"
  if (path.resolve(candidate) === path.resolve(dbPath)) return "the live authority database is never a candidate"
  if (candidate === `${dbPath}-wal` || candidate === `${dbPath}-shm`) return "WAL/SHM sidecar of the live database"
  if (within(candidate, backupDir)) return "the backups root is governed by retention (M-4), not reclaim"
  if (referenced.has(path.resolve(candidate))) return "referenced by a backup manifest"
  return undefined
}

export const reclaim = Effect.fn("DiskReclaim.reclaim")(function* (input: ReclaimInput) {
  const dataRoot = path.resolve(input.dataRoot ?? Global.Path.data)
  const dbPath = path.resolve(input.dbPath)
  const backupDir = path.resolve(input.backupDir)
  const incidentsDir = path.join(path.dirname(dbPath), "restore-incidents")

  const fromAdvisory = yield* advisoryResiduePaths(backupDir)
  const referenced = yield* manifestReferencedPaths(backupDir)
  // Advisory candidates UNION the live re-scan; the filesystem is the truth the checks run on.
  const liveScan = (yield* Effect.promise(() => fs.readdir(path.dirname(dbPath)).catch(() => [] as string[])))
    .map((name) => path.join(path.dirname(dbPath), name))
    .filter((file) => classify({ file, dataRoot, dbPath, backupDir }) === "residue_candidate")
  // Cross-review F-2: an advisory JSON is a FILE input, not authority — a corrupted or tampered
  // advisory must never widen the delete set beyond what the live re-scan would justify. Every
  // advisory-sourced path is re-validated against the same containment and residue-shape rules
  // the live scan enforces before it may enter the plan.
  const trustedAdvisory = [...fromAdvisory].filter(
    (candidate) =>
      path.resolve(candidate) === path.resolve(input.dbPath) ||
      (within(candidate, path.dirname(path.resolve(input.dbPath))) && isResidue(path.basename(candidate), path.resolve(input.dbPath))),
  )
  const candidatePaths = [...new Set([...trustedAdvisory, ...liveScan])]

  const plan = yield* Effect.forEach(candidatePaths.sort(), (candidate) =>
    Effect.gen(function* () {
      const exists = yield* Effect.promise(() => fs.stat(candidate).then(() => true).catch(() => false))
      if (!exists) return undefined
      const blockedReason = blockedReasonFor({ candidate, dbPath, backupDir, referenced })
      return {
        path: candidate,
        sizeBytes: yield* Effect.promise(() => sizeOf(candidate)),
        fromAdvisory: fromAdvisory.has(candidate),
        safe: blockedReason === undefined,
        ...(blockedReason === undefined ? {} : { blockedReason }),
      }
    }),
  )
  const deletable = plan.filter((item): item is NonNullable<typeof item> => item !== undefined && item.safe)

  const inventoryBefore = yield* Effect.promise(() => inventoryOf({ dataRoot, dbPath, backupDir }))
  const totalBytesBefore = inventoryBefore.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  const executed = input.confirm === true
  const vacuumRequested = input.vacuum === true
  const vacuumed = executed && vacuumRequested
  const deleted = new Set<string>()

  if (executed) {
    for (const item of deletable) {
      yield* Effect.promise(() => fs.rm(item.path)).pipe(
        Effect.catchCause(
          (cause) =>
            new DiskReclaimError({
              code: "reclaim_failed",
              detail: `cannot delete ${item.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      )
      deleted.add(item.path)
    }
    if (vacuumRequested) {
      yield* input.db.run(sql`VACUUM`).pipe(
        Effect.catchCause(
          (cause) =>
            new DiskReclaimError({
              code: "reclaim_failed",
              detail: `VACUUM failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      )
    }
  }
  const candidates: readonly ReclaimCandidate[] = plan
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .map((item) => ({ ...item, deleted: deleted.has(item.path) }))

  const inventoryAfter = yield* Effect.promise(() => inventoryOf({ dataRoot, dbPath, backupDir }))
  const totalBytesAfter = inventoryAfter.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  // RED LINE assertion: the incident set must be byte-identical before and after execution.
  const incidentsBytesOf = (entries: readonly InventoryEntry[]) =>
    entries.filter((entry) => entry.category === "restore_incident").reduce((sum, entry) => sum + entry.sizeBytes, 0)
  if (executed && incidentsBytesOf(inventoryAfter) !== incidentsBytesOf(inventoryBefore))
    return yield* new DiskReclaimError({
      code: "reclaim_failed",
      detail: "restore-incidents content changed during reclaim — this must never happen",
    })

  const report: ReclaimReport = {
    version: 1,
    kind: "disk-reclaim-report",
    dataRoot,
    dbPath,
    backupDir,
    generatedAt: Date.now(),
    executed,
    vacuumed,
    inventory: inventoryAfter,
    totalBytesBefore,
    totalBytesAfter,
    reclaimedBytes: totalBytesBefore - totalBytesAfter,
    beforeMiB: mibOf(totalBytesBefore),
    afterMiB: mibOf(totalBytesAfter),
    reclaimedMiB: mibOf(totalBytesBefore - totalBytesAfter),
    candidates,
    restoreIncidentsBytes: incidentsBytesOf(inventoryAfter),
    restoreIncidentsNeverDeleted: true,
  }
  yield* writeJsonAtomic(reportPathFor(backupDir), report)
  return report
})
