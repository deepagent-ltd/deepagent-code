export * as MoveSession from "./move-session"

import { Context, Effect, Layer, Schema } from "effect"
import { ProjectV2 } from "../project"
import { SessionV2 } from "../session"
import { SessionSchema } from "../session/schema"
import { AbsolutePath } from "../schema"

export const Destination = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "MoveSession.Destination" })
export type Destination = typeof Destination.Type

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  destination: Destination,
  moveChanges: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MoveSession.Input" })
export type Input = typeof Input.Type

export class DestinationProjectMismatchError extends Schema.TaggedErrorClass<DestinationProjectMismatchError>()(
  "MoveSession.DestinationProjectMismatchError",
  {
    expected: ProjectV2.ID,
    actual: ProjectV2.ID,
  },
) {}

export class ApplyChangesError extends Schema.TaggedErrorClass<ApplyChangesError>()("MoveSession.ApplyChangesError", {
  message: Schema.String,
}) {}

export class CaptureChangesError extends Schema.TaggedErrorClass<CaptureChangesError>()(
  "MoveSession.CaptureChangesError",
  {
    message: Schema.String,
  },
) {}

export class ResetSourceChangesError extends Schema.TaggedErrorClass<ResetSourceChangesError>()(
  "MoveSession.ResetSourceChangesError",
  {
    directory: AbsolutePath,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class TransferUnsupportedError extends Schema.TaggedErrorClass<TransferUnsupportedError>()(
  "MoveSession.TransferUnsupportedError",
  {
    sessionID: SessionSchema.ID,
    source: AbsolutePath,
    destination: AbsolutePath,
    message: Schema.String,
  },
) {}

export type Error =
  | SessionV2.NotFoundError
  | DestinationProjectMismatchError
  | CaptureChangesError
  | ApplyChangesError
  | ResetSourceChangesError
  | TransferUnsupportedError

export interface Interface {
  readonly moveSession: (input: Input) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ControlPlaneMoveSession") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* SessionV2.Service

    const moveSession = Effect.fn("MoveSession.moveSession")(function* (input: Input) {
      const current = yield* session.get(input.sessionID)
      const directory = AbsolutePath.make(input.destination.directory)
      if (current.location.directory === directory) return
      return yield* new TransferUnsupportedError({
        sessionID: input.sessionID,
        source: current.location.directory,
        destination: directory,
        message: "Session moves require durable transfer admission, execution fencing, and idempotent change receipts",
      })
    })

    return Service.of({ moveSession })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionV2.defaultLayer))
