import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect, Option } from "effect"
import { ServerAuth } from "@deepagent-code/server/auth"

export default Runtime.handler(Commands.commands.attach, (input) =>
  Effect.gen(function* () {
    if (input.fork && !input.continue && Option.isNone(input.session as Option.Option<string>)) {
      yield* Effect.fail(new Error("--fork requires --continue or --session"))
    }

    const dirOpt = input.dir as Option.Option<string>
    const directory = (() => {
      if (Option.isNone(dirOpt)) return undefined
      try {
        process.chdir(dirOpt.value)
        return process.cwd()
      } catch {
        return dirOpt.value
      }
    })()

    const password = Option.getOrElse(input.password as Option.Option<string>, () => undefined)
    const username = Option.getOrElse(input.username as Option.Option<string>, () => undefined)
    const headers = ServerAuth.headers({ password, username })

    const sessionOpt = input.session as Option.Option<string>
    if (Option.isSome(sessionOpt)) {
      const { createOpencodeClient } = yield* Effect.promise(() => import("@deepagent-code/sdk/v2/client"))
      const client = createOpencodeClient({ baseUrl: input.url, directory, headers })
      yield* Effect.tryPromise({
        try: () => client.session.get({ sessionID: sessionOpt.value }, { throwOnError: true }),
        catch: () => new Error(`Session not found: ${sessionOpt.value}`),
      })
    }

    const { runTui } = yield* Effect.promise(() => import("../../tui"))
    yield* runTui(
      { url: input.url, headers },
      {
        continue: input.continue,
        sessionID: Option.getOrElse(sessionOpt, () => undefined),
        fork: input.fork,
      },
      directory,
    )
  }),
)
