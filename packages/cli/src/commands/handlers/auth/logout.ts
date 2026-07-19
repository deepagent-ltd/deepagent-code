import { Option } from "effect"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

export default Runtime.handler(
  Commands.commands.auth.commands.logout,
  Effect.fn("cli.auth.logout")(function* (input) {
    const daemon = yield* Daemon.Service
    const client = yield* daemon.client()

    const provider = Option.getOrNull(input.provider)
    if (!provider) {
      const result = yield* Effect.tryPromise(() => client.provider.list())
      const connected = result.data?.connected ?? []
      if (connected.length === 0) {
        console.log("No credentials configured.")
        return
      }
      console.log("Configured providers:")
      for (const id of connected) console.log(`  ${id}`)
      console.log('\nUsage: dacode auth logout <provider>')
      return
    }

    yield* Effect.tryPromise(() => client.auth.remove({ providerID: provider }))
    console.log(`Logged out from ${provider}`)
  }),
)
