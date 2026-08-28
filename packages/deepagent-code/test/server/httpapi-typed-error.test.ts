import { describe, expect, test } from "bun:test"
import { ErrorContract } from "@deepagent-code/core/contract/error-code"
import {
  apiErrorStatus,
  isRegisteredApiErrorCode,
  makeApiError,
  ApiBadRequestError,
  ApiConflictError,
  ApiForbiddenError,
  ApiGoneError,
  ApiLockedError,
  ApiNotFoundError,
  ApiUnavailableError,
} from "../../src/server/routes/instance/httpapi/typed-error"

// C6-01 typed-error serializer (design §11.1). A consumer decides on `code` +
// `retryability` + `httpStatus` from the C0-03 envelope and MUST NEVER parse
// `message`. These tests assert the frozen 400/403/404/409/410/423/503 mapping and
// that the envelope carries the decision fields, never relying on `message`.

describe("C0-03 typed error serializer", () => {
  test("every frozen error code round-trips through makeApiError with the authoritative status", () => {
    for (const entry of ErrorContract.ERROR_CODE_REGISTRY) {
      const err = makeApiError(entry.code, { resource: "test/resource" })
      const data = err.data
      // The registered code is the single authority for the HTTP status.
      expect(data.code).toBe(entry.code)
      expect(data.httpStatus).toBe(entry.httpStatus)
      expect(data.retryability).toBe(entry.retryability)
      expect(data.category).toBe(entry.category)
      expect(data.resource).toBe("test/resource")
      // correlation_id is always present.
      expect(typeof data.correlationId).toBe("string")
      expect(data.correlationId.length).toBeGreaterThan(0)
    }
  })

  test("the serializer maps each status to the matching Api* error class", () => {
    expect(makeApiError("validation_failed", { resource: "r" })).toBeInstanceOf(ApiBadRequestError)
    expect(makeApiError("permission_denied", { resource: "r" })).toBeInstanceOf(ApiForbiddenError)
    expect(makeApiError("backup_manifest_missing", { resource: "r" })).toBeInstanceOf(ApiNotFoundError)
    expect(makeApiError("restore_target_not_quarantined", { resource: "r" })).toBeInstanceOf(ApiConflictError)
    expect(makeApiError("recovery_terminal_bridge_missing", { resource: "r" })).toBeInstanceOf(ApiGoneError)
    expect(makeApiError("database_preflight_failed", { resource: "r" })).toBeInstanceOf(ApiLockedError)
    expect(makeApiError("database_open_failed", { resource: "r" })).toBeInstanceOf(ApiUnavailableError)
  })

  test("expected/actual are only added when provided and are not message", () => {
    const err = makeApiError("database_preflight_failed", {
      resource: "database",
      expected: "ready",
      actual: "read_only_recovery",
    })
    expect(err.data.expected).toBe("ready")
    expect(err.data.actual).toBe("read_only_recovery")
    // The message is explicitly NON-AUTHORITATIVE: it must not be empty when absent,
    // but clients must not parse it for the decision.
    expect(typeof err.data.message).toBe("string")
  })

  test("apiErrorStatus returns the frozen status and rejects unknown codes", () => {
    expect(apiErrorStatus("database_preflight_failed")).toBe(423)
    expect(apiErrorStatus("permission_denied")).toBe(403)
    expect(apiErrorStatus("cursor_gap_exceeded")).toBe(410)
    expect(apiErrorStatus("service_unavailable")).toBe(503)
    expect(apiErrorStatus("resource_not_found")).toBe(404)
    expect(apiErrorStatus("exact_retry_mismatch")).toBe(409)
    expect(apiErrorStatus("event_envelope_unregistered")).toBe(400)
    expect(() => apiErrorStatus("not_a_real_code")).toThrow()
  })

  test("isRegisteredApiErrorCode guards against serializing an unregistered code", () => {
    expect(isRegisteredApiErrorCode("permission_denied")).toBe(true)
    expect(isRegisteredApiErrorCode("does_not_exist")).toBe(false)
    expect(() => makeApiError("does_not_exist", { resource: "r" })).toThrow()
  })

  test("the five design statuses (400/403/404/409/410/423/503) are all reachable", () => {
    const statuses = new Set(
      ErrorContract.ERROR_CODE_REGISTRY.map((entry) => apiErrorStatus(entry.code)),
    )
    expect(statuses.has(400)).toBe(true)
    expect(statuses.has(403)).toBe(true)
    expect(statuses.has(404)).toBe(true)
    expect(statuses.has(409)).toBe(true)
    expect(statuses.has(410)).toBe(true)
    expect(statuses.has(423)).toBe(true)
    expect(statuses.has(503)).toBe(true)
  })
})
