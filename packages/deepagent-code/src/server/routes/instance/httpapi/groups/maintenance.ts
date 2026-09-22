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
  recoveryCommand: `${root}/recovery/command`,
  recoveryCommandGet: `${root}/recovery/commandGet`,
  recoveryEvidenceExport: `${root}/recovery/evidenceExport`,
  compositionDigest: `${root}/composition/digest`,
  mdExport: `${root}/md/export`,
  mdExportStatus: `${root}/md/export/status`,
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
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "maintenance",
        description: "Maintenance + recovery HttpApi surface (C6-01).",
      }),
    )
    .middleware(Authorization),
)
