import { Option } from "effect"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

export default Runtime.handler(
  Commands.commands.auth.commands.list,
  Effect.fn("cli.auth.list")(function* () {
    const daemon = yield* Daemon.Service
    const client = yield* daemon.client()
    const result = yield* Effect.tryPromise(() => client.provider.list())

    const providers = result.data?.all ?? []
    const connected = result.data?.connected ?? []

    if (connected.length === 0) {
      console.log("No credentials configured.")
      console.log("Run `dacode auth login <provider>` to add credentials.")
      return
    }

    const names = new Map(providers.map((p) => [p.id, p.name]))
    for (const providerID of connected) {
      const name = names.get(providerID) ?? providerID
      console.log(`${name} (${providerID})`)
    }

    console.log(`\n${connected.length} credential(s)`)

    const envVars: Array<{ provider: string; envVar: string }> = []
    for (const provider of providers) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) envVars.push({ provider: provider.name ?? provider.id, envVar })
      }
    }

    if (envVars.length > 0) {
      console.log("\nEnvironment variables:")
      for (const { provider, envVar } of envVars) {
        console.log(`  ${provider}: ${envVar}`)
      }
    }
  }),
)
