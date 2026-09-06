export * as ContextToolRuntime from "./tool-runtime"

import { Context, Effect, Layer, Option } from "effect"
import type { AgentV2 } from "../agent"
import type { SessionSchema } from "../session/schema"
import type { ContextFederationContract } from "./contract"

export type Input<Request> = {
  readonly request: Request
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
}

export interface Interface {
  readonly codeIntel: (input: Input<ContextFederationContract.CodeIntelInput>) => Effect.Effect<string>
  readonly contextQuery: (input: Input<ContextFederationContract.ContextQueryInput>) => Effect.Effect<string>
}

/** Host seam behind Core's canonical read-only context tools. */
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/ContextToolRuntime") {}

const unavailable = Service.of({
  codeIntel: () => Effect.succeed(JSON.stringify({ schemaVersion: 2, error: { reason: "location_index_unavailable" } })),
  contextQuery: () => Effect.succeed(JSON.stringify({ schemaVersion: 1, error: { reason: "federated_context_unavailable" } })),
})

/** Captures a host override into the Location tool subtree; bare Core degrades honestly. */
export const seam = Layer.unwrap(
  Effect.map(
    Effect.serviceOption(Service),
    (provided) => Layer.succeed(Service, Option.getOrElse(provided, () => unavailable)),
  ),
)
