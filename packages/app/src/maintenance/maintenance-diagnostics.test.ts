import { describe, expect, test } from "bun:test"
import type { BootstrapDiagnostics } from "./types"
import { diagnosticsSafeText, diagnosticEntries } from "./maintenance-diagnostics"

// C6-05: the maintenance shell renders diagnostics as stable-code only. This tests
// the component's render contract: the exact text the `MaintenanceDiagnostics`
// component projects (a pure function over `diagnosticEntries`) must never contain
// a raw filesystem path, SQL snippet or credential — even when a diagnostics
// object carries one in its `message`/identity fields.

const leakyDiagnostics: BootstrapDiagnostics = {
  stableCode: "database_preflight_failed",
  mode: "blocked_schema",
  phase: "blocked_schema",
  buildDigest: "sha256:build",
  correlationId: "corr-1",
  // A hostile/accidental payload: raw SQL, an absolute path and a credential in the
  // one field that can defer free text (`message`). The shell must not render it.
  message: "SELECT * FROM session WHERE user='admin' at /Users/secret/.deepagent-code/db.sqlite password=hunter2",
}

describe("MaintenanceDiagnostics render contract (sensitive-info hiding)", () => {
  test("the projected component text carries no raw path/credential/SQL substring", () => {
    const text = diagnosticsSafeText(leakyDiagnostics)
    expect(text).not.toContain("/Users/secret")
    expect(text).not.toContain(".deepagent-code")
    expect(text).not.toContain("db.sqlite")
    expect(text).not.toContain("password=")
    expect(text).not.toContain("hunter2")
    expect(text).not.toContain("admin")
    expect(text).not.toContain("SELECT")
  })

  test("the projected component text renders the safe stable identity fields", () => {
    const text = diagnosticsSafeText(leakyDiagnostics)
    expect(text).toContain("stable.code: database_preflight_failed")
    expect(text).toContain("mode: blocked_schema")
    expect(text).toContain("phase: blocked_schema")
  })

  test("every rendered entry value is free of a sensitive pattern for a leaky object", () => {
    const entries = diagnosticEntries(leakyDiagnostics)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.value).not.toMatch(/password|secret|sqlite|\/Users|SELECT/i)
    }
  })

  test("undefined diagnostics project to no sensitive text", () => {
    expect(diagnosticsSafeText(undefined)).not.toMatch(/password|secret|sqlite|SELECT/i)
  })
})
