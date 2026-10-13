import { createServer } from "node:http"
import type { Duplex } from "node:stream"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import type { IMFacade } from "@/im/facade"

// QA composition differs from Server.listen: no restore/mDNS/control wrapper.
// Routes keep their normal runtime, Instance bootstrap, auth and filesystem.
export function start(options: { port: number; buildEngine: IMFacade.EngineBuilder; env?: Readonly<Record<string, string | undefined>> }) {
  return Effect.gen(function* () {
    const node = createServer()
    const upgrades = new Set<Duplex>()
    node.on("upgrade", (_request, socket) => { upgrades.add(socket); socket.once("close", () => upgrades.delete(socket)) })
    yield* Effect.addFinalizer(() => Effect.sync(() => { node.closeAllConnections(); upgrades.forEach((socket) => socket.destroy()) }))
    yield* Layer.build(HttpRouter.serve(HttpApiApp.createRoutes({ cors: ["http://127.0.0.1:64675"] }, undefined, { imFacade: { buildEngine: options.buildEngine, env: options.env } }), {
      disableListenLog: true, disableLogger: true,
    }).pipe(Layer.provide(layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layer(() => node, { port: options.port, host: "127.0.0.1", gracefulShutdownTimeout: "1 second" })),
      Layer.provideMerge(NodeServices.layer), Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))))
    const address = node.address()
    if (!address || typeof address === "string") return yield* Effect.die(new Error("Private media listener unavailable"))
    return { url: `http://127.0.0.1:${address.port}`, port: address.port }
  }).pipe(Effect.provide(HttpApiApp.context))
}

export * as MediaEffectListener from "./kernel-media-effect-listener"
