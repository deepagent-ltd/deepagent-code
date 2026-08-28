import { EOL } from "os"
import * as Effect from "effect/Effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Option, Redacted } from "effect"
import { Prompt } from "effect/unstable/cli"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerMode } from "../../services/server-mode"

export default Runtime.handler(
  Commands.commands.login,
  Effect.fn("cli.login")(function* (input) {
    const serverMode = yield* ServerMode.Service
    const gateway = Option.getOrUndefined(input.gateway) ?? process.env.DEEPAGENT_GATEWAY_URL
    if (gateway === undefined)
      return yield* Effect.fail(
        new Error("Gateway URL required. Pass it as an argument or set DEEPAGENT_GATEWAY_URL."),
      )
    const url = gateway.replace(/\/+$/, "")
    const email = yield* Option.match(input.email, {
      onNone: () =>
        Prompt.run(Prompt.text({ message: "Email" })).pipe(
          Effect.provide(NodeServices.layer),
          Effect.mapError(() => new Error("Login cancelled")),
        ),
      onSome: Effect.succeed,
    })
    const password = yield* Option.match(input.password, {
      onNone: () =>
        Prompt.run(Prompt.password({ message: "Password" })).pipe(
          Effect.provide(NodeServices.layer),
          Effect.map(Redacted.value),
          Effect.mapError(() => new Error("Login cancelled")),
        ),
      onSome: Effect.succeed,
    })
    const state = yield* serverMode.login(url, email, password)
    process.stdout.write(
      `Logged in to ${state.gatewayUrl} as ${email}.${state.workspaceId ? "" : " Run `dacode workspace list` to pick a workspace."}` +
        EOL,
    )
  }),
)
