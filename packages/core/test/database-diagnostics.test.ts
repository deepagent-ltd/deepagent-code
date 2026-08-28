import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { Diagnostics } from "@deepagent-code/core/database/diagnostics"
import { ErrorContract } from "@deepagent-code/core/contract/error-code"

// C1A-14 MIGRATION/BACKUP/RESTORE/PREFLIGHT DIAGNOSTICS. A failure must carry a stable code, the
// SQLite extended code, the constraint/trigger name, run/migration/table/key identity, build/registry
// digest and a correlation id; the emitted diagnostic text must NOT contain prompt/tool/credential
// payload (design §10.8).

const triggerConstraintError = () => {
  const db = new BunDatabase(":memory:")
  db.run("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT UNIQUE)")
  db.run("INSERT INTO t VALUES (1, 'x')")
  try {
    db.run("INSERT INTO t VALUES (2, 'x')")
  } catch (error) {
    db.close()
    return error
  }
  db.close()
  throw new Error("expected a constraint violation")
}

const secret = "sk-super_secret_api_key_abcdef0123456789"

describe("Database diagnostics (C1A-14)", () => {
  test("a constraint violation yields the constraint name + stable sqlite extended code", () => {
    const error = triggerConstraintError()
    const diagnostic = Diagnostics.buildMigrationDiagnostics(error, {
      runId: "run-1",
      migrationId: "20260813040301_final_authorities",
      table: "t",
      key: "b",
      buildDigest: "abc123",
      message: "insert into t values (2, 'x')",
    })

    expect(diagnostic.constraint).toBe("t.b")
    expect(diagnostic.sqliteCode).toBe("SQLITE_CONSTRAINT_UNIQUE")
    expect(diagnostic.sqliteExtendedCode).toBe(2067)
    expect(diagnostic.stableCode).toBe("migration_apply_failed")
    expect(diagnostic.runId).toBe("run-1")
    expect(diagnostic.migrationId).toBe("20260813040301_final_authorities")
    expect(diagnostic.table).toBe("t")
    expect(diagnostic.key).toBe("b")
    expect(diagnostic.buildDigest).toBe("abc123")
    expect(diagnostic.correlationId.length).toBeGreaterThan(0)

    // The message carries the structured identity, never raw SQL values.
    expect(diagnostic.message).toContain("constraint=t.b")
    expect(diagnostic.message).toContain("sqlite=SQLITE_CONSTRAINT_UNIQUE")
    expect(diagnostic.message).toContain("sqliteExtended=2067")
  })

  test("the diagnostic never echoes prompt/credential payload", () => {
    const error = triggerConstraintError()
    const diagnostic = Diagnostics.buildMigrationDiagnostics(error, {
      runId: "run-1",
      migrationId: "m-1",
      // Simulate an error detail that would naively carry the secret; the sanitizer must redact it.
      message: `insert into t values (2, 'x') -- ${secret}`,
      buildDigest: "abc123",
    })
    const json = JSON.stringify(diagnostic)
    expect(json).not.toContain(secret)
    expect(diagnostic.message).not.toContain(secret)
  })

  test("sanitizeDiagnostic redacts credential-like text", () => {
    const out = Diagnostics.sanitizeDiagnostic(
      `connection failed: bearer token=abc123, api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890, key secret: hush`,
    )
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890")
    expect(out).toContain("[redacted]")
  })

  test("the frozen C0-03 wire code is consumed, not invented (registered in the contract)", () => {
    const error = triggerConstraintError()
    const diagnostic = Diagnostics.buildMigrationDiagnostics(error, {
      wireCode: "upgrade_run_recovery_required",
      buildDigest: "abc123",
    })
    expect(diagnostic.wireCode).toBe("upgrade_run_recovery_required")
    // The contract exposes the code as registered; the diagnostic references it directly.
    expect(ErrorContract.isRegisteredCode(diagnostic.wireCode)).toBe(true)
    expect(ErrorContract.codeMeta(diagnostic.wireCode)?.category).toBe("migration")
  })
})
