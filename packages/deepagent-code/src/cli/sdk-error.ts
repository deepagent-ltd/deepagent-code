// C6-08: stable C0-03 typed-error handling for CLI/ACP consumers. The generated SDK surfaces a
// `code` + `httpStatus` on every failure (never a human `message` to branch on), so decisions
// here branch on `code`/`httpStatus` only: the interceptor wraps the parsed body at
// `.cause.body`, which is the same stable-error envelope this module reads.

type SdkErrorBody = {
  readonly name?: string
  readonly data?: {
    readonly schemaVersion?: string
    readonly code?: string
    readonly category?: string
    readonly httpStatus?: number
    readonly resource?: string
    readonly correlationId?: string
    readonly message?: string
  }
}

function readBody(error: unknown): SdkErrorBody | undefined {
  if (typeof error !== "object" || error === null) return
  const wrapper = error as { cause?: { body?: SdkErrorBody }; data?: SdkErrorBody["data"] }
  // The wrapClientError interceptor stores the parsed stable-error body at `.cause.body`; the
  // un-thrown result-tuple form surfaces it directly under `.data` with a `.name`.
  return wrapper.cause?.body ?? (wrapper.data ? { name: typeof error === "object" && "name" in error ? (error as { name?: string }).name : undefined, data: wrapper.data } : undefined)
}

export type SdkErrorInfo = {
  readonly code?: string
  readonly httpStatus?: number
  readonly category?: string
  readonly resource?: string
  readonly correlationId?: string
  readonly message?: string
}

/** Extract the stable C0-03 fields from any SDK failure. Read-only; never throws. */
export function sdkErrorInfo(error: unknown): SdkErrorInfo {
  const body = readBody(error)
  const data = body?.data
  if (!data) return {}
  return {
    code: str(data.code),
    httpStatus: num(data.httpStatus),
    category: str(data.category),
    resource: str(data.resource),
    correlationId: str(data.correlationId),
    message: str(data.message),
  }
}

/** Whether a failure is the durable cursor-derived 410 (`cursor_gap_exceeded`). */
export function isCursorGap(error: unknown): boolean {
  const info = sdkErrorInfo(error)
  return info.code === "cursor_gap_exceeded" || info.httpStatus === 410
}

/** Whether a failure is a typed 400 `validation_failed`. */
export function isValidationFailure(error: unknown): boolean {
  const info = sdkErrorInfo(error)
  return info.code === "validation_failed" || info.httpStatus === 400
}

/**
 * Friendly one-line render for a typed SDK failure: `[code] message`. Never dumps a raw stack or
 * response body, and never decides on a human message — it only surfaces one for display.
 */
export function renderSdkError(error: unknown): string {
  const info = sdkErrorInfo(error)
  if (info.code && info.httpStatus !== undefined) {
    return info.message ? `[${info.code}] ${info.message}` : `[${info.code}]`
  }
  if (info.message) return info.message
  if (error instanceof Error && error.message) return error.message
  return "deepagent-code request failed"
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}
