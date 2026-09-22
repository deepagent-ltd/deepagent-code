export * as MigrationOrchestrator from "./migration-orchestrator"

import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Cause, Data, Effect, Exit } from "effect"
import { Backup } from "@deepagent-code/core/database/backup"
import { BackupVerify } from "@deepagent-code/core/database/backup-verify"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { PostVerify } from "@deepagent-code/core/database/post-verify"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { MdExport, type MdExportError } from "./md-export"

// W-02 M-2 (design §3.3) — the V1→V2 migration flow orchestrator. EXTERNAL by design: the
// upgrade-run state machine and its storage-layer transition trigger stay untouched (a phase here
// never advances or fails an upgrade run itself); this module only CHAINS the existing primitives
// and persists its own journal, so a restart shows exactly which phase broke.
//
//   md_export → backup_create → backup_verify → migration_apply → post_verify → archive → disk_advisory
//
// Phase semantics:
//   md_export       M-1 batch exporter; idempotent (the manifest is the resume source of truth)
//   backup_create   Backup.create (VACUUM INTO snapshot; never clobbers an existing file)
//   backup_verify   BackupVerify.verify against the fresh manifest (§10.4/§10.9)
//   migration_apply the EXISTING migration state machine (DatabaseMigration.apply). A no-op when
//                   nothing is pending — on a live runtime bootstrap already applied the registry;
//                   resuming an interrupted run is delegated to its own receipt semantics.
//   post_verify     an explicit PostVerify.run pass (DataIntegrity + RecoveryBinding + startup
//                   inventory) on the live connection, independent of apply's internal gate.
//   archive         writes the durable archive record under <backupDir>/migration-archive/.
//   disk_advisory   measures the store and produces the deletion-candidate ADVISORY LIST ONLY —
//                   M-5 owns execution. restore-incidents/ is listed as never-delete (§3.1 ruling)
//                   and is never touched by any phase.
//
// Any phase failure stops the chain, records a structured failure (phase + code + detail) plus
// user-readable recovery guidance into the journal, and returns it. Every phase is idempotent, so
// re-running resumes: completed phases are skipped, the failed/interrupted phase re-runs.

type DatabaseService = Database.Interface["db"]

export const Phases = [
  "md_export",
  "backup_create",
  "backup_verify",
  "migration_apply",
  "post_verify",
  "archive",
  "disk_advisory",
] as const
export type Phase = (typeof Phases)[number]

export type PhaseOutcome =
  | { readonly kind: "md_export"; readonly manifestPath: string; readonly exported: number; readonly skipped: number; readonly sessionCount: number; readonly reconciled: boolean }
  | { readonly kind: "backup_create"; readonly manifestPath: string; readonly fileName: string; readonly sha256: string; readonly sizeBytes: number }
  | { readonly kind: "backup_verify"; readonly quickCheck: string; readonly migrationCount: number; readonly sessionCount: number | null }
  | { readonly kind: "migration_apply"; readonly runId?: string; readonly runState?: string; readonly receiptCount: number }
  | { readonly kind: "post_verify"; readonly runId: string; readonly verdict: "passed" }
  | { readonly kind: "archive"; readonly archivePath: string }
  | { readonly kind: "disk_advisory"; readonly advisoryPath: string; readonly reclaimableBytes: number; readonly candidateCount: number; readonly restoreIncidentsBytes: number }

export interface PhaseRecord {
  readonly phase: Phase
  readonly state: "completed" | "failed"
  readonly startedAt: number
  readonly completedAt: number
  readonly outcome?: PhaseOutcome
  readonly failure?: { readonly code: string; readonly detail: string }
}

export interface Journal {
  readonly version: 1
  readonly kind: "migration-orchestration-journal"
  readonly orchestrationId: string
  readonly dbPath: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly status: "in_progress" | "completed" | "failed"
  /** The phase the chain stopped at (last completed for a staged stop; the failing phase otherwise). */
  readonly currentPhase?: Phase
  readonly phases: readonly PhaseRecord[]
  readonly failure?: {
    readonly phase: Phase
    readonly code: string
    readonly detail: string
    readonly recoveryGuidance: string
  }
}

export interface RunInput {
  /** The live business database connection (the maintenance live runtime). */
  readonly db: DatabaseService
  /** Absolute path of the live SQLite database. */
  readonly dbPath: string
  /** Backups root; the journal, archive and md/ exports live under it. */
  readonly backupDir: string
  /** Build identity stamped on Backup.create. Defaults to the installation version. */
  readonly buildId?: string
  /** Deterministic backup base name (crash-window drills); a fresh timestamped name by default. */
  readonly backupFileName?: string
  /**
   * Stop AFTER this phase completes and leave the journal in_progress (chunked/staged invocation
   * and the interruption drill); a later invocation resumes the remainder of the chain.
   */
  readonly stopAfter?: Phase
  /**
   * Passed through to DatabaseMigration.apply — the existing ApplyOptions seam (an injectable
   * post-verify verdict for the migration-interruption drill; never set by production callers).
   */
  readonly applyOptions?: DatabaseMigration.ApplyOptions
}

export type RunResult =
  | { readonly status: "completed"; readonly journal: Journal; readonly diskAdvisoryPath?: string }
  | { readonly status: "in_progress"; readonly journal: Journal }
  | { readonly status: "failed"; readonly journal: Journal }

export interface DiskAdvisoryEntry {
  readonly path: string
  readonly sizeBytes: number
  readonly category:
    | "main_db"
    | "wal_sidecar"
    | "backup"
    | "md_export"
    | "archive"
    | "restore_incident"
    | "residue_candidate"
  readonly note: string
}

export interface DiskAdvisory {
  readonly version: 1
  readonly kind: "disk-advisory"
  readonly orchestrationId: string
  readonly dbPath: string
  readonly generatedAt: number
  readonly restoreIncidentsNeverDeleted: true
  readonly entries: readonly DiskAdvisoryEntry[]
  readonly totalBytes: number
  /** Only residue candidates are claimed reclaimable; backup retention is M-4, execution M-5. */
  readonly reclaimableBytes: number
}

export interface ArchiveRecord {
  readonly version: 1
  readonly kind: "migration-archive"
  readonly orchestrationId: string
  readonly dbPath: string
  readonly startedAt: number
  readonly completedAt: number
  readonly mdExport?: { readonly manifestPath: string; readonly exported: number; readonly reconciled: boolean }
  readonly backup?: { readonly manifestPath: string; readonly sha256: string; readonly sizeBytes: number }
  readonly migration?: { readonly runId?: string; readonly runState?: string; readonly receiptCount: number }
  readonly postVerify?: { readonly runId: string; readonly verdict: "passed" }
}

export const journalPathFor = (backupDir: string) => path.join(backupDir, "migration-orchestration.json")

class PhaseFailure extends Data.TaggedError("MigrationOrchestrator.PhaseFailure")<{
  readonly phase: Phase
  readonly code: string
  readonly detail: string
}> {}

// -- journal persistence (manifest convention: atomic tmp + rename, valid at every phase boundary)

const writeJsonAtomic = (filePath: string, value: unknown) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp-${Math.random().toString(36).slice(2)}`
    await Bun.write(tmp, `${JSON.stringify(value, null, 2)}\n`)
    await fs.rename(tmp, filePath)
  })

export const readJournal = Effect.fn("MigrationOrchestrator.readJournal")(function* (journalPath: string) {
  const text = yield* Effect.promise(() => Bun.file(journalPath).text()).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  if (text === undefined) return undefined
  return yield* Effect.try({
    try: () => {
      const parsed = JSON.parse(text) as Partial<Journal>
      if (parsed?.version !== 1 || parsed?.kind !== "migration-orchestration-journal" || !Array.isArray(parsed.phases))
        throw new Error("not a migration-orchestration journal")
      return parsed as Journal
    },
    catch: () => new Error(`migration-orchestration journal is unreadable: ${journalPath}`),
  })
})

// -- per-phase user-readable recovery guidance (rendered verbatim by M-6's UX)

const Guidance: Record<Phase, string> = {
  md_export:
    "The transcript export stopped before completion. The already-exported files and their manifest are retained. Re-run the migration to resume — exported sessions are skipped automatically.",
  backup_create:
    "No migration has run. The previous known-good backup and the restore-incidents set are retained. Free disk space or fix permissions under the backups directory, then re-run.",
  backup_verify:
    "The newly created backup did not pass verification. It is retained for inspection and the live database was not modified. Re-run after resolving the cause, or restore a known-good backup from the incident maintenance shell.",
  migration_apply:
    "The migration itself failed and rolled back transactionally — the database is not half-migrated. The verified backup is retained. Resolve the reported cause and re-run; if the store is in recovery, use the incident maintenance shell.",
  post_verify:
    "The post-migration gate failed and the upgrade run is routed to recovery_required. Start the incident maintenance shell and follow its recovery descriptors. Do not delete the verified backup or restore-incidents.",
  archive:
    "The archive record could not be written. The migration itself succeeded; re-running only rewrites the archive (idempotent).",
  disk_advisory:
    "The disk advisory could not be computed. The migration itself succeeded; re-running regenerates the advisory list. Nothing is ever deleted by this phase.",
}

const completedOutcome = (records: readonly PhaseRecord[], phase: Phase): PhaseOutcome | undefined =>
  records.findLast((record) => record.phase === phase && record.state === "completed")?.outcome

// -- the phases ---------------------------------------------------------------------------------------------

const runMdExportPhase = (input: RunInput) =>
  MdExport.run({ db: input.db, backupDir: input.backupDir, sourcePath: input.dbPath }).pipe(
    Effect.map(
      (result): PhaseOutcome => ({
        kind: "md_export",
        manifestPath: result.manifestPath,
        exported: result.exported,
        skipped: result.skipped,
        sessionCount: result.sessionCount,
        reconciled: result.reconciliation.reconciled,
      }),
    ),
    Effect.mapError((error: MdExportError) => new PhaseFailure({ phase: "md_export", code: `md_export_${error.code}`, detail: error.detail })),
  )

const runBackupCreatePhase = (input: RunInput) =>
  Backup.create({
    sourcePath: input.dbPath,
    destDir: input.backupDir,
    buildId: input.buildId ?? InstallationVersion,
    ...(input.backupFileName === undefined ? {} : { fileName: input.backupFileName }),
  }).pipe(
    Effect.map(
      (manifest): PhaseOutcome => ({
        kind: "backup_create",
        manifestPath: `${manifest.backup.filePath}.manifest.json`,
        fileName: manifest.backup.fileName,
        sha256: manifest.backup.sha256,
        sizeBytes: manifest.backup.sizeBytes,
      }),
    ),
    Effect.mapError(
      // Effect.fn widens Backup.create's error to number | BackupError; only the typed error
      // carries a stable code.
      (error) =>
        new PhaseFailure({
          phase: "backup_create",
          code: `backup_${error instanceof Backup.BackupError ? error.code : "failed"}`,
          // backup_exists is the crash window between the atomic rename and the journal write:
          // an identical re-run must not be blocked by the residue of the interrupted attempt.
          detail:
            error instanceof Backup.BackupError && error.code === "backup_exists"
              ? `${error.detail} (a prior attempt created this backup before the journal was written; remove it or pass a different backup file name to resume)`
              : String(error),
        }),
    ),
  )

const runBackupVerifyPhase = (input: RunInput, records: readonly PhaseRecord[]) =>
  Effect.gen(function* () {
    const created = completedOutcome(records, "backup_create")
    if (created?.kind !== "backup_create")
      return yield* new PhaseFailure({ phase: "backup_verify", code: "backup_missing", detail: "no recorded backup_create outcome to verify" })
    const manifest = yield* Backup.readManifest(created.manifestPath)
    const verdict = yield* BackupVerify.verify(manifest)
    if (!verdict.ok)
      return yield* new PhaseFailure({ phase: "backup_verify", code: `backup_verify_${verdict.reason}`, detail: verdict.detail })
    return {
      kind: "backup_verify",
      quickCheck: verdict.quickCheck,
      migrationCount: verdict.migrationCount,
      sessionCount: verdict.sessionCount,
    } satisfies PhaseOutcome
  })

const runMigrationApplyPhase = (input: RunInput) =>
  Effect.gen(function* () {
    // The existing state machine owns run/transition semantics; this call only drives it. On a
    // fully migrated store it returns undefined (nothing was pending — an honest no-op outcome).
    const run = yield* DatabaseMigration.apply(input.db, {
      filename: input.dbPath,
      ...(input.applyOptions ?? {}),
    })
    const receiptCount =
      run === undefined ? 0 : (yield* DatabaseUpgradeRun.loadReceiptsForRun(input.db, run.runId).pipe(Effect.orDie)).length
    return {
      kind: "migration_apply",
      ...(run === undefined ? {} : { runId: run.runId, runState: run.state }),
      receiptCount,
    } satisfies PhaseOutcome
  })

const runPostVerifyPhase = (input: RunInput, records: readonly PhaseRecord[]) =>
  Effect.gen(function* () {
    const applied = completedOutcome(records, "migration_apply")
    // No run this invocation (registry already current): audit under the latest durable run if one
    // exists. PostVerify's failRun routing is Effect.ignore'd for unknown/terminal run ids.
    const latestRun =
      applied?.kind === "migration_apply" && applied.runId !== undefined
        ? applied.runId
        : (yield* input.db
            .get<{ run_id: string }>(sql`SELECT run_id FROM database_upgrade_run ORDER BY started_at DESC LIMIT 1`)
            .pipe(Effect.orDie))?.run_id ?? `orchestration-${path.basename(input.dbPath)}`
    yield* PostVerify.run(input.db, {
      runId: latestRun,
      registryIds: migrations.map((migration) => migration.id),
      canonicalize: (id) => DatabaseMigration.historicalAliases.get(id) ?? id,
    }).pipe(
      Effect.catchTag("PostVerify.PostVerifyError", (error) =>
        new PhaseFailure({ phase: "post_verify", code: error.code, detail: error.detail }),
      ),
    )
    return { kind: "post_verify", runId: latestRun, verdict: "passed" } satisfies PhaseOutcome
  })

const runArchivePhase = (input: RunInput, journal: Journal) =>
  Effect.gen(function* () {
    const mdExport = completedOutcome(journal.phases, "md_export")
    const backup = completedOutcome(journal.phases, "backup_create")
    const migration = completedOutcome(journal.phases, "migration_apply")
    const postVerify = completedOutcome(journal.phases, "post_verify")
    const record: ArchiveRecord = {
      version: 1,
      kind: "migration-archive",
      orchestrationId: journal.orchestrationId,
      dbPath: input.dbPath,
      startedAt: journal.startedAt,
      completedAt: Date.now(),
      mdExport:
        mdExport?.kind === "md_export"
          ? { manifestPath: mdExport.manifestPath, exported: mdExport.exported, reconciled: mdExport.reconciled }
          : undefined,
      backup:
        backup?.kind === "backup_create"
          ? { manifestPath: backup.manifestPath, sha256: backup.sha256, sizeBytes: backup.sizeBytes }
          : undefined,
      migration:
        migration?.kind === "migration_apply"
          ? {
              ...(migration.runId === undefined ? {} : { runId: migration.runId, runState: migration.runState }),
              receiptCount: migration.receiptCount,
            }
          : undefined,
      postVerify: postVerify?.kind === "post_verify" ? { runId: postVerify.runId, verdict: postVerify.verdict } : undefined,
    }
    const archivePath = path.join(input.backupDir, "migration-archive", `${journal.orchestrationId}.json`)
    yield* writeJsonAtomic(archivePath, record)
    return { kind: "archive", archivePath } satisfies PhaseOutcome
  })

// -- disk advisory (advisory list only — M-5 executes deletion) ---------------------------------------------

const ResiduePatterns = [/\.bak$/i, /repro\.db$/i, /^\..*\.tmp-/] as const

/** Operational-residue classifier, shared with the M-4/M-5 governance modules. */
export const isResidue = (name: string, dbPath: string) =>
  ResiduePatterns.some((pattern) => pattern.test(name)) ||
  (name.endsWith(".db") && path.resolve(path.dirname(dbPath), name) !== path.resolve(dbPath))

/** Recursive file walk, shared with the M-4/M-5 governance modules. */
export const walk = async (dir: string): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...(await walk(path.join(dir, entry.name))))
    else files.push(path.join(dir, entry.name))
  }
  return files
}

export const sizeOf = async (filePath: string) => (await fs.stat(filePath).catch(() => null))?.size ?? 0

const computeDiskAdvisory = async (input: RunInput, orchestrationId: string): Promise<DiskAdvisory> => {
  const dbDir = path.dirname(path.resolve(input.dbPath))
  const entries: DiskAdvisoryEntry[] = []
  entries.push({ path: path.resolve(input.dbPath), sizeBytes: await sizeOf(input.dbPath), category: "main_db", note: "Live authority database. Kept." })
  for (const sidecar of ["-wal", "-shm"]) {
    const sidecarPath = `${input.dbPath}${sidecar}`
    const sizeBytes = await sizeOf(sidecarPath)
    if (sizeBytes > 0)
      entries.push({ path: sidecarPath, sizeBytes, category: "wal_sidecar", note: "WAL/SHM sidecar of the live database. Kept." })
  }
  for (const file of await walk(input.backupDir)) {
    const relative = path.relative(input.backupDir, file)
    if (relative.startsWith(`md${path.sep}`))
      entries.push({ path: file, sizeBytes: await sizeOf(file), category: "md_export", note: "Human-readable transcript backup. Kept." })
    else if (relative.startsWith(`migration-archive${path.sep}`) || path.basename(file) === "migration-orchestration.json")
      entries.push({ path: file, sizeBytes: await sizeOf(file), category: "archive", note: "Migration archive/journal record. Kept." })
    else entries.push({ path: file, sizeBytes: await sizeOf(file), category: "backup", note: "Consistency backup. Retention (M-4) decides." })
  }
  for (const file of await walk(path.join(dbDir, "restore-incidents"))) {
    entries.push({
      path: file,
      sizeBytes: await sizeOf(file),
      category: "restore_incident",
      note: "Incident quarantine copy. NEVER deleted (design §3.1 ruling / restore.ts).",
    })
  }
  // Residue candidates live flat in the store directory (multi-channel DBs, manual .bak, repro
  // DBs, orphaned tmp files). Listed as reclaimable; M-5 executes deletion only after checks +
  // user confirmation.
  for (const entry of await fs.readdir(dbDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !isResidue(entry.name, input.dbPath)) continue
    const file = path.join(dbDir, entry.name)
    entries.push({
      path: file,
      sizeBytes: await sizeOf(file),
      category: "residue_candidate",
      note: "Operational residue candidate. Reclaimable after the M-5 safety checks and user confirmation.",
    })
  }
  return {
    version: 1,
    kind: "disk-advisory",
    orchestrationId,
    dbPath: input.dbPath,
    generatedAt: Date.now(),
    restoreIncidentsNeverDeleted: true,
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    reclaimableBytes: entries
      .filter((entry) => entry.category === "residue_candidate")
      .reduce((sum, entry) => sum + entry.sizeBytes, 0),
  }
}

const runDiskAdvisoryPhase = (input: RunInput, journal: Journal) =>
  Effect.gen(function* () {
    const advisory = yield* Effect.promise(() => computeDiskAdvisory(input, journal.orchestrationId))
    const advisoryPath = path.join(input.backupDir, "migration-archive", `${journal.orchestrationId}-disk-advisory.json`)
    yield* writeJsonAtomic(advisoryPath, advisory)
    return {
      kind: "disk_advisory",
      advisoryPath,
      reclaimableBytes: advisory.reclaimableBytes,
      candidateCount: advisory.entries.filter((entry) => entry.category === "residue_candidate").length,
      restoreIncidentsBytes: advisory.entries
        .filter((entry) => entry.category === "restore_incident")
        .reduce((sum, entry) => sum + entry.sizeBytes, 0),
    } satisfies PhaseOutcome
  })

// -- the chain ----------------------------------------------------------------------------------------------

const phaseEffect = (phase: Phase, input: RunInput, journal: Journal) =>
  phase === "md_export"
    ? runMdExportPhase(input)
    : phase === "backup_create"
      ? runBackupCreatePhase(input)
      : phase === "backup_verify"
        ? runBackupVerifyPhase(input, journal.phases)
        : phase === "migration_apply"
          ? runMigrationApplyPhase(input)
          : phase === "post_verify"
            ? runPostVerifyPhase(input, journal.phases)
            : phase === "archive"
              ? runArchivePhase(input, journal)
              : runDiskAdvisoryPhase(input, journal)

export const run = Effect.fn("MigrationOrchestrator.run")(function* (input: RunInput) {
  const journalPath = journalPathFor(input.backupDir)
  const previous = yield* readJournal(journalPath)
  // Resume an interrupted/failed orchestration; a completed one starts a fresh chain (the archive
  // directory keeps the history — the journal file only tracks the LATEST orchestration).
  const resume = previous !== undefined && previous.status !== "completed"
  const journal: Journal =
    resume && previous !== undefined
      ? { ...previous, updatedAt: Date.now(), currentPhase: undefined, failure: undefined, status: "in_progress" }
      : {
          version: 1,
          kind: "migration-orchestration-journal",
          orchestrationId: `mo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          dbPath: input.dbPath,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          status: "in_progress",
          phases: [],
        }
  const persist = (next: Journal) => writeJsonAtomic(journalPath, next)
  yield* persist(journal)

  let latest = journal
  for (const phase of Phases) {
    if (latest.phases.some((record) => record.phase === phase && record.state === "completed")) continue
    const startedAt = Date.now()
    // "running" is persisted so a crash MID-phase is visible on restart (status shows the break).
    const running: Journal = { ...latest, currentPhase: phase, updatedAt: startedAt }
    yield* persist(running)
    const outcome = yield* Effect.exit(phaseEffect(phase, input, running))
    if (Exit.isFailure(outcome)) {
      const failure =
        Cause.findErrorOption(outcome.cause).pipe(
          (option) => (option._tag === "Some" && option.value instanceof PhaseFailure ? option.value : undefined),
        ) ?? new PhaseFailure({ phase, code: `${phase}_failed`, detail: String(Cause.squash(outcome.cause)) })
      const failed: Journal = {
        ...running,
        updatedAt: Date.now(),
        status: "failed",
        currentPhase: phase,
        phases: [
          ...running.phases,
          { phase, state: "failed", startedAt, completedAt: Date.now(), failure: { code: failure.code, detail: failure.detail } },
        ],
        failure: { phase, code: failure.code, detail: failure.detail, recoveryGuidance: Guidance[phase] },
      }
      yield* persist(failed)
      return { status: "failed" as const, journal: failed }
    }
    const outcomeValue = outcome.value as PhaseOutcome
    latest = {
      ...running,
      updatedAt: Date.now(),
      currentPhase: undefined,
      phases: [...running.phases, { phase, state: "completed" as const, startedAt, completedAt: Date.now(), outcome: outcomeValue }],
    }
    yield* persist(latest)
    if (input.stopAfter === phase) {
      const stopped: Journal = { ...latest, status: "in_progress" as const, currentPhase: phase }
      yield* persist(stopped)
      return { status: "in_progress" as const, journal: stopped }
    }
  }

  const done: Journal = { ...latest, status: "completed" as const, updatedAt: Date.now() }
  yield* persist(done)
  const advisory = latest.phases.findLast((record) => record.phase === "disk_advisory" && record.state === "completed")
  return {
    status: "completed" as const,
    journal: done,
    ...(advisory?.outcome?.kind === "disk_advisory" ? { diskAdvisoryPath: advisory.outcome.advisoryPath } : {}),
  }
})
