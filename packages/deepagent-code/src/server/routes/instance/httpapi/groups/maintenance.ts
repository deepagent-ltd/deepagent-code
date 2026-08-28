import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { DatabaseBootstrap } from "@deepagent-code/core/database/bootstrap"
import { UpgradeRun } from "@deepagent-code/core/contract/upgrade-run"
import { RecoveryCommandContract } from "@deepagent-code/core/contract/recovery-command"
import { Authorization } from "../middleware/authorization"
import { ApiTypedError } from "../typed-error"
import { described } from "./metadata"

// C6-01 (design §11.1): bootstrap health/status, backup list/verify, upgrade
// status and the C1B recovery descriptors/commands surface. Every error uses the
// C0-03 typed envelope (typed-error.ts). Client decisions use `code` +
// `retryability` + `httpStatus`, never `message`.

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
  status: Schema.Literal("dry_run"),
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
} as const

export const MaintenanceApi = HttpApi.make("maintenance").add(
  HttpApiGroup.make("maintenance")
    .add(
      HttpApiEndpoint.get("bootstrapStatus", MaintenancePaths.bootstrapStatus, {
        success: described(BootstrapStateSchema, "Current bootstrap state"),
        error: ApiTypedError,
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
        error: ApiTypedError,
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
        error: ApiTypedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.backup.verify",
          summary: "Verify a backup",
          description: "Runs the §10.4/§10.9 recoverability verification against a backup manifest.",
        }),
      ),
      HttpApiEndpoint.post("backupRestore", MaintenancePaths.backupRestore, {
        payload: RestoreInput,
        success: described(RestoreStatusSchema, "Restore dry-run status"),
        error: ApiTypedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.backup.restore",
          summary: "Restore (dry-run/status)",
          description:
            "Fixture-gated restore status surface: reports whether a restore could proceed and whether one is in progress. The actual restore install is a service call, not this endpoint (this lane).",
        }),
      ),
      HttpApiEndpoint.get("upgradeStatus", MaintenancePaths.upgradeStatus, {
        success: described(UpgradeStatusSchema, "Upgrade run status"),
        error: ApiTypedError,
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
        error: ApiTypedError,
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
        error: ApiTypedError,
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
        error: ApiTypedError,
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
        error: ApiTypedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.recovery.evidenceExport",
          summary: "Read an evidence export manifest",
          description: "Reads a redacted evidence export manifest by export id; a settled/expired export is a typed 410.",
        }),
      ),
      HttpApiEndpoint.post("recoveryEvidenceExportCreate", MaintenancePaths.recoveryEvidenceExport, {
        payload: EvidenceExportInput,
        success: described(EvidenceExportManifestSchema, "Evidence export manifest"),
        error: ApiTypedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "maintenance.recovery.evidenceExport.create",
          summary: "Export recovery evidence manifest",
          description: "Records an evidence export manifest for a session (default-redacted; the body stays behind the permission gate).",
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
