import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerMode } from "../../../services/server-mode"

export default Runtime.handler(
  Commands.commands.workspace.commands.list,
  Effect.fn("cli.workspace.list")(function* () {
    const serverMode = yield* ServerMode.Service
    const list = yield* serverMode.workspaces()
    const current = yield* serverMode
      .status()
      .pipe(Effect.map((state) => (Option.isSome(state) ? state.value.workspaceId : undefined)))
    list.forEach((workspace) => {
      const selected = current === workspace.id ? "*" : " "
      process.stdout.write(
        `${selected} ${workspace.id}  ${workspace.name ?? "-"}  ${workspace.status ?? "-"}` + EOL,
      )
    })
  }),
)
