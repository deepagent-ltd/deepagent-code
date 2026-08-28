import { describe, expect, test } from "bun:test"
import { decodeBootstrapStatus, isMaintenanceHttpError } from "./maintenance-client"
import type { BootstrapState, MaintenanceHttpError } from "./types"

const readyState: BootstrapState = {
  phase: "ready",
  mode: "ready",
  ready: true,
  diagnostics: { stableCode: "ok", mode: "ready", phase: "ready", buildDigest: "b", correlationId: "c", message: "" },
  next: null,
}

const typedError = (overrides: Partial<MaintenanceHttpError["data"]> = {}): MaintenanceHttpError => ({
  name: "ApiLocked",
  data: {
    code: "upgrade_run_recovery_required",
    category: "recovery",
    retryability: "retryable",
    httpStatus: 423,
    resource: "database",
    correlationId: "c1",
    message: "store not ready",
    expected: "ready",
    actual: "read_only_recovery",
    ...overrides,
  },
})

const wire = (status: number, body: string) => ({ status, body })

describe("decodeBootstrapStatus (the shell's mode authority)", () => {
  test("a 200 ready body maps to mode ready with the full state", () => {
    const outcome = decodeBootstrapStatus(wire(200, JSON.stringify(readyState)))
    expect(outcome.kind).toBe("ready")
    if (outcome.kind === "ready") expect(outcome.state.ready).toBe(true)
  })

  test("a read_only_recovery typed error maps to read_only_recovery with a stable code (no message decision)", () => {
    const outcome = decodeBootstrapStatus(wire(423, JSON.stringify(typedError())))
    expect(outcome.kind).toBe("read_only_recovery")
    if (outcome.kind === "read_only_recovery") {
      expect(outcome.state.mode).toBe("read_only_recovery")
      expect(outcome.state.diagnostics.stableCode).toBe("upgrade_run_recovery_required")
      expect(outcome.state.diagnostics.message).not.toContain("message decision")
    }
  })

  test("a blocked_schema typed error maps to blocked_schema", () => {
    const outcome = decodeBootstrapStatus(
      wire(423, JSON.stringify(typedError({ code: "database_preflight_failed", actual: "blocked_schema" }))),
    )
    expect(outcome.kind).toBe("blocked_schema")
    if (outcome.kind === "blocked_schema") {
      expect(outcome.state.diagnostics.stableCode).toBe("database_preflight_failed")
      expect(outcome.state.ready).toBe(false)
    }
  })

  test("a non-JSON / transport body is an unreachable outcome (never a false decision)", () => {
    const outcome = decodeBootstrapStatus(wire(500, "<html>gateway error</html>"))
    expect(outcome.kind).toBe("unreachable")
    if (outcome.kind === "unreachable") expect(outcome.error.kind).toBe("network")
  })

  test("detects the C0-03 typed error envelope", () => {
    expect(isMaintenanceHttpError(typedError())).toBe(true)
    expect(isMaintenanceHttpError({ status: 500, text: "nope" })).toBe(false)
  })
})
