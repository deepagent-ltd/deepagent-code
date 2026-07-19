import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { SessionClient } from "../../../services/session-client"

export default Runtime.handler(Commands.commands.session.commands.delete, (input) =>
  Effect.gen(function* () {
    const result = yield* SessionClient.deleteSession({ sessionID: input.sessionID })
    if (result.error) {
      return yield* Effect.fail(new Error(`Session not found: ${input.sessionID}`))
    }
    console.log(`Session ${input.sessionID} deleted`)
  }),
)
