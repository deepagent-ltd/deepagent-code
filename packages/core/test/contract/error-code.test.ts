import { describe, expect, test } from "bun:test"
import {
  decodeErrorEnvelope,
  encodeErrorEnvelope,
  ERROR_CODE_REGISTRY,
  errorEnvelopeDigest,
  registryDigest,
  isRegisteredCode,
  codeMeta,
  ErrorEnvelopeDecodeError,
  ErrorVersion,
  type ErrorEnvelope,
} from "../../src/contract/error-code"

const validEnvelope: ErrorEnvelope = {
  schemaVersion: "stable-error.v1",
  code: "migration_lease_conflict",
  category: "migration",
  retryability: "retryable",
  httpStatus: 409,
  resource: "database_upgrade_run",
  correlationId: "corr-1",
  message: "another migration holds the lease",
}

describe("C0-03 error contract", () => {
  test("round-trip encode/decode of a valid envelope", () => {
    const decoded = decodeErrorEnvelope(JSON.parse(encodeErrorEnvelope(validEnvelope)))
    expect(decoded).toEqual(validEnvelope)
  })

  test("retryable conflict maps to 409 and retryable", () => {
    const meta = codeMeta("migration_lease_conflict")
    expect(meta?.retryability).toBe("retryable")
    expect(meta?.httpStatus).toBe(409)
  })

  test("indeterminate provider outcome maps to 503", () => {
    const meta = codeMeta("provider_result_unknown")
    expect(meta?.retryability).toBe("indeterminate")
    expect(meta?.httpStatus).toBe(503)
  })

  test("reports the full registry with unique codes", () => {
    const ids = ERROR_CODE_REGISTRY.map((e) => e.code)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(38)
  })

  test("missing required field is rejected", () => {
    const bad = { ...validEnvelope } as Record<string, unknown>
    delete bad.correlationId
    expect(() => decodeErrorEnvelope(bad)).toThrow(ErrorEnvelopeDecodeError)
  })

  test("unknown retryability is rejected", () => {
    const bad = { ...validEnvelope, retryability: "maybe" }
    expect(() => decodeErrorEnvelope(bad)).toThrow(ErrorEnvelopeDecodeError)
  })

  test("unknown http status (429) is rejected — design §11.1 surface only", () => {
    const bad = { ...validEnvelope, httpStatus: 429 }
    expect(() => decodeErrorEnvelope(bad)).toThrow(ErrorEnvelopeDecodeError)
  })

  test("unregistered code is rejected (shared union requirement)", () => {
    const bad = { ...validEnvelope, code: "made_up_code_xyz" }
    expect(() => decodeErrorEnvelope(bad)).toThrow(ErrorEnvelopeDecodeError)
  })

  test("extra field is rejected (onExcessProperty error)", () => {
    const bad = { ...validEnvelope, extra: "nope" }
    expect(() => decodeErrorEnvelope(bad)).toThrow(ErrorEnvelopeDecodeError)
  })

  test("message is non-authoritative — client cannot parse it", () => {
    const decoded = decodeErrorEnvelope({ ...validEnvelope, message: "anything goes in message" })
    expect(decoded.code).toBe("migration_lease_conflict")
  })

  test("envelope digest is byte-stable and key-order canonical", () => {
    const a = errorEnvelopeDigest(validEnvelope)
    const b = errorEnvelopeDigest({ ...validEnvelope })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test("registry digest is stable and version-bound", () => {
    const a = registryDigest()
    const b = registryDigest()
    expect(a).toBe(b)
    expect(ErrorVersion.registry).toBe(1)
  })

  test("expected/actual optional fields round-trip", () => {
    const withDetails = { ...validEnvelope, expected: "row", actual: "column" }
    expect(decodeErrorEnvelope(withDetails).expected).toBe("row")
    expect(decodeErrorEnvelope(withDetails).actual).toBe("column")
  })

  test("isRegisteredCode reflects the registry", () => {
    expect(isRegisteredCode("permission_denied")).toBe(true)
    expect(isRegisteredCode("nope")).toBe(false)
  })
})
