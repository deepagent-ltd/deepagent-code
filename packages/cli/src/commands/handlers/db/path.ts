import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Effect } from "effect"

export default Runtime.handler(Commands.commands.db.commands.path, () =>
  Effect.gen(function* () {
    const { Database } = yield* Effect.promise(() => import("@deepagent-code/core/database/database"))
    console.log(Database.path())
  }),
)
