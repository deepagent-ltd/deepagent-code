export * as RemoteCompactionWindow from "./remote-compaction-window"

import { Schema } from "effect"

// JSON-only durable provider state. No auth, headers, or endpoint secrets are stored here.
export const State = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  routeID: Schema.String,
  protocol: Schema.String,
  endpointHash: Schema.String,
  output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
})
export type State = typeof State.Type
