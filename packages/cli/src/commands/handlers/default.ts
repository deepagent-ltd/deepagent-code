import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect } from "effect"
import { Connection } from "../../services/connection"

export default Runtime.handler(Commands, () =>
  Effect.gen(function* () {
    const connection = yield* Connection.Service
    const transport = yield* connection.transport()
    const { runTui } = yield* Effect.promise(() => import("../../tui"))
    yield* runTui(transport)
  }),
)
