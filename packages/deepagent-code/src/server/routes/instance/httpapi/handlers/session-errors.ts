import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import { Session } from "@/session/session"
import { Effect } from "effect"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

export function mapFork<A, R>(self: Effect.Effect<A, StorageNotFoundError | Session.ForkConflict, R>) {
  return self.pipe(
    Effect.mapError((error) =>
      error instanceof Session.ForkConflict
        ? new ApiError.ConflictError({ message: error.reason, resource: `fork_intent:${error.intentID}` })
        : ApiError.notFound(error.message),
    ),
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
