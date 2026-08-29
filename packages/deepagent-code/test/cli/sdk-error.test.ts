import { describe, expect, it } from "bun:test"
import { isCursorGap, isValidationFailure, renderSdkError, sdkErrorInfo } from "@/cli/sdk-error"

// C6-08: typed-error handling branches on `code`/`httpStatus`, never on a human `message`. The
// interceptor wraps the parsed stable-error body at `.cause.body`; the result-tuple form surfaces
// it directly under `.data`.

const stableError = (code: string, httpStatus: number, message: string) => ({
  name: httpStatus === 410 ? "ApiGone" : httpStatus === 400 ? "ApiBadRequest" : "ApiError",
  data: {
    schemaVersion: "stable-error.v1",
    code,
    category: "cursor",
    httpStatus,
    resource: "ses-1",
    correlationId: "corr",
    message,
  },
})

const wrapped = (body: unknown) => new Error("deepagent-code request failed", { cause: { body } })

describe("sdk error typed handling", () => {
  it("extracts the stable code/httpStatus from an interceptor-wrapped error", () => {
    const info = sdkErrorInfo(wrapped(stableError("cursor_gap_exceeded", 410, "cursor below floor")))
    expect(info.code).toBe("cursor_gap_exceeded")
    expect(info.httpStatus).toBe(410)
    expect(info.category).toBe("cursor")
  })

  it("extracts the stable fields from the raw result-tuple error body", () => {
    const info = sdkErrorInfo(stableError("validation_failed", 400, "limit out of range"))
    expect(info.code).toBe("validation_failed")
    expect(info.httpStatus).toBe(400)
  })

  it("identifies a cursor gap by code or by httpStatus, without parsing a message", () => {
    expect(isCursorGap(wrapped(stableError("cursor_gap_exceeded", 410, "below floor")))).toBe(true)
    expect(isCursorGap(stableError("something_else", 410, "gone"))).toBe(true)
    expect(isCursorGap(stableError("validation_failed", 400, "limit"))).toBe(false)
  })

  it("identifies a validation failure by code and httpStatus", () => {
    expect(isValidationFailure(stableError("validation_failed", 400, "limit"))).toBe(true)
    expect(isValidationFailure(stableError("cursor_gap_exceeded", 410, "gone"))).toBe(false)
  })

  it("renders a friendly one-line error that never dumps a stack or body", () => {
    const rendered = renderSdkError(wrapped(stableError("cursor_gap_exceeded", 410, "cursor below retained floor")))
    expect(rendered).toBe("[cursor_gap_exceeded] cursor below retained floor")
    expect(rendered).not.toContain("schemaVersion")
    expect(rendered).not.toContain("node_modules")
  })

  it("falls back to a stable message for non-stable errors", () => {
    expect(renderSdkError(new Error("plain"))).toBe("plain")
    expect(renderSdkError("nope")).toBe("deepagent-code request failed")
  })
})
