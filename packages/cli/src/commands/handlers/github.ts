import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect, Option } from "effect"

export default Runtime.handler(Commands.commands.github, (input) =>
  Effect.gen(function* () {
    const { spawn } = yield* Effect.promise(() => import("node:child_process"))
    const args = ["github", input.action]
    if (input.action === "run") {
      const eventOpt = input.event as Option.Option<string>
      const tokenOpt = input.token as Option.Option<string>
      if (Option.isSome(eventOpt)) args.push("--event", eventOpt.value)
      if (Option.isSome(tokenOpt)) args.push("--token", tokenOpt.value)
    }
    const child = spawn("deepagent-code", args, { stdio: "inherit" })
    const code = yield* Effect.promise(() => new Promise<number>((resolve) => child.on("close", resolve)))
    if (code !== 0) yield* Effect.fail(new Error(`github ${input.action} exited with code ${code}`))
  }),
)
