import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerMode } from "../../services/server-mode"

export default Runtime.handler(
  Commands.commands.logout,
  Effect.fn("cli.logout")(function* () {
    yield* (yield* ServerMode.Service).logout()
    process.stdout.write("Logged out." + EOL)
  }),
)
