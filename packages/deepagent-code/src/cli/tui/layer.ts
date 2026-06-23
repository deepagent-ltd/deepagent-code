import { run as runTui, type TuiInput } from "@deepagent-code/tui"
import { Global } from "@deepagent-code/core/global"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(Global.defaultLayer))
}
