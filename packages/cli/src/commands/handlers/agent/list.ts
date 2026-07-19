import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

export default Runtime.handler(
  Commands.commands.agent.commands.list,
  Effect.fn("cli.agent.list")(function* () {
    const daemon = yield* Daemon.Service
    const client = yield* daemon.client()
    const result = yield* Effect.tryPromise(() => client.app.agents())
    const agents = result.data ?? []

    const sorted = agents.sort((a, b) => {
      if (a.native !== b.native) return a.native ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (const agent of sorted) {
      process.stdout.write(`${agent.name} (${agent.mode})${agent.native ? " [native]" : ""}${EOL}`)
      if (agent.description) process.stdout.write(`  ${agent.description}${EOL}`)
    }
  }),
)
