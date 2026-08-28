import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { ErrorContract } from "@deepagent-code/core/contract/error-code"

// C0-03 typed error serializer (design §11.1). Every error in the maintenance /
// capability HTTP surface is produced by `makeApiError`, which carries the FROZEN
// `ErrorEnvelope` (code/resource/correlationId/retryability/httpStatus/message +
// optional expected/actual). A consumer decides on `code` + `retryability` +
// `httpStatus` and must never parse `message`. The registered code is the single
// authority for the HTTP status and retryability: the class is selected from
// `codeMeta(code).httpStatus`, so a malformed status mapping is impossible.
//
// The wire body follows the existing httpapi error convention `{ name, data }`
// (see ApiNotFoundError in ./errors). `data` is the full C0-03 envelope, so
// `data.code` / `data.retryability` / `data.httpStatus` are the decision fields.

const ErrorEnvelopeSchema = ErrorContract.ErrorEnvelope
export type ApiErrorEnvelope = ErrorContract.ErrorEnvelope

export class ApiBadRequestError extends Schema.ErrorClass<ApiBadRequestError>("ApiBadRequest")(
  { name: Schema.Literal("ApiBadRequest"), data: ErrorEnvelopeSchema },
  { httpApiStatus: 400 },
) {}

export class ApiForbiddenError extends Schema.ErrorClass<ApiForbiddenError>("ApiForbidden")(
  { name: Schema.Literal("ApiForbidden"), data: ErrorEnvelopeSchema },
  { httpApiStatus: 403 },
) {}

export class ApiNotFoundError extends Schema.ErrorClass<ApiNotFoundError>("ApiNotFound")(
  { name: Schema.Literal("ApiNotFound"), data: ErrorEnvelopeSchema },
  { httpApiStatus: 404 },
) {}

export class ApiConflictError extends Schema.ErrorClass<ApiConflictError>("ApiConflict")(
  { name: Schema.Literal("ApiConflict"), data: ErrorEnvelopeSchema },
  { httpApiStatus: 409 },
) {}

export class ApiGoneError extends Schema.ErrorClass<ApiGoneError>("ApiGone")(
  { name: Schema.Literal("ApiGone"), data: ErrorEnvelopeSchema },
  { httpApiStatus: 410 },
) {}

export class ApiLockedError extends Schema.ErrorClass<ApiLockedError>("ApiLocked")(
  { name: Schema.Literal("ApiLocked"), data: ErrorEnvelopeSchema },
  { httpApiStatus: 423 },
) {}

export class ApiUnavailableError extends Schema.ErrorClass<ApiUnavailableError>("ApiUnavailable")(
  { name: Schema.Literal("ApiUnavailable"), data: ErrorEnvelopeSchema },
  { httpApiStatus: 503 },
) {}

export type ApiTypedError =
  | ApiBadRequestError
  | ApiForbiddenError
  | ApiNotFoundError
  | ApiConflictError
  | ApiGoneError
  | ApiLockedError
  | ApiUnavailableError

export const ApiTypedError = Schema.Union([
  ApiBadRequestError,
  ApiForbiddenError,
  ApiNotFoundError,
  ApiConflictError,
  ApiGoneError,
  ApiLockedError,
  ApiUnavailableError,
])
export type ApiTypedErrorSchema = typeof ApiTypedError

export interface MakeApiErrorInput {
  readonly resource: string
  readonly correlationId?: string
  readonly expected?: string
  readonly actual?: string
  readonly message?: string
}

/**
 * Build the correct per-status `ApiTypedError` for a registered C0-03 code.
 * Throws if the code is not in the frozen registry (a typed error must never
 * serialize an unregistered code — that would break the client's decision logic).
 */
export function makeApiError(code: string, input: MakeApiErrorInput): ApiTypedError {
  const meta = ErrorContract.codeMeta(code)
  if (!meta) throw new Error(`C0-03 typed error code is not registered: ${code}`)
  const envelope: ApiErrorEnvelope = {
    schemaVersion: ErrorContract.ErrorVersion.schema,
    code,
    category: meta.category,
    retryability: meta.retryability,
    httpStatus: meta.httpStatus,
    resource: input.resource,
    correlationId: input.correlationId ?? randomUUID(),
    message: input.message ?? meta.meaning,
    ...(input.expected !== undefined ? { expected: input.expected } : {}),
    ...(input.actual !== undefined ? { actual: input.actual } : {}),
  }
  switch (meta.httpStatus) {
    case 400:
      return new ApiBadRequestError({ name: "ApiBadRequest", data: envelope })
    case 403:
      return new ApiForbiddenError({ name: "ApiForbidden", data: envelope })
    case 404:
      return new ApiNotFoundError({ name: "ApiNotFound", data: envelope })
    case 409:
      return new ApiConflictError({ name: "ApiConflict", data: envelope })
    case 410:
      return new ApiGoneError({ name: "ApiGone", data: envelope })
    case 423:
      return new ApiLockedError({ name: "ApiLocked", data: envelope })
    case 503:
      return new ApiUnavailableError({ name: "ApiUnavailable", data: envelope })
  }
}

/** The registered C0-03 status for a code (convenience for handlers / tests). */
export function apiErrorStatus(code: string): ErrorContract.ErrorHttpStatus {
  const meta = ErrorContract.codeMeta(code)
  if (!meta) throw new Error(`C0-03 typed error code is not registered: ${code}`)
  return meta.httpStatus
}

/** Whether a code is in the frozen registry (guards against serializing an unregistered code). */
export function isRegisteredApiErrorCode(code: string): boolean {
  return ErrorContract.isRegisteredCode(code)
}
