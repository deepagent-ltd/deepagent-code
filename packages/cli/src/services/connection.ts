import { Context, Effect, Layer, Option } from "effect"
import { Daemon } from "./daemon"
import { ServerMode } from "./server-mode"

// The local daemon has no custom fetch, so Connection widens the server-mode
// transport shape instead of redefining it.
export interface Transport extends Omit<ServerMode.Transport, "fetch"> {
  readonly fetch?: ServerMode.Transport["fetch"]
}

export interface Interface {
  readonly transport: () => Effect.Effect<Transport, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/cli/Connection") {}

// Server mode (DeepAgent Server Edition gateway) takes precedence when active:
// either DEEPAGENT_GATEWAY_URL is pinned or a server-mode login exists. Otherwise
// fall back to the local background daemon.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const daemon = yield* Daemon.Service
    const serverMode = yield* ServerMode.Service

    const transport = Effect.fn("cli.connection.transport")(function* () {
      const remote = yield* serverMode.transport()
      if (Option.isSome(remote)) return remote.value
      return yield* daemon.transport()
    })

    return Service.of({ transport })
  }),
)

export const defaultLayer = layer

export * as Connection from "./connection"
