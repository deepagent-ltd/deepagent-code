export * as SessionProjection from "./session-projector"

import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { Effect, Layer } from "effect"

const eventLayer = Layer.effect(
  EventV2.Service,
  Effect.map(EventV2Bridge.Service, (events) => EventV2.Service.of(events)),
)

export const layer = SessionProjector.layer.pipe(Layer.provide(eventLayer))
export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
)
