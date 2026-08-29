import type { RecoveryDescriptor } from "@deepagent-code/core/contract/recovery-command"

// Wire shapes for the C6-01 maintenance surface (packages/deepagent-code
// .../httpapi/groups/maintenance.ts). These mirror the server schemas so the
// LIC3 client is typed without depending on the server package. The shell consumes
// the C0-03 `ApiTypedError` envelope to decide on `code`/`httpStatus`/`actual`.

export const BOOTSTRAP_PHASES = [
  "shell_start",
  "preflight_read_only",
  "backup_required",
  "backup_verifying",
  "migration_applying",
  "recovery_reconciling",
  "post_verify",
  "ready",
  "read_only_recovery",
  "blocked_schema",
] as const
export type BootstrapPhase = (typeof BOOTSTRAP_PHASES)[number]

export const BOOTSTRAP_MODES = ["ready", "read_only_recovery", "blocked_schema"] as const
export type BootstrapMode = (typeof BOOTSTRAP_MODES)[number]

export interface BootstrapDiagnostics {
  stableCode: string
  mode: BootstrapMode
  phase: BootstrapPhase
  sqliteExtendedCode?: number
  runId?: string
  migrationId?: string
  table?: string
  key?: string
  constraint?: string
  trigger?: boolean
  buildDigest: string
  correlationId: string
  message: string
}

export interface BootstrapState {
  phase: BootstrapPhase
  mode: BootstrapMode
  ready: boolean
  diagnostics: BootstrapDiagnostics
  next: { action: "proceed" | "pause"; to: BootstrapPhase } | null
}

export interface BackupInfo {
  fileName: string
  filePath: string
  sizeBytes: number
  sha256: string
  createdAt: number
}

export interface BackupList {
  backups: BackupInfo[]
  count: number
}

export interface BackupVerifyOk {
  ok: true
  quickCheck: string
  foreignKeyCount: number
  journalMode: string
  synchronous: number
  capabilityCompatible: true
  capabilityCount: number
  migrationCount: number
  sqliteMasterCount: number
  sessionCount: number | null
  hashMatch: true
  schemaDigestMatch: true
}

export interface BackupVerifyFailure {
  ok: false
  reason: string
  detail: string
}

export type BackupVerify = BackupVerifyOk | BackupVerifyFailure

export interface RestoreStatus {
  status: "dry_run"
  inProgress: boolean
  restoreId?: string
  sourceFile?: string
  message: string
}

export interface MigrationReceiptRow {
  receiptId: string
  migrationId: string
  contentHash: string
  ordinal: number
  runId: string
  result: string
  startedAt: number
  completedAt: number
}

export interface RecoveryList {
  descriptors: RecoveryDescriptor[]
  count: number
}

export interface RecoveryDescriptorRecord {
  commandId: string
  sessionId: string
  attemptId: string
  requestHash: string
  descriptor: RecoveryDescriptor
  actorType: "user" | "administrator" | "system"
  actorId: string
  createdAt: number
}

export interface RecoveryCommandInput {
  session_id: string
  attempt_id: string
  request_hash: string
  actor_type: "user" | "administrator" | "system"
  actor_id: string
  activity_id?: string
  provider_id?: string
}

export interface RecoveryCommandResult {
  command_id: string
  descriptor: RecoveryDescriptor
}

export interface EvidenceExportInput {
  session_id: string
}

export interface EvidenceExportManifest {
  exportId: string
  sessionId: string
  ownerSessionId: string
  exportedAt: number
  expiresAt: number
  contentHash: string
}

export interface RestoreInput {
  backup_manifest_ref: string
  target?: string
  dry_run?: boolean
}

/** C0-03 typed error envelope (typed-error.ts): clients decide on `code`, never `message`. */
export interface MaintenanceErrorEnvelope {
  code: string
  category: string
  retryability: string
  httpStatus: number
  resource: string
  correlationId: string
  message?: string
  expected?: string
  actual?: string
}

export interface MaintenanceHttpError {
  name: "ApiBadRequest" | "ApiForbidden" | "ApiNotFound" | "ApiConflict" | "ApiGone" | "ApiLocked" | "ApiUnavailable"
  data: MaintenanceErrorEnvelope
}

/** A decoded maintenance call result: either typed data, a C0-03 typed error, or a transport failure. */
export type MaintenanceResult<T> = { data: T } | { error: MaintenanceHttpError } | { failure: MaintenanceFailure }

/** Network-level failure (offline, wrong URL, non-typed body) that is NOT a C0-03 decision. */
export type MaintenanceFailure = { kind: "network"; message: string } | { kind: "decode"; message: string }

/** Bootstrap status is reported as a typed error when the store is not writable (design §10.8). */
export type BootstrapStatusOutcome =
  | { kind: "ready"; state: BootstrapState }
  | { kind: "read_only_recovery"; state: BootstrapState }
  | { kind: "blocked_schema"; state: BootstrapState }
  | { kind: "unreachable"; error: MaintenanceFailure }
