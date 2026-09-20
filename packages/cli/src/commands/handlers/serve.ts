import { NodeHttpServer } from "@effect/platform-node"
import { Cause, Context, Layer, Option } from "effect"
import * as Effect from "effect/Effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { createRoutes, runtimeLayer } from "@deepagent-code/server/routes"
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
  // port only when another local server already owns 4096. Runtime/bootstrap
  // failures must remain visible and must never be retried under a different port.
  return bind(hostname, 4096, password).pipe(
    Effect.catchCause((cause) =>
      errorCode(Cause.squash(cause)) === "EADDRINUSE" ? bind(hostname, 0, password) : Effect.failCause(cause),
    ),
  )
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  if ("code" in error && typeof error.code === "string") return error.code
  if ("cause" in error) return errorCode(error.cause)
  return undefined
}

function bind(hostname: string, port: number, password: string) {
  return Layer.build(
    HttpRouter.serve(createRoutes(password), { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port, host: hostname })),
    ),
  ).pipe(
    Effect.provide(runtimeLayer),
    Effect.map((context) => Context.get(context, HttpServer.HttpServer).address),
  )
}
