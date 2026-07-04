import { NodeHttpServer } from "@effect/platform-node"
import { PermissionSaved } from "@deepagent-code/core/permission/saved"
import { Context, Layer, Option } from "effect"
import * as Effect from "effect/Effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { createRoutes } from "@deepagent-code/server/routes"
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
        const address = yield* listen(input.hostname, input.port, password)
        if (input.register && !serverMode) yield* daemon.register(address)
        console.log(`server listening on ${HttpServer.formatAddress(address)}`)
        return yield* Effect.never
      }),
    )
  }),
)

function listen(hostname: string, port: Option.Option<number>, password: string) {
  if (Option.isSome(port)) return bind(hostname, port.value, password)
  // Preserve the familiar default when available, but let the OS choose a free
  // port when another local server already owns 4096.
  return bind(hostname, 4096, password).pipe(Effect.catch(() => bind(hostname, 0, password)))
}

function bind(hostname: string, port: number, password: string) {
  return Layer.build(
    HttpRouter.serve(createRoutes(password), { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port, host: hostname })),
      Layer.provide(PermissionSaved.defaultLayer),
    ),
  ).pipe(Effect.map((context) => Context.get(context, HttpServer.HttpServer).address))
}
