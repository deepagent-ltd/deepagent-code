import { describe, expect, test } from "bun:test"
import type { BootstrapDiagnostics } from "./types"
import {
  initialShellState,
  isRestoreBusy,
  operationsForMode,
  reduceShell,
  restoreCanSubmit,
  restoreSelection,
  toOutcomeDiagnostics,
  type ShellBackupItem,
  type ShellState,
} from "./maintenance-shell-state"
import { diagnosticEntries, sensitiveSubstrings, containsSensitiveValue } from "./maintenance-diagnostics"

const backup = (overrides: Partial<ShellBackupItem> = {}): ShellBackupItem => ({
  fileName: "pre-upgrade.sqlite.manifest.json",
  filePath: "/backups/pre-upgrade.sqlite.manifest.json",
  sizeBytes: 4096,
  sha256: "abc123",
  createdAt: 1_700_000_000_000,
  ...overrides,
})

const diagnostics = (overrides: Partial<BootstrapDiagnostics> = {}): BootstrapDiagnostics => ({
  stableCode: "database_preflight_failed",
  mode: "blocked_schema",
  phase: "blocked_schema",
  buildDigest: "sha256:build",
  correlationId: "corr-1",
  message: "Schema is not writable",
  ...overrides,
})

describe("shell mode resolution (no overlap)", () => {
  test("a bootstrap snapshot maps to exactly one shell mode", () => {
    const out = toOutcomeDiagnostics(diagnostics())
    const state = reduceShell(initialShellState, { type: "bootstrapLoaded", mode: "blocked_schema", diagnostics: out })
    expect(state.mode).toBe("blocked_schema")
    expect(operationsForMode(state.mode).write).toBe(false)
  })

  test("switching from read_only_recovery to ready replaces the mode (no overlap)", () => {
    let state = reduceShell(initialShellState, {
      type: "bootstrapLoaded",
      mode: "read_only_recovery",
      diagnostics: toOutcomeDiagnostics({ ...diagnostics(), mode: "read_only_recovery", stableCode: "upgrade_run_recovery_required" }),
    })
    expect(state.mode).toBe("read_only_recovery")

    state = reduceShell(state, {
      type: "bootstrapLoaded",
      mode: "ready",
      diagnostics: toOutcomeDiagnostics({ ...diagnostics(), mode: "ready", stableCode: "ok", message: "" }),
    })
    expect(state.mode).toBe("ready")
    // A ready shell re-enables live/write.
    expect(operationsForMode(state.mode).live).toBe(true)
    expect(operationsForMode(state.mode).write).toBe(true)
  })

  test("a bootstrap failure yields a null mode and the shell renders the error view (not a dead blank)", () => {
    const state = reduceShell(initialShellState, { type: "bootstrapFailed", stableCode: "network_unreachable" })
    expect(state.mode).toBeNull()
    expect(state.bootError).toBe("network_unreachable")
    expect(operationsForMode(state.mode).live).toBe(false)
  })
})

describe("operations for mode", () => {
  test("read_only_recovery disables write/live but keeps browse/search/export/backup/descriptors", () => {
    const ops = operationsForMode("read_only_recovery")
    expect(ops.browse).toBe(true)
    expect(ops.search).toBe(true)
    expect(ops.export).toBe(true)
    expect(ops.backup).toBe(true)
    expect(ops.descriptors).toBe(true)
    expect(ops.write).toBe(false)
    expect(ops.live).toBe(false)
  })

  test("blocked_schema keeps backup/restore but disables write/live", () => {
    const ops = operationsForMode("blocked_schema")
    expect(ops.backup).toBe(true)
    expect(ops.restore).toBe(true)
    expect(ops.write).toBe(false)
    expect(ops.live).toBe(false)
  })

  test("null mode surfaces no operations (shell never advertises forbidden actions)", () => {
    expect(operationsForMode(null)).toEqual({
      browse: false,
      search: false,
      export: false,
      backup: false,
      descriptors: false,
      restore: false,
      write: false,
      live: false,
    })
  })
})

describe("restore request flow (no double submit / deadlock)", () => {
  const loaded = (state: ShellState) =>
    reduceShell(state, {
      type: "bootstrapLoaded",
      mode: "blocked_schema",
      diagnostics: toOutcomeDiagnostics(diagnostics()),
    })

  test("select -> confirm -> in_progress -> completed", () => {
    let state = loaded(initialShellState)
    state = reduceShell(state, { type: "restoreSelect", backup: backup() })
    expect(state.restore).toEqual({ status: "confirming", selected: backup() })
    expect(restoreCanSubmit(state)).toBe(true)

    state = reduceShell(state, { type: "restoreConfirm" })
    expect(state.restore.status).toBe("in_progress")
    expect(isRestoreBusy(state)).toBe(true)
    expect(restoreCanSubmit(state)).toBe(false)

    state = reduceShell(state, { type: "restoreCompleted", result: { status: "dry_run", inProgress: true, restoreId: "res-1", message: "ok" } })
    expect(state.restore.status).toBe("completed")
    expect(isRestoreBusy(state)).toBe(false)
  })

  test("confirming while a restore is already in progress is a no-op (no double submit)", () => {
    let state = loaded(initialShellState)
    state = reduceShell(state, { type: "restoreSelect", backup: backup() })
    state = reduceShell(state, { type: "restoreConfirm" })
    const inProgress = state
    // A second confirm must not re-enter in_progress or lose the in-flight selection.
    const next = reduceShell(inProgress, { type: "restoreConfirm" })
    expect(next).toBe(inProgress)
  })

  test("409 busy state blocks further restore submits until reset", () => {
    let state = loaded(initialShellState)
    state = reduceShell(state, { type: "restoreSelect", backup: backup() })
    state = reduceShell(state, { type: "restoreConfirm" })
    state = reduceShell(state, {
      type: "restoreBusy",
      result: { status: "dry_run", inProgress: true, restoreId: "other", message: "restore already in progress" },
    })
    expect(state.restore.status).toBe("busy")
    expect(isRestoreBusy(state)).toBe(true)
    // Selecting a fresh target clears the busy marker so the user can retry.
    state = reduceShell(state, { type: "restoreSelect", backup: backup({ fileName: "second.json" }) })
    expect(state.restore.status).toBe("confirming")
    expect(isRestoreBusy(state)).toBe(false)
  })

  test("a restore error is a distinct view, not a dead state", () => {
    let state = loaded(initialShellState)
    state = reduceShell(state, { type: "restoreSelect", backup: backup() })
    state = reduceShell(state, { type: "restoreConfirm" })
    state = reduceShell(state, { type: "restoreFailed", stableCode: "restore_target_not_quarantined" })
    expect(state.restore.status).toBe("error")
    expect((state.restore as { stableCode: string }).stableCode).toBe("restore_target_not_quarantined")
    expect(isRestoreBusy(state)).toBe(false)
  })
})

describe("diagnostics stay stable-code only", () => {
  test("toOutcomeDiagnostics stores only whitelisted entries", () => {
    const out = toOutcomeDiagnostics(diagnostics())
    const keys = out.entries.map((entry) => entry.key)
    expect(keys).toContain("stable.code")
    expect(keys).toContain("mode")
    expect(keys).toContain("phase")
    // `message` must never be promoted to a renderable entry.
    expect(keys).not.toContain("message")
  })

  test("a diagnostics object with a raw path/credential is flagged sensitive and never stored raw", () => {
    const leaky = diagnostics({
      message: "/Users/secret/db.sqlite credential=ghp_ABC123 secret=sk-live-abcdefgh",
    })
    const out = toOutcomeDiagnostics(leaky)
    expect(out.sensitive).toBe(true)
    // The stored entries (whitelisted fields) are empty of any sensitive value.
    expect(out.entries.every((entry) => sensitiveSubstrings(entry.value).length === 0)).toBe(true)
    expect(containsSensitiveValue(leaky)).toBe(true)
  })

  test("a clean diagnostics object is not sensitive", () => {
    expect(containsSensitiveValue(diagnostics())).toBe(false)
    expect(sensitiveSubstrings("database_preflight_failed")).toEqual([])
  })

  test("diagnosticEntries never emits the excluded identity/SQL fields", () => {
    const entries = diagnosticEntries(diagnostics({ table: "session", key: "SELECT * FROM session", constraint: "fk_x" }))
    const keys = entries.map((entry) => entry.key)
    expect(keys).not.toContain("table")
    expect(keys).not.toContain("key")
    expect(keys).not.toContain("constraint")
  })

  test("diagnosticEntries drops a whitelisted value that trips a sensitive pattern", () => {
    const entries = diagnosticEntries(diagnostics({ runId: "/var/lib/sqlite/run" }))
    expect(entries.find((entry) => entry.key === "run.id")).toBeUndefined()
  })
})
