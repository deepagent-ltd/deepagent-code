import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerMode } from "../../../services/server-mode"

export default Runtime.handler(
  Commands.commands.workspace.commands.use,
  Effect.fn("cli.workspace.use")(function* (input) {
    const workspace = yield* (yield* ServerMode.Service).useWorkspace(input.id)
    process.stdout.write(`Using workspace ${workspace.id}${workspace.name ? ` (${workspace.name})` : ""}.` + EOL)
  }),
)
