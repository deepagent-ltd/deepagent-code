export * as DatabaseBootstrap from "./bootstrap"

import { randomUUID } from "node:crypto"
import type { PreflightIssue, PreflightResult } from "./preflight"

// Bootstrap state machine (design §10.2) and startup modes (design §10.8).
//
// The application shell starts FIRST at `shell_start` and always transitions to
// a read-only preflight (§10.3) before the business Database layer is opened.
// Only when bootstrap reaches `mode === "ready"` may business admission proceed.
//
//   shell_start
//     -> preflight_read_only
//         -> blocked_schema
//         -> backup_required
//             -> backup_verifying
//                 -> migration_applying
//                     -> recovery_reconciling
//                         -> post_verify
//                             -> ready
//                         -> read_only_recovery
//                     -> read_only_recovery
//                 -> blocked_schema
//
// This module is deliberately pure and dependency-free: it only maps a
// `PreflightResult` plus derived upgrade facts into a phase/mode/diagnostics
// triple, so the shell and the business Database layer share one authority.

export const BootstrapPhase = [
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
export type BootstrapPhase = (typeof BootstrapPhase)[number]

/** Startup modes from design §10.8. */
export const BootstrapMode = ["ready", "read_only_recovery", "blocked_schema"] as const
export type BootstrapMode = (typeof BootstrapMode)[number]

/** Stable bootstrap failure codes (design §10.8: stable code, never parse a message). */
export type BootstrapFailureCode =
  | "incompatible_binary"
  | "not_a_sqlite_database"
  | "migration_journal_divergent"
  | "migration_journal_gap"
  | "migration_journal_duplicate_id"
  | "migration_journal_content_mismatch"
  | "insufficient_space"
  | "non_local_filesystem"
  | "unfinished_upgrade_run"
  | "another_process_active"
  | "db_open_failed"
  | "recovery_pending"
  | "post_verify_failed"
  | "migration_failed"
  | "backup_failed"

/** Structured diagnostics (design §10.8): stable code + identity, no parsed messages. */
export interface BootstrapDiagnostics {
  stableCode: string
  mode: BootstrapMode
  phase: BootstrapPhase
  sqliteExtendedCode?: number
  runId?: string
  migrationId?: string
  table?: string
  key?: string
  /** C1A-14: constraint/trigger identity when the failure came from a constraint or trigger. */
  constraint?: string
  trigger?: boolean
  buildDigest: string
  correlationId: string
  message: string
}

export interface BootstrapState {
  phase: BootstrapPhase
  mode: BootstrapMode
  /** True only when business admission is allowed. */
  ready: boolean
  diagnostics: BootstrapDiagnostics
  /** The next legal phase, or null when the bootstrap is terminal. */
  next: { action: "proceed" | "pause"; to: BootstrapPhase } | null
  /** The preflight issues that produced this state (empty when the DB is safe). */
  issues: readonly PreflightIssue[]
}

/** Inputs to `describeBootstrap`: the preflight result plus derived upgrade facts. */
export interface BootstrapInput {
  preflight: PreflightResult
  /** Non-empty when the migration journal is behind the registry. */
  pendingMigrationIds: readonly string[]
  /** The database file exists (not a fresh install). */
  hasExistingDatabase: boolean
  /** §10.4: a non-empty user DB with pending migrations must back up first. */
  needsBackup: boolean
  /** A verified pre-upgrade backup is present (A3 provides the backing service). */
  backupReady: boolean
  /** An interrupted/mid-flight upgrade run or active process requires reconcile. */
  recoveryRequired: boolean
  /** Reconciliation finished (A4/A5 provide recovery). */
  recoveryComplete: boolean
  /** Data-integrity / recovery-binding post-verify passed (A5 provides the gate). */
  postVerifyPassed: boolean
}

// Hard blockers: the binary must NOT open the business DB nor touch the file.
const HARD_BLOCKER_PHASE: Readonly<Record<string, BootstrapFailureCode>> = {
  not_a_sqlite_database: "not_a_sqlite_database",
  incompatible_binary: "incompatible_binary",
  migration_journal_unknown_lineage: "migration_journal_divergent",
  migration_journal_gap: "migration_journal_gap",
  migration_journal_duplicate_id: "migration_journal_duplicate_id",
  migration_journal_content_mismatch: "migration_journal_content_mismatch",
  insufficient_space: "insufficient_space",
  non_local_filesystem: "non_local_filesystem",
  db_open_failed: "db_open_failed",
}

// Recovery signals: the binary is compatible, but the database is not safe to write.
const RECOVERY_ISSUE_CODES: ReadonlySet<string> = new Set([
  "unfinished_upgrade_run",
  "another_process_active",
])

/** Allowed transitions; everything else is an illegal bootstrap transition. */
export const ALLOWED_BOOTSTRAP_TRANSITIONS: Readonly<Record<BootstrapPhase, readonly BootstrapPhase[]>> = {
  shell_start: ["preflight_read_only"],
  preflight_read_only: ["blocked_schema", "backup_required"],
  backup_required: ["backup_verifying"],
  backup_verifying: ["migration_applying", "blocked_schema"],
  migration_applying: ["recovery_reconciling", "read_only_recovery"],
  recovery_reconciling: ["post_verify", "read_only_recovery"],
  post_verify: ["ready", "read_only_recovery"],
  ready: [],
  read_only_recovery: [],
  blocked_schema: [],
}

/** Whether `from -> to` is a legal bootstrap transition. */
export const canBootstrapTransition = (from: BootstrapPhase, to: BootstrapPhase): boolean =>
  ALLOWED_BOOTSTRAP_TRANSITIONS[from].includes(to)

/** Typed error for an illegal bootstrap transition. */
export class InvalidBootstrapTransitionError extends Error {
  override readonly name = "InvalidBootstrapTransitionError"
  constructor(
    readonly from: BootstrapPhase,
    readonly to: BootstrapPhase,
  ) {
    super(`invalid bootstrap transition ${from} -> ${to}`)
  }
}

/** Throws `InvalidBootstrapTransitionError` unless `from -> to` is a legal transition. */
export const assertBootstrapTransition = (from: BootstrapPhase, to: BootstrapPhase): void => {
  if (!canBootstrapTransition(from, to)) throw new InvalidBootstrapTransitionError(from, to)
}

interface DescribeOptions {
  readonly buildDigest: string
  readonly correlationId?: string
}

// SEC-F8: the diagnostics surface is rendered by the maintenance shell and client
// UIs; keep path-shaped identifiers scoped to their basename so an absolute
// filesystem path never echoes downstream (the full resource stays in the
// PreflightIssue records and the internal log).
const scopedIdentifier = (value: string | undefined): string | undefined => {
  if (!value) return value
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value)) {
    const parts = value.split(/[/\\]/).filter((item) => item.length > 0)
    return parts.at(-1) ?? value
  }
  return value
}

const buildDiagnostics = (
  phase: BootstrapPhase,
  mode: BootstrapMode,
  options: DescribeOptions,
  message: string,
  issue?: PreflightIssue,
  extras?: Partial<BootstrapDiagnostics>,
): BootstrapDiagnostics => ({
  stableCode: issue?.code ?? (mode === "ready" ? "ready" : phase),
  mode,
  phase,
  sqliteExtendedCode: issue?.sqliteExtendedCode ?? extras?.sqliteExtendedCode,
  runId: scopedIdentifier(issue?.resource ?? extras?.runId),
  migrationId: extras?.migrationId,
  table: extras?.table,
  key: extras?.key,
  constraint: issue?.constraint ?? extras?.constraint,
  trigger: issue?.trigger ?? extras?.trigger,
  buildDigest: options.buildDigest,
  correlationId: options.correlationId ?? randomUUID(),
  message,
})

const state = (
  phase: BootstrapPhase,
  mode: BootstrapMode,
  options: DescribeOptions,
  message: string,
  issue?: PreflightIssue,
  extras?: Partial<BootstrapDiagnostics>,
): BootstrapState => {
  const diagnostics = buildDiagnostics(phase, mode, options, message, issue, extras)
  const to = ALLOWED_BOOTSTRAP_TRANSITIONS[phase][0]
  return {
    phase,
    mode,
    ready: mode === "ready",
    diagnostics,
    next: to === undefined ? null : { action: "proceed", to },
    issues: issue ? [issue] : [],
  }
}

/**
 * Determine the bootstrap phase/mode/diagnostics from a read-only preflight
 * result plus the derived upgrade facts. The result is authoritative for whether
 * the business Database layer may be opened (`ready === true`).
 */
export const describeBootstrap = (input: BootstrapInput, options: DescribeOptions): BootstrapState => {
  const issues = input.preflight.ok ? [] : input.preflight.issues
  const first = issues[0]

  // 1. Hard blockers always win: the binary must never open / migrate the DB.
  for (const issue of issues) {
    const blocked = HARD_BLOCKER_PHASE[issue.code]
    if (blocked) return state("blocked_schema", "blocked_schema", options, issue.message, issue)
  }

  // 2. Recovery signals: compatible binary, but not safe to write yet. The phase
  //    reflects whether we are still reconciling a prior run or awaiting post-verify.
  for (const issue of issues) {
    if (RECOVERY_ISSUE_CODES.has(issue.code)) {
      const recoveryPhase = input.recoveryComplete ? "post_verify" : "recovery_reconciling"
      return state(recoveryPhase, "read_only_recovery", options, issue.message, issue)
    }
  }

  // 3. Explicit recovery required even when preflight passed (e.g. an interrupted run
  //    that leaves no hard blocker but must reconcile before write).
  if (input.recoveryRequired && !input.recoveryComplete)
    return state("read_only_recovery", "read_only_recovery", options, "recovery required before admission", first)

  // 4. Fresh install: nothing to reconcile, no existing data to back up. The shell may
  //    proceed to create the schema.
  if (!input.hasExistingDatabase)
    return state("migration_applying", "ready", options, "fresh database: creating schema")

  // 5. Existing database that is already up to date.
  if (input.pendingMigrationIds.length === 0)
    return state("ready", "ready", options, "database ready")

  // 6. Existing database with forward migrations pending. §10.4 requires a verified
  //    backup before applying to a non-empty user DB.
  if (input.needsBackup && !input.backupReady)
    return state("backup_required", "ready", options, "backup required before migration")
  return state("migration_applying", "ready", options, "applying forward migrations")
}

/**
 * Error raised by the business Database layer when bootstrap is NOT ready. It
 * carries the full BootstrapState (phase/mode/diagnostics) so a shell can
 * render the recovery phase instead of crashing, and never admits business SQL.
 */
export class DatabaseBootstrapError extends Error {
  override readonly name = "DatabaseBootstrapError"
  constructor(readonly state: BootstrapState) {
    super(state.diagnostics.message)
  }
}
