export * as ContextQueryAuthorization from "./query-authorization"

import { Context, Effect, Layer } from "effect"
import type { EgressPolicy, Principal } from "./authorization"

export type Envelope = {
  readonly principal: Principal
  readonly egress: EgressPolicy
}

export interface Interface {
  readonly resolve: (input: { readonly sessionId: string; readonly agent: string }) => Effect.Effect<Envelope | undefined>
}

export interface ControllerInterface {
  readonly bind: (input: { readonly sessionId: string; readonly envelope: Envelope }) => Effect.Effect<void>
  readonly remove: (sessionId: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ContextQueryAuthorization") {}
export class Controller extends Context.Service<Controller, ControllerInterface>()(
  "@deepagent-code/ContextQueryAuthorizationController",
) {}

// Session execution is process-local until clustered ownership lands, so the latest
// admitted authority for a Session is process-local too. Keeping the store in Core
// lets canonical V2 admission and host-provided query implementations share one
// authority without routing through the legacy prompt runtime.
const envelopes = new Map<string, Envelope>()

export function layer() {
  return Layer.merge(
    Layer.succeed(Service, Service.of({
      resolve: (input) => Effect.sync(() => envelopes.get(input.sessionId)),
    })),
    Layer.succeed(Controller, Controller.of({
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
