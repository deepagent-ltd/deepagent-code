import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect, Option } from "effect"
import { Flag } from "@deepagent-code/core/flag/flag"

export default Runtime.handler(Commands.commands.web, (input) =>
  Effect.gen(function* () {
    const { Server } = yield* Effect.promise(() => import("deepagent-code/server/server"))
    if (!Flag.DEEPAGENT_CODE_SERVER_PASSWORD) {
      console.log("Warning: DEEPAGENT_CODE_SERVER_PASSWORD is not set; server is unsecured.")
    }

    const corsStr = Option.getOrElse(input.cors as Option.Option<string>, () => undefined)
    const cors = corsStr ? corsStr.split(",").map((s) => s.trim()).filter(Boolean) : undefined

    const port = Option.getOrElse(input.port as Option.Option<number>, () => 0)

    const server = yield* Effect.promise(() =>
      Server.listen({
        hostname: input.hostname,
        port,
        mdns: input.mdns,
        mdnsDomain: input["mdns-domain"],
        cors,
      }),
    )

    console.log(`\n  Backend:          ${server.url.toString()}`)
    console.log(`  Web interface:    ${server.url.toString()}\n`)

    const { spawn } = yield* Effect.promise(() => import("node:child_process"))
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    spawn(cmd, [server.url.toString()], { detached: true, stdio: "ignore" }).unref()

    yield* Effect.never
  }),
)
