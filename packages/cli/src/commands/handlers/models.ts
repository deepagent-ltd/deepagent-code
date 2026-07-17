import { EOL } from "os"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Daemon } from "../../services/daemon"

export default Runtime.handler(Commands.commands.models, (input) =>
  Effect.gen(function* () {
    const daemon = yield* Daemon.Service
    const client = yield* daemon.client()
    const result = yield* Effect.tryPromise(() => client.provider.list())
    const providers = result.data?.all ?? []

    if (Option.isSome(input.provider)) {
      const providerID = input.provider.value
      const provider = providers.find((p) => p.id === providerID)
      if (!provider) return yield* Effect.fail(new Error(`Provider not found: ${providerID}`))
      printProvider(provider.id, provider.models, input.verbose)
      return
    }

    const sorted = [...providers].sort((a, b) => a.id.localeCompare(b.id))
    for (const provider of sorted) {
      printProvider(provider.id, provider.models, input.verbose)
    }
  }),
)

function printProvider(providerID: string, models: Record<string, unknown>, verbose?: boolean) {
  const sorted = Object.entries(models).sort(([a], [b]) => a.localeCompare(b))
  for (const [modelID, model] of sorted) {
    process.stdout.write(`${providerID}/${modelID}${EOL}`)
    if (verbose) {
      process.stdout.write(JSON.stringify(model, null, 2) + EOL)
    }
  }
}
