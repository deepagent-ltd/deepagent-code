import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import { BrowserNativeHost, Log, NativeWindowsBootstrap } from "../../src/node"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { disposeMiddleware } from "../../src/server/routes/instance/httpapi/lifecycle"
import { WebSocketTracker } from "../../src/server/routes/instance/httpapi/websocket-tracker"
import { ListenerStop } from "../../src/server/listener-stop"
import { EmptySettingsFixture } from "./empty-settings"

export { BrowserNativeHost, Log, NativeWindowsBootstrap }

// A unit-fixture entry for the real utilityProcess/sidecar transport. It builds the
// original HTTP/Session graph, but is neither production Server.listen nor a Native
// cohort. Private settings must remain absent; no Native/Work port is supplied.
export const Server = {
  async listen(opts: { hostname: string; port: number; username: string; password: string; cors?: string[] }) {
    const root = process.env.DAC_UNSEALED_TEST_ROOT
    if (!root || !path.isAbsolute(root)) throw new Error("Unsealed server requires an explicit test root")
    if (opts.hostname !== "127.0.0.1" || !opts.username || !opts.password)
      throw new Error("Unsealed server requires authenticated loopback")
    if (
      process.env.DEEPAGENT_CODE_SERVER_USERNAME !== opts.username ||
      process.env.DEEPAGENT_CODE_SERVER_PASSWORD !== opts.password
    )
      throw new Error("Unsealed server credentials must match the original sidecar environment")
    if (await Effect.runPromise(NativeWindowsBootstrap.Registered))
      throw new Error("Unsealed test assembly cannot adopt a registered Native cohort")

    const scope = Scope.makeUnsafe()
    const server = createServer()
    const sockets = new Set<import("node:net").Socket>()
    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
    })
    const layer = HttpRouter.serve(HttpApiApp.createRoutes(opts), {
      middleware: disposeMiddleware,
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provideMerge(Layer.fresh(WebSocketTracker.layer)),
      Layer.provideMerge(
        NodeHttpServer.layer(() => server, {
          port: opts.port,
          host: opts.hostname,
          gracefulShutdownTimeout: "1 second",
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(EmptySettingsFixture.layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
    )
    const context = await Effect.runPromise(
      Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope).pipe(
        Effect.provide(HttpApiApp.context),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      ),
    )
    const stop = ListenerStop.make({
      scope,
      unpublish: Effect.void,
      websockets: Context.get(context, WebSocketTracker.Service),
      // NodeHttpServer owns graceful closure through the same scope; a forced
      // request destroys actual sockets, including upgraded peers.
      http: { close: Effect.void, closeAll: Effect.sync(() => sockets.forEach((socket) => socket.destroy())) },
    })
    try {
      await fs.writeFile(
        path.join(await fs.realpath(root), "safequalification.json"),
        JSON.stringify(
          {
            kind: "unsealed-canonical-test-assembly-v1",
            productionServerListen: false,
            privateSettings: "absent-only-read; publish-and-parent-refused",
            nativeQualification: "not-provided",
            sealedWorkQualification: "not-provided",
            routeGraph: "original-HttpApiApp.createRoutes",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      const address = Context.get(context, HttpServer.HttpServer).address
      if (address._tag !== "TcpAddress") throw new Error("Unsealed test server requires TCP")
      return {
        hostname: opts.hostname,
        port: address.port,
        url: new URL(`http://${opts.hostname}:${address.port}`),
        stop,
      }
    } catch (error) {
      await stop(true)
      throw error
    }
  },
}
