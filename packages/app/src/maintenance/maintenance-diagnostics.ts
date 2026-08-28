import type { BootstrapDiagnostics } from "./types"

// C6-05: diagnostics are stable-code only. The shell must NEVER render SQL, raw
// filesystem paths or credentials. `message` is the only field that can carry
// free-text (it may hold a path or an accidental credential) so it is deliberately
// excluded from the whitelisted set. Everything rendered comes from a closed set
// of identity/hash fields.
//
// This module is pure/dependency-free so the rule is unit-testable and the
// component stays a thin consumer.

export interface DiagnosticEntry {
  key: string
  value: string
}

/** Closed set of diagnostics fields safe to render. Order is the render order. */
const SAFE_DIAGNOSTIC_FIELDS = [
  "stableCode",
  "mode",
  "phase",
  "buildDigest",
  "runId",
  "migrationId",
  "correlationId",
] as const

type SafeDiagnosticField = (typeof SAFE_DIAGNOSTIC_FIELDS)[number]

const FIELD_LABELS: Record<SafeDiagnosticField, string> = {
  stableCode: "stable.code",
  mode: "mode",
  phase: "phase",
  buildDigest: "build.digest",
  runId: "run.id",
  migrationId: "migration.id",
  correlationId: "correlation.id",
}

/** Patterns that mark a value as carrying a raw path, SQL or credential. */
const SENSITIVE_PATTERNS = [
  /(?:^|\/)(?:Users|home|var|private|tmp|opt|app|Applications)\b/i,
  /\.sqlite(?:-wal|-shm)?$/i,
  /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA)\b/i,
  /(?:password|passwd|secret|token|ap[_-]?key|authorization|bearer)\s*[:=]/i,
  /api[_-]?key\s*[:=]\s*\S+/i,
  /sk-\w{8,}/i,
] as const

export function sensitiveSubstrings(value: string): string[] {
  const matches: string[] = []
  for (const pattern of SENSITIVE_PATTERNS) {
    const hit = value.match(pattern)
    if (hit?.[0]) matches.push(hit[0])
  }
  return matches
}

/**
 * Build the renderable diagnostic entries from whitelisted fields only. Any value
 * that matches a sensitive pattern (path / SQL / credential) is dropped, so a
 * malformed whitelisted field can never leak a raw path or credential downstream.
 */
export function diagnosticEntries(diagnostics: BootstrapDiagnostics | undefined): DiagnosticEntry[] {
  if (!diagnostics) return []
  const entries: DiagnosticEntry[] = []
  for (const field of SAFE_DIAGNOSTIC_FIELDS) {
    const value = diagnostics[field]
    if (value === undefined || value === "") continue
    const text = String(value)
    if (sensitiveSubstrings(text).length > 0) continue
    entries.push({ key: FIELD_LABELS[field], value: text })
  }
  return entries
}

/** True when the diagnostics carry a value that would render a raw path/credential. */
export function containsSensitiveValue(diagnostics: BootstrapDiagnostics | undefined): boolean {
  if (!diagnostics) return false
  for (const value of Object.values(diagnostics)) {
    if (value === null || value === undefined) continue
    if (sensitiveSubstrings(String(value)).length > 0) return true
  }
  return false
}

/**
 * The exact text the `MaintenanceDiagnostics` component renders for a diagnostics
 * object. It is a pure projection of `diagnosticEntries` so the "no sensitive
 * substring in the DOM" guarantee can be asserted without mounting the Solid
 * component (the harness has no client render path).
 */
export function diagnosticsSafeText(diagnostics: BootstrapDiagnostics | undefined): string {
  return diagnosticEntries(diagnostics)
    .map((entry) => `${entry.key}: ${entry.value}`)
    .join("\n")
}
