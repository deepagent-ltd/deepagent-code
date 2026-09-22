import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { DatabaseBootstrap } from "@deepagent-code/core/database/bootstrap"
import { UpgradeRun } from "@deepagent-code/core/contract/upgrade-run"
import { RecoveryCommandContract } from "@deepagent-code/core/contract/recovery-command"
import { CompositionDigest } from "@/effect/composition-digest"
import { Authorization } from "../middleware/authorization"
import { ApiTypedErrors } from "../typed-error"
import { described } from "./metadata"

// C6-01 (design §11.1): process-admin bootstrap health/status, backup list/verify,
// upgrade status and the C1B recovery descriptors/commands surface. This API owns
// the process database and intentionally has no workspace/directory routing. It is
// composed beside InstanceHttpApi, never inside it. Every error uses the C0-03
// typed envelope (typed-error.ts). Client decisions use `code` + `retryability` +
// `httpStatus`, never `message`.

const root = ""

const BootstrapPhaseLiteral = Schema.Literals([...DatabaseBootstrap.BootstrapPhase])
const BootstrapModeLiteral = Schema.Literals([...DatabaseBootstrap.BootstrapMode])

const BootstrapDiagnosticsSchema = Schema.Struct({
  stableCode: Schema.String,
  mode: BootstrapModeLiteral,
  phase: BootstrapPhaseLiteral,
  sqliteExtendedCode: Schema.optional(Schema.Number),
  runId: Schema.optional(Schema.String),
  migrationId: Schema.optional(Schema.String),
  table: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  constraint: Schema.optional(Schema.String),
  trigger: Schema.optional(Schema.Boolean),
  buildDigest: Schema.String,
  correlationId: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "BootstrapDiagnostics" })

const BootstrapStateSchema = Schema.Struct({
  phase: BootstrapPhaseLiteral,
  mode: BootstrapModeLiteral,
  ready: Schema.Boolean,
  diagnostics: BootstrapDiagnosticsSchema,
  next: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ action: Schema.Literal("proceed"), to: BootstrapPhaseLiteral }),
      Schema.Struct({ action: Schema.Literal("pause"), to: BootstrapPhaseLiteral }),
    ]),
  ),
}).annotate({ identifier: "BootstrapState" })

const BackupInfoSchema = Schema.Struct({
  fileName: Schema.String,
  filePath: Schema.String,
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String,
  createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "BackupInfo" })

const BackupListSchema = Schema.Struct({
  backups: Schema.Array(BackupInfoSchema),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "BackupList" })

const BackupVerifyOkSchema = Schema.Struct({
  ok: Schema.Literal(true),
  quickCheck: Schema.String,
  foreignKeyCount: Schema.Int,
  journalMode: Schema.String,
  synchronous: Schema.Int,
  capabilityCompatible: Schema.Literal(true),
  capabilityCount: Schema.Int,
  migrationCount: Schema.Int,
  sqliteMasterCount: Schema.Int,
  sessionCount: Schema.NullOr(Schema.Int),
  hashMatch: Schema.Literal(true),
  schemaDigestMatch: Schema.Literal(true),
})

const BackupVerifyFailureSchema = Schema.Struct({
  ok: Schema.Literal(false),
  reason: Schema.String,
  detail: Schema.String,
})

const BackupVerifySchema = Schema.Union([BackupVerifyOkSchema, BackupVerifyFailureSchema]).annotate({
  identifier: "BackupVerify",
})

const RestoreStatusSchema = Schema.Struct({
  // A dry_run request reports "dry_run"; a real verified restore reports "restored". Failures use
  // the typed error contract and retain the quarantine instead of returning a false success body.
  status: Schema.Literals(["dry_run", "restored", "failed"]),
  inProgress: Schema.Boolean,
  restoreId: Schema.optional(Schema.String),
  sourceFile: Schema.optional(Schema.String),
  message: Schema.String,
}).annotate({ identifier: "RestoreStatus" })

const ReceiptRowSchema = Schema.Struct({
  receiptId: Schema.String,
  migrationId: Schema.String,
  contentHash: Schema.String,
  ordinal: Schema.Int,
  runId: Schema.String,
  result: Schema.String,
  startedAt: Schema.Int,
  completedAt: Schema.Int,
}).annotate({ identifier: "MigrationReceipt" })

const UpgradeStatusSchema = Schema.Struct({
  active: Schema.Boolean,
  run: Schema.optional(UpgradeRun),
  receipts: Schema.Array(ReceiptRowSchema),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "UpgradeStatus" })

const RecoveryListSchema = Schema.Struct({
  descriptors: Schema.Array(RecoveryCommandContract.RecoveryDescriptor),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "RecoveryList" })

const RecoveryCommandInput = Schema.Struct({
  session_id: Schema.String,
  attempt_id: Schema.String,
  request_hash: Schema.String,
  actor_type: Schema.Literals(["user", "administrator", "system"]),
  actor_id: Schema.String,
  activity_id: Schema.optional(Schema.String),
  provider_id: Schema.optional(Schema.String),
}).annotate({ identifier: "RecoveryCommandInput" })

const RecoveryCommandResultSchema = Schema.Struct({
  command_id: Schema.String,
  descriptor: RecoveryCommandContract.RecoveryDescriptor,
}).annotate({ identifier: "RecoveryCommandResult" })

const RecoveryDescriptorRecordSchema = Schema.Struct({
  commandId: Schema.String,
  sessionId: Schema.String,
  attemptId: Schema.String,
  requestHash: Schema.String,
  descriptor: RecoveryCommandContract.RecoveryDescriptor,
  actorType: Schema.Literals(["user", "administrator", "system"]),
  actorId: Schema.String,
  createdAt: Schema.Int,
}).annotate({ identifier: "RecoveryDescriptorRecord" })

const EvidenceExportInput = Schema.Struct({
  session_id: Schema.String,
}).annotate({ identifier: "EvidenceExportInput" })

const EvidenceExportManifestSchema = Schema.Struct({
  exportId: Schema.String,
  sessionId: Schema.String,
  ownerSessionId: Schema.String,
  exportedAt: Schema.Int,
  expiresAt: Schema.Int,
  contentHash: Schema.String,
}).annotate({ identifier: "EvidenceExportManifest" })

/** One Session the startup redrive left fenced, with its typed blocked reason (K-01 R-4). */
const RecoveryRedriveBlockedSchema = Schema.Struct({
  sessionID: Schema.String,
  blockedReason: Schema.Literals(["recovery_required", "owned_elsewhere", "authority_conflict"]),
}).annotate({ identifier: "RecoveryRedriveBlocked" })

const RecoveryRedriveBlockedResultSchema = Schema.Struct({
  blocked: Schema.Array(RecoveryRedriveBlockedSchema),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "RecoveryRedriveBlockedResult" })

const CommandGetQuery = Schema.Struct({
  command_id: Schema.String,
})

const SessionQuery = Schema.Struct({
  session_id: Schema.String,
})

const EvidenceExportQuery = Schema.Struct({
  export_id: Schema.String,
})

// W-02 M-1 — batch full-transcript Markdown export surface. The result body doubles as the
// reconciliation report (manifest entries vs the durable session list), so M-3/M-6 consumers can
// render progress without re-deriving it.

const MdExportReconciliationSchema = Schema.Struct({
  reconciled: Schema.Boolean,
  exportedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sessionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  missing: Schema.Array(Schema.String),
  extra: Schema.Array(Schema.String),
}).annotate({ identifier: "MdExportReconciliation" })

const MdExportRunSchema = Schema.Struct({
  exported: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sessionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  manifestPath: Schema.String,
  reconciliation: MdExportReconciliationSchema,
}).annotate({ identifier: "MdExportRun" })

const MdExportStatusSchema = Schema.Struct({
  exists: Schema.Boolean,
  manifestPath: Schema.String,
  exportedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  entries: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      fileName: Schema.String,
      sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      sha256: Schema.String,
      messageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      exportedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
}).annotate({ identifier: "MdExportStatus" })

const MdExportInput = Schema.Struct({
  dir: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.pipe(Schema.decodeTo(Schema.Int.check(Schema.isGreaterThan(0)))),
  ).annotate({ description: "Export at most this many NEW sessions; omitted means all." }),
  page_size: Schema.optional(
    Schema.NumberFromString.pipe(Schema.decodeTo(Schema.Int.check(Schema.isGreaterThan(0)))),
  ).annotate({ description: "Keyset page size for the session traversal." }),
}).annotate({ identifier: "MdExportInput" })

// W-02 M-2 — migration flow orchestration surface. The journal is the persisted phase record; a
// restart (or the status endpoint) shows exactly which phase the chain stopped at.

const MigrationPhaseLiteral = Schema.Literals([
  "md_export",
  "backup_create",
  "backup_verify",
  "migration_apply",
  "post_verify",
  "archive",
  "disk_advisory",
])

const MigrationPhaseRecordSchema = Schema.Struct({
  phase: MigrationPhaseLiteral,
  state: Schema.Literals(["completed", "failed"]),
  startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  completedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: Schema.optional(Schema.Unknown),
  failure: Schema.optional(Schema.Struct({ code: Schema.String, detail: Schema.String })),
}).annotate({ identifier: "MigrationPhaseRecord" })

const MigrationJournalSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("migration-orchestration-journal"),
  orchestrationId: Schema.String,
  dbPath: Schema.String,
  startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  updatedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.Literals(["in_progress", "completed", "failed"]),
  currentPhase: Schema.optional(MigrationPhaseLiteral),
  phases: Schema.Array(MigrationPhaseRecordSchema),
  failure: Schema.optional(
    Schema.Struct({
      phase: MigrationPhaseLiteral,
      code: Schema.String,
      detail: Schema.String,
      recoveryGuidance: Schema.String,
    }),
  ),
}).annotate({ identifier: "MigrationJournal" })

const MigrationRunInput = Schema.Struct({
  dir: Schema.optional(Schema.String),
  stop_after: Schema.optional(MigrationPhaseLiteral).annotate({
    description: "Stop after this phase completes (staged invocation / interruption drill); a later call resumes.",
  }),
}).annotate({ identifier: "MigrationRunInput" })

const MigrationRunSchema = Schema.Struct({
  status: Schema.Literals(["in_progress", "completed", "failed"]),
  journal: MigrationJournalSchema,
  diskAdvisoryPath: Schema.optional(Schema.String),
}).annotate({ identifier: "MigrationRun" })

const MigrationStatusSchema = Schema.Struct({
  active: Schema.Boolean,
  journal: Schema.optional(MigrationJournalSchema),
}).annotate({ identifier: "MigrationStatus" })

// W-02 M-3 — post-migration compliance report surface. Aggregates Preflight + DataIntegrity +
// PostVerify + BackupVerify + the M-2 journal phase outcomes + the md-manifest↔library and
// session/message row reconciliation oracles into one three-state (success/warning/failure)
// user-readable document persisted under the backups root.

const MigrationReportStatusLiteral = Schema.Literals(["success", "warning", "failure"])

const MigrationReportEntrySchema = Schema.Struct({
  check: Schema.String,
  status: MigrationReportStatusLiteral,
  summary: Schema.String,
  detail: Schema.optional(Schema.String),
}).annotate({ identifier: "MigrationReportEntry" })

const MigrationRowReconciliationSchema = Schema.Struct({
  sessionsInLibrary: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sessionsInManifest: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  messagesInLibrary: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  messagesInManifest: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reconciled: Schema.Boolean,
}).annotate({ identifier: "MigrationRowReconciliation" })

const MigrationReportSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("migration-compliance-report"),
  dbPath: Schema.String,
  backupDir: Schema.String,
  orchestrationId: Schema.optional(Schema.String),
  generatedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  overall: MigrationReportStatusLiteral,
  entries: Schema.Array(MigrationReportEntrySchema),
  mdReconciliation: MdExportReconciliationSchema,
  rowReconciliation: MigrationRowReconciliationSchema,
}).annotate({ identifier: "MigrationReport" })

const MigrationReportInput = Schema.Struct({
  dir: Schema.optional(Schema.String),
}).annotate({ identifier: "MigrationReportInput" })

const MigrationReportStoredSchema = Schema.Struct({
  exists: Schema.Boolean,
  reportPath: Schema.String,
  report: Schema.optional(MigrationReportSchema),
}).annotate({ identifier: "MigrationReportStored" })

// W-02 M-4 — backups governance surface. Retention (newest N + one per migration milestone) with
// over-aged backups compressed+moved into <backupDir>/archive/, never silently deleted; every
// retained manifest is stamped with the md-export pairing (BackupManifest.mdExports).

const BackupGovernedSchema = Schema.Struct({
  fileName: Schema.String,
  manifestPath: Schema.String,
  createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  milestone: Schema.Boolean,
  action: Schema.Literals(["kept", "archived"]),
}).annotate({ identifier: "BackupGoverned" })

const BackupGovernanceReportSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("backup-governance-report"),
  backupDir: Schema.String,
  generatedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  policy: Schema.Struct({ keep: Schema.Int, milestoneRule: Schema.String }),
  backups: Schema.Array(BackupGovernedSchema),
  archivedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  archivedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  mdExports: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.Struct({ manifestPath: Schema.String, reason: Schema.String })),
}).annotate({ identifier: "BackupGovernanceReport" })

const BackupGovernInput = Schema.Struct({
  dir: Schema.optional(Schema.String),
  keep: Schema.optional(Schema.NumberFromString.pipe(Schema.decodeTo(Schema.Int.check(Schema.isGreaterThan(0))))).annotate({
    description: "How many of the newest non-milestone backups to retain (default 3).",
  }),
}).annotate({ identifier: "BackupGovernInput" })

// W-02 M-5 — disk reclaim surface. Full data-root inventory + safety-checked residue candidates;
// deletion (and the optional main-db VACUUM) runs ONLY with confirm:true.

const DiskInventoryEntrySchema = Schema.Struct({
  path: Schema.String,
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  category: Schema.Literals([
    "main_db",
    "wal_sidecar",
    "backup",
    "backup_archived",
    "md_export",
    "migration_archive",
    "restore_incident",
    "operational",
    "residue_candidate",
    "other_data",
  ]),
  note: Schema.String,
}).annotate({ identifier: "DiskInventoryEntry" })

const DiskReclaimCandidateSchema = Schema.Struct({
  path: Schema.String,
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fromAdvisory: Schema.Boolean,
  safe: Schema.Boolean,
  blockedReason: Schema.optional(Schema.String),
  deleted: Schema.Boolean,
}).annotate({ identifier: "DiskReclaimCandidate" })

const DiskReclaimReportSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("disk-reclaim-report"),
  dataRoot: Schema.String,
  dbPath: Schema.String,
  backupDir: Schema.String,
  generatedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  executed: Schema.Boolean,
  vacuumed: Schema.Boolean,
  inventory: Schema.Array(DiskInventoryEntrySchema),
  totalBytesBefore: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalBytesAfter: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reclaimedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  beforeMiB: Schema.String,
  afterMiB: Schema.String,
  reclaimedMiB: Schema.String,
  candidates: Schema.Array(DiskReclaimCandidateSchema),
  restoreIncidentsBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  restoreIncidentsNeverDeleted: Schema.Literal(true),
}).annotate({ identifier: "DiskReclaimReport" })

const DiskReclaimInput = Schema.Struct({
  dir: Schema.optional(Schema.String),
  confirm: Schema.optional(Schema.Boolean).annotate({
    description: "The user confirmation gate: nothing is deleted unless this is exactly true.",
  }),
  vacuum: Schema.optional(Schema.Boolean).annotate({
    description: "VACUUM the main database after the residue deletion (requires confirm).",
  }),
}).annotate({ identifier: "DiskReclaimInput" })

const BackupQuery = Schema.Struct({
  dir: Schema.optional(Schema.String),
})

const VerifyQuery = Schema.Struct({
  manifest_path: Schema.String,
})

const RestoreInput = Schema.Struct({
  backup_manifest_ref: Schema.String,
  target: Schema.optional(Schema.String),
  dry_run: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "RestoreInput" })

export const MaintenancePaths = {
  bootstrapStatus: `${root}/bootstrap/status`,
  backupList: `${root}/backup/list`,
  backupVerify: `${root}/backup/verify`,
  backupRestore: `${root}/backup/restore`,
  upgradeStatus: `${root}/upgrade/status`,
  recoveryList: `${root}/recovery/list`,
  recoveryRedriveBlocked: `${root}/recovery/redriveBlocked`,
  recoveryCommand: `${root}/recovery/command`,
  recoveryCommandGet: `${root}/recovery/commandGet`,
  recoveryEvidenceExport: `${root}/recovery/evidenceExport`,
  compositionDigest: `${root}/composition/digest`,
  mdExport: `${root}/md/export`,
  mdExportStatus: `${root}/md/export/status`,
  migrationRun: `${root}/migration/run`,
  migrationStatus: `${root}/migration/status`,
  migrationReport: `${root}/migration/report`,
  backupsGovern: `${root}/backups/govern`,
  diskReclaim: `${root}/disk/reclaim`,
} as const

export const MaintenanceApi = HttpApi.make("maintenance").add(
  HttpApiGroup.make("maintenance")
    .add(
      HttpApiEndpoint.get("bootstrapStatus", MaintenancePaths.bootstrapStatus, {
        success: described(BootstrapStateSchema, "Current bootstrap state"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.bootstrap.status",
          summary: "Bootstrap health/status",
          description:
            "Reports the current database bootstrap phase/mode/diagnostics. 200 when ready; a typed 423/503 when in read_only_recovery or blocked_schema.",
        }),
      ),
      HttpApiEndpoint.get("backupList", MaintenancePaths.backupList, {
        query: BackupQuery,
        success: described(BackupListSchema, "Backup manifest list"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.backup.list",
          summary: "List backup manifests",
          description: "Lists available consistency backups and their manifest identity fields.",
        }),
      ),
      HttpApiEndpoint.get("backupVerify", MaintenancePaths.backupVerify, {
        query: VerifyQuery,
        success: described(BackupVerifySchema, "Backup verify result"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.backup.verify",
          summary: "Verify a backup",
          description: "Runs the §10.4/§10.9 recoverability verification against a backup manifest.",
        }),
      ),
      HttpApiEndpoint.post("backupRestore", MaintenancePaths.backupRestore, {
        payload: RestoreInput,
        success: described(RestoreStatusSchema, "Verified restore status"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.backup.restore",
          summary: "Verify or restore a backup",
          description:
            "Verifies the selected backup. In the incident-only maintenance shell, dry_run:false acquires the exclusive database owner, quarantines the current DB/WAL/SHM, restores and forward-migrates, then requires a process restart. A live business runtime refuses installation.",
        }),
      ),
      HttpApiEndpoint.get("upgradeStatus", MaintenancePaths.upgradeStatus, {
        success: described(UpgradeStatusSchema, "Upgrade run status"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.upgrade.status",
          summary: "Upgrade run status",
          description: "Reports the active upgrade run state and the migration receipts recorded under it.",
        }),
      ),
      HttpApiEndpoint.get("recoveryList", MaintenancePaths.recoveryList, {
        query: SessionQuery,
        success: described(RecoveryListSchema, "Recovery descriptors for a session"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.recovery.list",
          summary: "List recovery descriptors",
          description: "Lists the C1B recovery descriptors recorded for a session.",
        }),
      ),
      HttpApiEndpoint.post("recoveryCommand", MaintenancePaths.recoveryCommand, {
        payload: RecoveryCommandInput,
        success: described(RecoveryCommandResultSchema, "Classified recovery command"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.recovery.command",
          summary: "Classify + record a recovery command",
          description: "Classifies an attempt into the frozen RecoveryDescriptor and records the command.",
        }),
      ),
      HttpApiEndpoint.get("recoveryRedriveBlocked", MaintenancePaths.recoveryRedriveBlocked, {
        success: described(RecoveryRedriveBlockedResultSchema, "Redrive-blocked Sessions"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.recovery.redriveBlocked",
          summary: "List Sessions the startup redrive left fenced",
          description:
            "The structured surfacing of the startup redrive `blocked` outcome: every Session " +
            "whose durable claim cannot exact-release, with its typed blocked reason. The " +
            "incident-only maintenance shell constructs no business runtime and answers a typed 503.",
        }),
      ),
      HttpApiEndpoint.get("recoveryCommandGet", MaintenancePaths.recoveryCommandGet, {
        query: CommandGetQuery,
        success: described(RecoveryDescriptorRecordSchema, "Recovery command record"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.recovery.commandGet",
          summary: "Get a recovery command",
          description: "Reads a single recovery command/descriptor record by command id.",
        }),
      ),
      HttpApiEndpoint.get("recoveryEvidenceExport", MaintenancePaths.recoveryEvidenceExport, {
        query: EvidenceExportQuery,
        success: described(EvidenceExportManifestSchema, "Evidence export manifest"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.recovery.evidenceExport",
          summary: "Read an evidence export manifest",
          description:
            "Reserved encrypted evidence-export endpoint; returns typed 503 until artifact and unlock authorities are available.",
        }),
      ),
      HttpApiEndpoint.post("recoveryEvidenceExportCreate", MaintenancePaths.recoveryEvidenceExport, {
        payload: EvidenceExportInput,
        success: described(EvidenceExportManifestSchema, "Evidence export manifest"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.recovery.evidenceExport.create",
          summary: "Export recovery evidence manifest",
          description:
            "Reserved encrypted evidence-export endpoint; never emits a manifest without an encrypted artifact and unlock authority.",
        }),
      ),
      HttpApiEndpoint.get("compositionDigest", MaintenancePaths.compositionDigest, {
        success: described(CompositionDigest.Record, "Root composition digest"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.composition.digest",
          summary: "Root composition digest",
          description:
            "Reports the stable composition digest of this process root (session owner, tool registry, database, Location host). The incident-only maintenance shell constructs no business runtime and answers a typed 503 instead.",
        }),
      ),
      HttpApiEndpoint.post("mdExport", MaintenancePaths.mdExport, {
        payload: MdExportInput,
        success: described(MdExportRunSchema, "Batch MD export result"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.md.export.run",
          summary: "Batch-export every session transcript as Markdown",
          description:
            "W-02 M-1: paginates every durable session, reads it through the V2 history loader, and writes <backupDir>/md/<slug>-<date>.md with a per-file sha256 manifest. Interruptible and resumable: re-invocation skips sessions whose manifest entry still matches the file on disk. limit exports at most that many NEW sessions this call.",
        }),
      ),
      HttpApiEndpoint.get("mdExportStatus", MaintenancePaths.mdExportStatus, {
        query: BackupQuery,
        success: described(MdExportStatusSchema, "MD export manifest status"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.md.export.status",
          summary: "Read the MD export manifest",
          description:
            "Reads the md/manifest.json summary (entry list) without exporting. Also served by the incident-only maintenance shell against a read-only store.",
        }),
      ),
      HttpApiEndpoint.post("migrationRun", MaintenancePaths.migrationRun, {
        payload: MigrationRunInput,
        success: described(MigrationRunSchema, "Migration orchestration result"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.migration.run",
          summary: "Run or resume the V1→V2 migration flow",
          description:
            "W-02 M-2: chains md_export → backup_create → backup_verify → migration_apply → post_verify → archive → disk_advisory. Idempotent phases with a persisted journal; any failure stops the chain with a structured phase failure + recovery guidance; re-running resumes. The upgrade-run state machine itself is untouched (external orchestration).",
        }),
      ),
      HttpApiEndpoint.get("migrationStatus", MaintenancePaths.migrationStatus, {
        query: BackupQuery,
        success: described(MigrationStatusSchema, "Migration orchestration journal"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.migration.status",
          summary: "Read the migration orchestration journal",
          description:
            "Reads the persisted phase journal — after a restart this shows exactly which phase the chain stopped at. Also served by the incident-only maintenance shell.",
        }),
      ),
      HttpApiEndpoint.post("migrationReport", MaintenancePaths.migrationReport, {
        payload: MigrationReportInput,
        success: described(MigrationReportSchema, "Migration compliance report"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.migration.report.generate",
          summary: "Generate the post-migration compliance report",
          description:
            "W-02 M-3: aggregates preflight + data integrity + post-verify + backup verify + the orchestration journal phase outcomes + the md/row reconciliation oracles into a three-state report persisted to <backupDir>/migration-report.json. Every check runs read-only, so the incident maintenance shell serves it too.",
        }),
      ),
      HttpApiEndpoint.get("migrationReportStatus", MaintenancePaths.migrationReport, {
        query: BackupQuery,
        success: described(MigrationReportStoredSchema, "Persisted migration compliance report"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.migration.report.status",
          summary: "Read the persisted migration compliance report",
          description:
            "Reads the last generated migration-report.json without re-running any oracle. Also served by the incident-only maintenance shell.",
        }),
      ),
      HttpApiEndpoint.post("backupsGovern", MaintenancePaths.backupsGovern, {
        payload: BackupGovernInput,
        success: described(BackupGovernanceReportSchema, "Backups governance report"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.backups.govern",
          summary: "Run backups retention governance",
          description:
            "W-02 M-4: keeps the newest N (default 3) backups plus every migration-milestone backup; over-aged backups are gzip-compressed and MOVED into <backupDir>/archive/ (never silently deleted). Retained manifests are stamped with the md-export pairing (BackupManifest.mdExports). Produces and persists a governance report.",
        }),
      ),
      HttpApiEndpoint.post("diskReclaim", MaintenancePaths.diskReclaim, {
        payload: DiskReclaimInput,
        success: described(DiskReclaimReportSchema, "Disk reclaim report"),
        error: ApiTypedErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.disk.reclaim",
          summary: "Inventory and reclaim operational residue",
          description:
            "W-02 M-5: measures the whole data root (Global.Path), classifies deletion candidates (multi-channel DBs, manual .bak, repro DBs, orphaned tmp), safety-checks them against every manifest reference, and — ONLY with confirm:true — deletes them and optionally VACUUMs the main database. restore-incidents/ is NEVER deleted (design §3.1 ruling); the report carries exact before/after byte counts.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "maintenance",
        description: "Maintenance + recovery HttpApi surface (C6-01).",
      }),
    )
    .middleware(Authorization),
)
