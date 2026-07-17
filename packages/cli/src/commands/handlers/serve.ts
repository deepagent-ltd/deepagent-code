import { Option } from "effect"
import * as Effect from "effect/Effect"
import { HttpServer } from "effect/unstable/http"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Daemon } from "../../services/daemon"

export default Runtime.handler(
  Commands.commands.serve,
  Effect.fn("cli.serve")(function* (input) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* Daemon.Service
        // Server-mode (e.g. deepagent-code-server workspace-agent) injects the
        // Basic Auth credential via DEEPAGENT_CODE_SERVER_PASSWORD and expects
        // the server to honor it. When present, use it directly and skip daemon
        // registration (that discovery/reconnect flow is a local-desktop concern
        // and would otherwise overwrite the injected credential with a random
        // file-based one). When absent, preserve the existing local behavior.
        const envPassword = process.env.DEEPAGENT_CODE_SERVER_PASSWORD
        const serverMode = typeof envPassword === "string" && envPassword !== ""
        const password = serverMode ? envPassword : yield* daemon.password()
        // The legacy full server (packages/deepagent-code/src/server/server.ts)
        // reads its Basic Auth credential from the DEEPAGENT_CODE_SERVER_PASSWORD
        // env var via ServerAuth.Config — there is no `password` listen argument.
        // Inject it before listen so the complete HttpApi surface (session,
        // provider, mcp, config, deepagent/*, oversight/*, ...) is authenticated
        // identically to the GUI and the old `deepagent serve` command.
        if (password) process.env.DEEPAGENT_CODE_SERVER_PASSWORD = password
        if (!password) console.log("Warning: DEEPAGENT_CODE_SERVER_PASSWORD is not set; server is unsecured.")
        const { Server } = yield* Effect.promise(() => import("deepagent-code/server/server"))
        const listener = yield* Effect.promise(() =>
          Server.listen({
            hostname: input.hostname,
            port: Option.isSome(input.port) ? input.port.value : 0,
            mdns: input.mdns,
            mdnsDomain: input["mdns-domain"],
            cors: Option.isSome(input.cors)
              ? input.cors.value
                  .split(",")
                  .map((origin) => origin.trim())
                  .filter(Boolean)
              : [],
          }),
        )
        yield* Effect.addFinalizer(() => Effect.promise(() => listener.stop()))
        if (input.register && !serverMode) {
          const address: HttpServer.Address = {
            _tag: "TcpAddress",
            hostname: listener.hostname,
            port: listener.port,
          }
          yield* daemon.register(address)
        }
        console.log(`server listening on ${listener.url.toString()}`)
        return yield* Effect.never
      }),
    )
  }),
)
