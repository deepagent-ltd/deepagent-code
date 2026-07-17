import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect, Option } from "effect"
import { Daemon } from "../../services/daemon"
import { createOpencodeClient } from "@deepagent-code/sdk/v2/client"
import path from "node:path"

export default Runtime.handler(Commands, (input) =>
  Effect.gen(function* () {
    if (input.fork && !input.continue && Option.isNone(input.session))
      return yield* Effect.fail(new Error("--fork requires --continue or --session"))

    const project = Option.getOrUndefined(input.project)
    if (project) {
      const resolved = path.resolve(project)
      yield* Effect.try({
        try: () => process.chdir(resolved),
        catch: () => new Error(`Failed to change directory to ${resolved}`),
      })
    }
    const directory = process.cwd()

    const daemon = yield* Daemon.Service
    const transport = yield* daemon.transport()

    const sessionID = Option.getOrUndefined(input.session)
    if (sessionID) {
      const client = createOpencodeClient({ baseUrl: transport.url, directory, headers: transport.headers })
      yield* Effect.tryPromise({
        try: () => client.session.get({ sessionID }, { throwOnError: true }),
        catch: () => new Error(`Session not found: ${sessionID}`),
      })
    }

    const { runTui } = yield* Effect.promise(() => import("../../tui"))
    yield* runTui(
      transport,
      {
        continue: input.continue,
        sessionID,
        fork: input.fork,
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
        prompt: Option.getOrUndefined(input.prompt),
      },
      directory,
    )
  }),
)
