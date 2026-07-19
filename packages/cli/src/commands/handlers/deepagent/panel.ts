import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { rawGet, requireCapability } from "./util"

type PanelStatus = { sessionID: string; armed: boolean; explicit: boolean }

export default Runtime.handler(Commands.commands.panel, Effect.fn("cli.panel")(function* (input) {
  yield* requireCapability("expertPanel")

  if (input.action === "status") {
    const result = yield* rawGet<PanelStatus>(`/deepagent/panel/status?sessionID=${encodeURIComponent(input.sessionID)}`)
    const status = result.data
    if (!status) {
      console.log("No panel status available")
      return
    }
    const source = status.explicit ? "explicit" : "default"
    console.log(`Session: ${status.sessionID}`)
    console.log(`  Armed: ${status.armed} (${source})`)
    return
  }

  yield* Effect.fail(new Error(`Unknown panel action: ${input.action}`))
}))
