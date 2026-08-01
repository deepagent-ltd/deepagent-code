export * as EditorBufferSnapshot from "./editor-buffer"

import { Context, Effect, Schema } from "effect"
import { LocationKey } from "../context-federation/reference"

export const Snapshot = Schema.Struct({
  locationKey: LocationKey,
  path: Schema.String,
  content: Schema.String,
  contentSha: Schema.String,
  documentVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  observedAt: Schema.Int,
  visibility: Schema.Literals(["session", "workspace"]),
  sessionId: Schema.String.pipe(Schema.optional),
})
export type Snapshot = typeof Snapshot.Type

export interface Interface {
  readonly get: (input: {
    readonly locationKey: LocationKey
    readonly path: string
    readonly sessionId: string
  }) => Effect.Effect<Snapshot | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/EditorBufferSnapshot") {}
