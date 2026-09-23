import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import { Session } from "@/session/session"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionRevert } from "@/session/revert"
import { Effect } from "effect"
import * as ApiError from "../errors"

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
