export * as Diagnostics from "./diagnostics"

import { createHash, randomUUID } from "node:crypto"
import { ErrorContract, isRegisteredCode } from "../contract/error-code"

// C1A-14 MIGRATION/BACKUP/RESTORE/PREFLIGHT DIAGNOSTICS (design §10.8: "任何错误都输出 stable code、
// SQLite extended code、constraint/trigger、migration/run ID、table/key、build/registry digest 和
// correlation ID；日志默认不含 prompt、tool payload 或凭据").
//
// This module turns a raw error (an effect SqlError, a bun:sqlite SQLiteError, or any thrown value)
// into a structured diagnostic WITHOUT echoing payload: the message is assembled from the frozen
// C0-03 stable code (consumed, never rewritten), the SQLite extended code + constraint/trigger name,
// the run/migration/table/key identity, the build/registry digest and a correlation id. A sanitizer
// redacts credential-like text defensively, and the diagnostic NEVER embeds prompt/tool/SQL payload.

/** Numeric SQLite extended result codes for the constraint family (power-loss/trigger detail). */
const EXTENDED_CODES: Readonly<Record<string, number>> = {
  SQLITE_OK: 0,
  SQLITE_ERROR: 1,
  SQLITE_READONLY: 8,
  SQLITE_CONSTRAINT: 19,
  SQLITE_CONSTRAINT_CHECK: 275,
  SQLITE_CONSTRAINT_COMMITHOOK: 531,
  SQLITE_CONSTRAINT_FOREIGNKEY: 787,
  SQLITE_CONSTRAINT_FUNCTION: 1043,
  SQLITE_CONSTRAINT_NOTNULL: 1299,
  SQLITE_CONSTRAINT_PRIMARYKEY: 1555,
  SQLITE_CONSTRAINT_TRIGGER: 1811,
  SQLITE_CONSTRAINT_UNIQUE: 2067,
  SQLITE_CONSTRAINT_VTAB: 2323,
  SQLITE_CONSTRAINT_ROWID: 2579,
  SQLITE_CONSTRAINT_PINNED: 2835,
  SQLITE_CONSTRAINT_DATATYPE: 3091,
  SQLITE_IOERR: 10,
  SQLITE_CORRUPT: 11,
  SQLITE_NOTFOUND: 12,
  SQLITE_FULL: 13,
  SQLITE_CANTOPEN: 14,
  SQLITE_READONLY_DBMOVED: 1032,
  SQLITE_READONLY_CANTINIT: 1033,
}

export interface SqliteDiagnostic {
  /** The SQLite result-code name (e.g. SQLITE_CONSTRAINT_UNIQUE) when the error carries one. */
  readonly sqliteCode?: string
  /** The numeric SQLite extended result code (e.g. 2067) when mappable. */
  readonly sqliteExtendedCode?: number
  /** The object name a constraint failure names (e.g. "t.b" or "FOREIGN KEY"). */
  readonly constraint?: string
  /** True when the failure came from a TRIGGER (SQLITE_CONSTRAINT_TRIGGER). */
  readonly trigger?: boolean
}

/** Extract SQLite extended code + constraint/trigger detail from a thrown error. */
export const extractSqliteDiagnostic = (error: unknown): SqliteDiagnostic => {
  if (typeof error !== "object" || error === null) return {}
  const record = error as { code?: unknown; message?: unknown; cause?: unknown }
  const codeName = typeof record.code === "string" ? record.code : undefined
  const sqliteExtendedCode = codeName !== undefined ? EXTENDED_CODES[codeName] : undefined
  const message = typeof record.message === "string" ? record.message : ""
  const constraintMatch = message.match(/(?:constraint failed|UNIQUE constraint failed|NOT NULL constraint failed)\s*:\s*([^\n;]+)/i)
  const constraint = constraintMatch?.[1]?.trim()
  const trigger = codeName === "SQLITE_CONSTRAINT_TRIGGER" || /trigger/i.test(message)
  const top = { sqliteCode: codeName, sqliteExtendedCode, constraint, trigger }
  // Recurse into a `cause` chain (e.g. effect SqlError wraps the raw SQLiteError).
  if (record.cause && typeof record.cause === "object" && record.cause !== error)
    return { ...top, ...extractSqliteDiagnostic(record.cause) }
  return top
}

/** Redact credential/secret-like text without touching SQL identifiers or errors. */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\b(bearer|token|api[_-]?key|secret|password|passwd)\b\s*[:=]\s*\S+/gi, "$1: [redacted]"],
  [/sk-[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/ghp_[A-Za-z0-9]{20,}/g, "[redacted-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-key]"],
  [/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+)?PRIVATE KEY-----/g, "[redacted-key]"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[redacted]"],
]

/** Redact credential/prompt-like text from a diagnostic message (defensive; the builder already excludes payload). */
export const sanitizeDiagnostic = (input: string): string => {
  let out = input
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

export interface DiagnosticContext {
  /** The frozen C0-03 wire code to carry on the envelope (already registered in the contract). */
  readonly wireCode?: string
  /** The run-level stable code (e.g. the upgrade-run failure_code) that led here. */
  readonly stableCode?: string
  readonly runId?: string
  readonly migrationId?: string
  readonly table?: string
  readonly key?: string
  readonly buildDigest?: string
  readonly correlationId?: string
  readonly message?: string
}

export interface MigrationDiagnostics {
  readonly stableCode: string
  readonly wireCode: string
  readonly sqliteExtendedCode?: number
  readonly sqliteCode?: string
  readonly constraint?: string
  readonly trigger?: boolean
  readonly runId?: string
  readonly migrationId?: string
  readonly table?: string
  readonly key?: string
  readonly buildDigest: string
  readonly correlationId: string
  readonly message: string
}

/**
 * Build a structured diagnostic from a failure. The message is assembled from structured fields
 * (never the raw SQL/params/values), so prompt/tool/credential payload cannot leak into diagnostics.
 */
export const buildMigrationDiagnostics = (error: unknown, context: DiagnosticContext = {}): MigrationDiagnostics => {
  const sqlite = extractSqliteDiagnostic(error)
  const correlationId = context.correlationId ?? randomUUID()
  const buildDigest = context.buildDigest ?? ""
  const wireCode = context.wireCode ?? (isRegisteredCode("upgrade_run_recovery_required") ? "upgrade_run_recovery_required" : "internal_error")
  const stableCode = context.stableCode ?? "migration_apply_failed"
  const detailParts = [
    `code=${stableCode}`,
    sqlite.sqliteCode ? `sqlite=${sqlite.sqliteCode}` : undefined,
    sqlite.sqliteExtendedCode !== undefined ? `sqliteExtended=${sqlite.sqliteExtendedCode}` : undefined,
    sqlite.constraint ? `constraint=${sqlite.constraint}` : undefined,
    sqlite.trigger ? `trigger=sqlite_trigger` : undefined,
    context.runId ? `run=${context.runId}` : undefined,
    context.migrationId ? `migration=${context.migrationId}` : undefined,
    context.table ? `table=${context.table}` : undefined,
    context.key ? `key=${context.key}` : undefined,
    context.message ? sanitizeDiagnostic(context.message) : undefined,
  ].filter((part): part is string => part !== undefined)
  return {
    stableCode,
    wireCode,
    sqliteExtendedCode: sqlite.sqliteExtendedCode,
    sqliteCode: sqlite.sqliteCode,
    constraint: sqlite.constraint,
    trigger: sqlite.trigger,
    runId: context.runId,
    migrationId: context.migrationId,
    table: context.table,
    key: context.key,
    buildDigest,
    correlationId,
    message: detailParts.join(" | "),
  }
}

/** Byte-stable digest of a diagnostic (for audit / correlation); the correlation id is excluded. */
export const diagnosticDigest = (diagnostics: MigrationDiagnostics): string => {
  const { correlationId, ...rest } = diagnostics
  void correlationId
  return createHash("sha256").update(JSON.stringify({ ...rest, wireCode: ErrorContract.codeMeta(rest.wireCode) ?? rest.wireCode })).digest("hex")
}
