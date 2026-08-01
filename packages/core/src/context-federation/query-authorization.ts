export * as ContextQueryAuthorization from "./query-authorization"

import { Context, Effect } from "effect"
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
