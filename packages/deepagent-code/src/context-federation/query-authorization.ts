export * as LiveContextQueryAuthorization from "./query-authorization"

import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { Effect, Layer } from "effect"

// Session authorization is process-global, matching SessionExecution's current process-local owner.
// Multiple Layer consumers (automatic selection and tool facades) must resolve the same envelope.
const envelopes = new Map<string, ContextQueryAuthorization.Envelope>()

export function layer() {
  return Layer.merge(
    Layer.succeed(ContextQueryAuthorization.Service, ContextQueryAuthorization.Service.of({
      resolve: (input) => Effect.sync(() => envelopes.get(input.sessionId)),
    })),
    Layer.succeed(ContextQueryAuthorization.Controller, ContextQueryAuthorization.Controller.of({
      bind: (input) => Effect.sync(() => {
        if (!input.envelope.principal.sessionIds.includes(input.sessionId)) {
          throw new Error("query authorization must grant its bound Session")
        }
        envelopes.set(input.sessionId, input.envelope)
      }),
      remove: (sessionId) => Effect.sync(() => {
        envelopes.delete(sessionId)
      }),
    })),
  )
}

export const defaultLayer = layer()
