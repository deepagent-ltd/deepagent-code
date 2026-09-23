export * as MigrationReport from "./migration-report"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Data, Effect } from "effect"
import { Backup } from "@deepagent-code/core/database/backup"
import { BackupVerify } from "@deepagent-code/core/database/backup-verify"
import { Database } from "@deepagent-code/core/database/database"
import { DataIntegrity } from "@deepagent-code/core/database/data-integrity"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { DatabasePreflight } from "@deepagent-code/core/database/preflight"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { SessionMessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { MdExport } from "./md-export"
import { MigrationOrchestrator, type Journal } from "./migration-orchestrator"

// W-02 M-3 (design §3.3) — the post-migration compliance report. Aggregates every existing
// verification oracle into one user-readable, three-state document:
//
//   preflight        a FRESH ten-probe preflight run against dbPath (same options as bootstrap)
//   data_integrity   a FRESH DataIntegrity.check (quick_check + FK + registry set equality)
//   post_verify      the M-2 journal's post_verify phase outcome (the migration-time gate)
//   backup_verify    a FRESH BackupVerify against the chain-recorded backup manifest
//   journal:<phase>  one entry per M-2 orchestration phase outcome (failure carries the guidance)
//   md_reconcile     M-1's manifest↔library oracle (missing/extra session ids) as a report entry
//   row_reconcile    NEW oracle: export-time vs report-time session/message row counts (the
//                    export must never drift the library; the manifest records per-session
//                    messageCount at export time, so any post-export change is a diff)
//
// Every check is recorded independently: one check failing to RUN becomes a failure entry, never
// an aborted report. Overall status: any failure → failure, else any warning → warning, else
// success. The report is persisted under <backupDir>/migration-report.json (schema version:1).

type DatabaseService = Database.Interface["db"]

export class MigrationReportError extends Data.TaggedError("MigrationReport.MigrationReportError")<{
  readonly code: "write_failed" | "read_failed"
  readonly detail: string
}> {}

export type CheckStatus = "success" | "warning" | "failure"

export interface ReportEntry {
  readonly check: string
  readonly status: CheckStatus
  readonly summary: string
  readonly detail?: string
}

export interface RowReconciliation {
  readonly sessionsInLibrary: number
  readonly sessionsInManifest: number
  readonly messagesInLibrary: number
  readonly messagesInManifest: number
  readonly reconciled: boolean
}

export interface Report {
  readonly version: 1
  readonly kind: "migration-compliance-report"
  readonly dbPath: string
  readonly backupDir: string
  readonly orchestrationId?: string
  readonly generatedAt: number
  readonly overall: CheckStatus
  readonly entries: readonly ReportEntry[]
  readonly mdReconciliation: MdExport.Reconciliation
  readonly rowReconciliation: RowReconciliation
}

export interface GenerateInput {
  /** The business database (live or read-only maintenance connection). */
  readonly db: DatabaseService
  /** Absolute path of the live SQLite database (preflight target). */
  readonly dbPath: string
  /** Backups root holding the journal, md/ exports and the persisted report. */
  readonly backupDir: string
  /** Build identity for the preflight options. Defaults to the installation version. */
  readonly buildVersion?: string
}

export const reportPathFor = (backupDir: string) => path.join(backupDir, "migration-report.json")

const registryDigest = (ids: readonly string[]) => createHash("sha256").update(ids.join("\n")).digest("hex")

const writeJsonAtomic = (filePath: string, value: unknown) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp-${Math.random().toString(36).slice(2)}`
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
    await fs.rename(tmp, filePath)
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new MigrationReportError({
          code: "write_failed",
          detail: `cannot write report ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      ),
    ),
  )

/** Read + structurally validate the persisted report; a missing file is `undefined`. */
export const read = Effect.fn("MigrationReport.read")(function* (reportPath: string) {
  const text = yield* Effect.promise(() => fs.readFile(reportPath, "utf8")).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  if (text === undefined) return undefined
  return yield* Effect.try({
    try: () => {
      const parsed = JSON.parse(text) as Partial<Report>
      if (parsed?.version !== 1 || parsed?.kind !== "migration-compliance-report" || !Array.isArray(parsed.entries))
        throw new Error("not a migration-compliance report")
      return parsed as Report
    },
    catch: () => new MigrationReportError({ code: "read_failed", detail: `report unreadable: ${reportPath}` }),
  })
})

const overallOf = (entries: readonly ReportEntry[]): CheckStatus =>
  entries.some((entry) => entry.status === "failure")
    ? "failure"
    : entries.some((entry) => entry.status === "warning")
      ? "warning"
      : "success"

// -- the individual oracles ---------------------------------------------------------------------------------

/**
 * True when the runtime lock's recorded pid is THIS process. The preflight probe answers "is a
 * migration lease active" — for an external pre-boot caller any active lease is a blocker, but the
 * report is generated by the process that legitimately OWNS the store, so its own lease must not
 * read as `another_process_active`. A genuinely foreign live holder still fails preflight.
 */
const ownProcessHoldsLock = async (dbPath: string) => {
  const meta = await fs
    .readFile(path.join(`${dbPath}.runtime.lock`, "meta.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  return (
    typeof meta === "object" &&
    meta !== null &&
    "pid" in meta &&
    (meta as { pid?: unknown }).pid === process.pid
  )
}

/** Fresh ten-probe preflight, constructed with the same options the bootstrap path uses. */
const preflightEntry = async (input: GenerateInput): Promise<ReportEntry> => {
  const knownMigrationIds = migrations.map((migration) => migration.id)
  const result = await DatabasePreflight.preflight({
    filename: input.dbPath,
    readerProtocol: Database.SupportedReaderProtocol,
    writerProtocol: Database.SupportedWriterProtocol,
    knownMigrationIds,
    historicalAliases: Object.fromEntries(DatabaseMigration.historicalAliases),
    knownContentHashes: Object.fromEntries(
      migrations.map((migration) => [migration.id, DatabaseUpgradeRun.migrationContentHash(migration)]),
    ),
    legacyContentIdentityBoundary: DatabaseMigration.legacyContentIdentityBoundary,
    mergedHistoryAnchor: DatabaseMigration.mergedHistoryAnchor,
    mergedHistoryInsertions: DatabaseMigration.mergedHistoryInsertions,
    buildDigest: registryDigest(knownMigrationIds),
    buildVersion: input.buildVersion ?? InstallationVersion,
  })
  if (result.ok)
    return {
      check: "preflight",
      status: "success",
      summary: `ten-probe preflight passed (${result.observations.journalRows.length} journal rows, ${result.observations.freeSpaceBytes} bytes free)`,
    }
  const issues =
    (await ownProcessHoldsLock(input.dbPath))
      ? result.issues.filter((issue) => issue.code !== "another_process_active")
      : result.issues
  if (issues.length === 0)
    return {
      check: "preflight",
      status: "success",
      summary: `ten-probe preflight passed (${result.observations.journalRows.length} journal rows; the runtime lock is held by this process)`,
    }
  return {
    check: "preflight",
    status: "failure",
    summary: `preflight failed with ${issues.length} issue(s)`,
    detail: issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
  }
}

const dataIntegrityEntry = (db: DatabaseService) =>
  Effect.gen(function* () {
    const knownMigrationIds = migrations.map((migration) => migration.id)
    const verdict = yield* DataIntegrity.check(db, {
      registryIds: knownMigrationIds,
      canonicalize: (id) => DatabaseMigration.historicalAliases.get(id) ?? id,
    })
    return verdict.ok
      ? {
          check: "data_integrity",
          status: "success" as const,
          summary: `quick_check ok, 0 foreign-key violations, registry set equal (${knownMigrationIds.length} migrations)`,
        }
      : {
          check: "data_integrity",
          status: "failure" as const,
          summary: `data integrity failed: ${verdict.reason}`,
          detail: verdict.detail,
        }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        check: "data_integrity",
        status: "failure" as const,
        summary: "data integrity check could not run",
        detail: String(cause),
      }),
    ),
  )

const backupVerifyEntry = (journal: Journal | undefined) =>
  Effect.gen(function* () {
    const created = journal?.phases.findLast(
      (record) => record.phase === "backup_create" && record.state === "completed",
    )?.outcome
    if (created?.kind !== "backup_create")
      return {
        check: "backup_verify",
        status: "warning" as const,
        summary: "no verified backup recorded by the migration chain yet",
      }
    const manifest = yield* Backup.readManifest(created.manifestPath).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (manifest === undefined)
      return {
        check: "backup_verify",
        status: "failure" as const,
        summary: `the chain-recorded backup manifest is unreadable: ${created.fileName}`,
      }
    const verdict = yield* BackupVerify.verify(manifest).pipe(
      Effect.catchCause((cause) => Effect.succeed({ ok: false as const, reason: "verify_crashed", detail: String(cause) })),
    )
    return verdict.ok
      ? {
          check: "backup_verify",
          status: "success" as const,
          summary: `backup ${created.fileName} verified (quick_check ${verdict.quickCheck}, hash + schema digest match)`,
        }
      : {
          check: "backup_verify",
          status: "failure" as const,
          summary: `backup ${created.fileName} failed verification: ${verdict.reason}`,
          detail: verdict.detail,
        }
  })

const postVerifyEntry = (journal: Journal | undefined): ReportEntry => {
  const record = journal?.phases.findLast((phaseRecord) => phaseRecord.phase === "post_verify")
  if (record === undefined)
    return {
      check: "post_verify",
      status: "warning",
      summary: "no post-verify gate has run under the migration chain yet",
    }
  if (record.state === "completed")
    return {
      check: "post_verify",
      status: "success",
      summary: `post-verification gate passed (run ${record.outcome?.kind === "post_verify" ? record.outcome.runId : "unknown"})`,
    }
  return {
    check: "post_verify",
    status: "failure",
    summary: `post-verification gate failed: ${record.failure?.code ?? "unknown"}`,
    detail: record.failure?.detail ?? journal?.failure?.recoveryGuidance,
  }
}

/** One entry per M-2 orchestration phase: completed phases carry their outcome, a failed phase
 *  carries the journal's user-readable recovery guidance, a missing phase is a warning. */
const journalPhaseEntries = (journal: Journal | undefined): readonly ReportEntry[] => {
  if (journal === undefined) return []
  return MigrationOrchestrator.Phases.map((phase): ReportEntry => {
    const record = journal.phases.findLast((phaseRecord) => phaseRecord.phase === phase)
    if (record === undefined)
      return { check: `journal:${phase}`, status: "warning", summary: "phase has not run in this orchestration" }
    if (record.state === "completed")
      return { check: `journal:${phase}`, status: "success", summary: "phase completed", detail: JSON.stringify(record.outcome) }
    return {
      check: `journal:${phase}`,
      status: "failure",
      summary: `phase failed: ${record.failure?.code ?? "unknown"}`,
      detail: record.failure?.detail ?? journal.failure?.recoveryGuidance,
    }
  })
}

const mdReconciliationEntry = (reconciliation: MdExport.Reconciliation): ReportEntry =>
  reconciliation.reconciled
    ? {
        check: "md_reconcile",
        status: "success",
        summary: `md manifest↔library zero diff (${reconciliation.exportedCount}/${reconciliation.sessionCount} sessions)`,
      }
    : {
        check: "md_reconcile",
        status: "failure",
        summary: `md manifest↔library diff: ${reconciliation.missing.length} missing, ${reconciliation.extra.length} extra`,
        detail: [
          reconciliation.missing.length > 0 ? `missing session ids: ${reconciliation.missing.join(", ")}` : "",
          reconciliation.extra.length > 0 ? `extra session ids: ${reconciliation.extra.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; "),
      }

const rowReconciliationOf = (db: DatabaseService, manifest: MdExport.Manifest | undefined) =>
  Effect.gen(function* () {
    const sessions = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
    const messages = yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all().pipe(Effect.orDie)
    const rowReconciliation = {
      sessionsInLibrary: sessions.length,
      sessionsInManifest: manifest?.entries.length ?? 0,
      messagesInLibrary: messages.length,
      messagesInManifest: (manifest?.entries ?? []).reduce((sum, entry) => sum + entry.messageCount, 0),
    }
    return {
      ...rowReconciliation,
      reconciled:
        rowReconciliation.sessionsInLibrary === rowReconciliation.sessionsInManifest &&
        rowReconciliation.messagesInLibrary === rowReconciliation.messagesInManifest,
    }
  })

const rowReconciliationEntry = (rows: RowReconciliation): ReportEntry =>
  rows.reconciled
    ? {
        check: "row_reconcile",
        status: "success",
        summary: `session/message rows unchanged since export (${rows.sessionsInLibrary} sessions, ${rows.messagesInLibrary} messages)`,
      }
    : {
        check: "row_reconcile",
        status: "failure",
        summary: `session/message row drift since export: sessions ${rows.sessionsInManifest}→${rows.sessionsInLibrary}, messages ${rows.messagesInManifest}→${rows.messagesInLibrary}`,
        detail: "the library changed after the transcripts were exported; re-run the md_export phase to refresh the manifest",
      }

// -- generation ---------------------------------------------------------------------------------------------

export const generate = Effect.fn("MigrationReport.generate")(function* (input: GenerateInput) {
  const journalRead = yield* MigrationOrchestrator.readJournal(MigrationOrchestrator.journalPathFor(input.backupDir))
  const manifest = yield* MdExport.readManifest(MdExport.manifestPathFor(input.backupDir)).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  const mdReconciliation = manifest
    ? yield* MdExport.reconcile(input.db, manifest)
    : { reconciled: false, exportedCount: 0, sessionCount: 0, missing: [], extra: [] }
  const rowReconciliation = yield* rowReconciliationOf(input.db, manifest)

  const entries: readonly ReportEntry[] = [
    yield* Effect.promise(() => preflightEntry(input)).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed({
          check: "preflight",
          status: "failure" as const,
          summary: "preflight could not run",
          detail: String(cause),
        }),
      ),
    ),
    yield* dataIntegrityEntry(input.db),
    postVerifyEntry(journalRead),
    yield* backupVerifyEntry(journalRead),
    ...journalPhaseEntries(journalRead),
    ...(journalRead === undefined
      ? [
          {
            check: "journal",
            status: "warning" as const,
            summary: "no migration orchestration journal exists yet — run the migration chain first",
          },
        ]
      : []),
    ...(manifest === undefined
      ? [
          {
            check: "md_reconcile",
            status: "warning" as const,
            summary: "no md export manifest exists yet — the md_export phase has not produced transcripts",
          },
        ]
      : [mdReconciliationEntry(mdReconciliation)]),
    ...(manifest === undefined
      ? [
          {
            check: "row_reconcile",
            status: "warning" as const,
            summary: "row reconciliation skipped: no md export manifest to compare against",
          },
        ]
      : [rowReconciliationEntry(rowReconciliation)]),
  ]

  const report: Report = {
    version: 1,
    kind: "migration-compliance-report",
    dbPath: input.dbPath,
    backupDir: input.backupDir,
    ...(journalRead?.orchestrationId === undefined ? {} : { orchestrationId: journalRead.orchestrationId }),
    generatedAt: Date.now(),
    overall: overallOf(entries),
    entries,
    mdReconciliation,
    rowReconciliation,
  }
  yield* writeJsonAtomic(reportPathFor(input.backupDir), report)
  return report
})
