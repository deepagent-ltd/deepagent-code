import { describe, expect, test } from "bun:test"
import { DatabaseBootstrap } from "@deepagent-code/core/database/bootstrap"
import type { PreflightIssue, PreflightObservations, PreflightResult } from "@deepagent-code/core/database/preflight"

const buildDigest = "digest"
const opts = { buildDigest }

const observations = (overrides: Partial<PreflightObservations> = {}): PreflightObservations => ({
  filename: "/tmp/x.db",
  exists: true,
  size: 4096,
  mode: 0o100644,
  sqliteHeaderValid: true,
  pageSize: 4096,
  pageCount: 10,
  journalMode: "wal",
  dbReadable: true,
  journalRows: [],
  capabilities: [],
  upgradeRuns: [],
  walExists: true,
  walSize: 1024,
  shmExists: true,
  shmSize: 1024,
  freeSpaceBytes: 512 * 1024 * 1024,
  localFilesystem: true,
  activeProcess: false,
  ...overrides,
})

const issue = (code: PreflightIssue["code"]): PreflightIssue => ({ code, message: code, resource: "x" })

const failed = (code: PreflightIssue["code"], obs: PreflightObservations = observations()): PreflightResult => ({
  ok: false,
  observations: obs,
  issues: [issue(code)],
})

const passed = (obs: PreflightObservations = observations()): PreflightResult => ({ ok: true, observations: obs })

const input = (overrides: Partial<Parameters<typeof DatabaseBootstrap.describeBootstrap>[0]> = {}) => ({
  preflight: passed(),
  pendingMigrationIds: [],
  hasExistingDatabase: true,
  needsBackup: false,
  backupReady: false,
  recoveryRequired: false,
  recoveryComplete: true,
  postVerifyPassed: false,
  ...overrides,
})

describe("DatabaseBootstrap state machine", () => {
  test("legal §10.2 transitions are allowed", () => {
    const legal: [DatabaseBootstrap.BootstrapPhase, DatabaseBootstrap.BootstrapPhase][] = [
      ["shell_start", "preflight_read_only"],
      ["preflight_read_only", "blocked_schema"],
      ["preflight_read_only", "backup_required"],
      ["backup_required", "backup_verifying"],
      ["backup_verifying", "migration_applying"],
      ["backup_verifying", "blocked_schema"],
      ["migration_applying", "recovery_reconciling"],
      ["migration_applying", "read_only_recovery"],
      ["recovery_reconciling", "post_verify"],
      ["recovery_reconciling", "read_only_recovery"],
      ["post_verify", "ready"],
      ["post_verify", "read_only_recovery"],
    ]
    for (const [from, to] of legal) expect(DatabaseBootstrap.canBootstrapTransition(from, to)).toBe(true)
  })

  test("illegal transitions throw InvalidBootstrapTransitionError", () => {
    expect(() => DatabaseBootstrap.assertBootstrapTransition("shell_start", "ready")).toThrow()
    expect(DatabaseBootstrap.canBootstrapTransition("ready", "post_verify")).toBe(false)
  })

  test("hard blocker (incompatible binary) -> blocked_schema, never ready", () => {
    const result = DatabaseBootstrap.describeBootstrap(input({ preflight: failed("incompatible_binary") }), opts)
    expect(result.phase).toBe("blocked_schema")
    expect(result.mode).toBe("blocked_schema")
    expect(result.ready).toBe(false)
    expect(result.diagnostics.stableCode).toBe("incompatible_binary")
    expect(result.next).toBeNull()
  })

  test("invalid sqlite database -> blocked_schema", () => {
    const result = DatabaseBootstrap.describeBootstrap(input({ preflight: failed("not_a_sqlite_database") }), opts)
    expect(result.mode).toBe("blocked_schema")
    expect(result.ready).toBe(false)
  })

  test("journal gap -> blocked_schema before any write", () => {
    const result = DatabaseBootstrap.describeBootstrap(input({ preflight: failed("migration_journal_gap") }), opts)
    expect(result.mode).toBe("blocked_schema")
    expect(result.ready).toBe(false)
  })

  test("unfinished upgrade run -> read_only_recovery (browse/export, no write)", () => {
    const result = DatabaseBootstrap.describeBootstrap(
      input({ preflight: failed("unfinished_upgrade_run"), recoveryComplete: false }),
      opts,
    )
    expect(result.phase).toBe("recovery_reconciling")
    expect(result.mode).toBe("read_only_recovery")
    expect(result.ready).toBe(false)
  })

  test("another active process -> read_only_recovery (two-window race)", () => {
    const result = DatabaseBootstrap.describeBootstrap(
      input({ preflight: failed("another_process_active"), recoveryComplete: false }),
      opts,
    )
    expect(result.phase).toBe("recovery_reconciling")
    expect(result.mode).toBe("read_only_recovery")
    expect(result.ready).toBe(false)
  })

  test("fresh install -> migration_applying, ready (shell proceeds to create schema)", () => {
    const result = DatabaseBootstrap.describeBootstrap(input({ hasExistingDatabase: false, pendingMigrationIds: ["m1"] }), opts)
    expect(result.phase).toBe("migration_applying")
    expect(result.mode).toBe("ready")
    expect(result.ready).toBe(true)
  })

  test("existing up-to-date DB -> ready", () => {
    const result = DatabaseBootstrap.describeBootstrap(input(), opts)
    expect(result.phase).toBe("ready")
    expect(result.mode).toBe("ready")
    expect(result.ready).toBe(true)
  })

  test("pending forward migration without verified backup -> backup_required phase, still ready", () => {
    const result = DatabaseBootstrap.describeBootstrap(
      input({ pendingMigrationIds: ["m2"], needsBackup: true, backupReady: false }),
      opts,
    )
    expect(result.phase).toBe("backup_required")
    expect(result.ready).toBe(true)
  })

  test("pending forward migration with verified backup -> migration_applying", () => {
    const result = DatabaseBootstrap.describeBootstrap(
      input({ pendingMigrationIds: ["m2"], needsBackup: true, backupReady: true }),
      opts,
    )
    expect(result.phase).toBe("migration_applying")
    expect(result.ready).toBe(true)
  })

  test("recovery required but incomplete -> read_only_recovery even when preflight passes", () => {
    const result = DatabaseBootstrap.describeBootstrap(
      input({ recoveryRequired: true, recoveryComplete: false }),
      opts,
    )
    expect(result.mode).toBe("read_only_recovery")
    expect(result.ready).toBe(false)
  })

  test("diagnostics carry build digest and correlation id", () => {
    const result = DatabaseBootstrap.describeBootstrap(input(), opts)
    expect(result.diagnostics.buildDigest).toBe(buildDigest)
    expect(result.diagnostics.correlationId.length).toBeGreaterThan(0)
  })
})
