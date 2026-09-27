import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import { Session } from "@/session/session"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionRevert } from "@/session/revert"
import { SessionProviderResolution } from "@/session/provider-resolution"
import { Effect } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"
import * as ApiError from "../errors"

// The historical HTTP endpoints retain their 400/404/409/503 error vocabulary. Fold every
// newer facade refusal into one of those wire statuses explicitly, so adding a typed reason
// cannot silently turn a caller error into an apparent service outage.
const unsupportedProviderResolutionStatus = {
  exit_requires_maintenance_authority: 503,
  exit_not_available_on_authority: 409,
  target_required: 400,
  target_ambiguous: 400,
  command_id_required: 400,
  legacy_binding_required: 400,
  legacy_receipt_bound_use_legacy_authority: 409,
} as const satisfies Record<SessionProviderResolution.Unsupported["code"], 400 | 409 | 503>

export const mapProviderResolutionError = (service: string) => (error: SessionProviderResolution.Error) => {
  if (error instanceof SessionProviderResolution.NotFound) return ApiError.notFound(error.reason)
  if (error instanceof SessionProviderResolution.Conflict)
    return new ApiError.ConflictError({ message: error.reason, resource: error.code })
  const status = unsupportedProviderResolutionStatus[error.code]
  if (status === 400) return new HttpApiError.BadRequest({})
  if (status === 409) return new ApiError.ConflictError({ message: error.reason, resource: error.code })
  return new ApiError.ServiceUnavailableError({ service, message: error.reason })
}

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

export function mapFork<A, R>(
  self: Effect.Effect<A, StorageNotFoundError | Session.ForkConflict | SessionV2.LegacySessionRequiresAdoption, R>,
) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof Session.ForkConflict)
        return new ApiError.ConflictError({ message: error.reason, resource: `fork_intent:${error.intentID}` })
      if (error instanceof SessionV2.LegacySessionRequiresAdoption)
        return new ApiError.ConflictError({
          message: `Historical session ${error.sessionID} requires explicit audited adoption`,
          resource: error.code,
        })
      return ApiError.notFound(error.message)
    }),
  )
}

export function mapBusy<A, R>(self: Effect.Effect<A, Session.BusyError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
  )
}

export function mapRevert<A, R>(self: Effect.Effect<A, Session.BusyError | SessionRevert.LimitError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
    Effect.catchTag("SessionRevertLimitError", (error) =>
      Effect.fail(
        new ApiError.ServiceUnavailableError({
          service: "session.revert",
          message: `Session revert exceeds the bounded ${error.maxFiles}-file safety limit`,
        }),
      ),
    ),
  )
}
