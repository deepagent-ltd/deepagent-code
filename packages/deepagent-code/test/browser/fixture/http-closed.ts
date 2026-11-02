import { Server, BrowserNativeHost } from "../../../src/node"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const root = process.env.DAC_BROWSER_TEST_ROOT!
await BrowserNativeHost.prepare()
const servers = [
  process.platform === "win32" ? await listenUnsealedWindowsHttp() : await Server.listen({ hostname: "127.0.0.1", port: 0 }),
]
try {
  const payload = { requestID: "closed-fixture", sessionID: "ses_browser_not_created", profile: "managed-loopback-preview-v1",
    origin: "http://127.0.0.1:45678", expiresAt: Date.now() + 60_000 }
  const request = async (server: typeof servers[number], route: string, credentials: string | undefined, body?: unknown) => {
    const response = await fetch(new URL(route, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(credentials ? { authorization: `Basic ${Buffer.from(credentials).toString("base64")}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.text() }
  }
  const noHost = await request(servers[0]!, "/api/v1/browser/controls", "operator:private-fixture", payload)
  const wrongAuth = await request(servers[0]!, "/api/v1/browser/controls", "operator:wrong", payload)
  const emptyPassword = await request(servers[0]!, "/api/v1/browser/controls", "operator:", payload)
  const noAction = await request(servers[0]!, "/api/v1/browser/actions", "operator:private-fixture", { effectID: "caller-invented" })
  const absent = await request(servers[0]!, "/api/v1/browser/controls/absent", "operator:private-fixture")
  const db = new DatabaseSync(process.env.DEEPAGENT_CODE_DB!, { readOnly: true })
  const controls = db.prepare("SELECT count(*) AS count FROM browser_control").get()!.count
  const actions = db.prepare("SELECT count(*) AS count FROM browser_action").get()!.count
  db.close()
  await writeFile(path.join(root, "result.json"), JSON.stringify({ noHost, wrongAuth, emptyPassword, noAction, absent,
    controls, actions, hostAvailable: BrowserNativeHost.current() !== undefined, bunLoaded: process.versions.bun !== undefined }))
} finally {
  await Promise.all(servers.map((server) => server.stop()))
}
process.exit(0)

async function listenUnsealedWindowsHttp() {
  const { NodeHttpServer, NodeServices } = await import("@effect/platform-node")
  const { ConfigProvider, Context, Effect, Exit, Layer, Scope } = await import("effect")
  const { HttpRouter, HttpServer } = await import("effect/unstable/http")
  const { createServer } = await import("node:http")
  const { HttpApiApp } = await import("../../../src/server/routes/instance/httpapi/server")
  const { disposeMiddleware } = await import("../../../src/server/routes/instance/httpapi/lifecycle")
  const { WebSocketTracker } = await import("../../../src/server/routes/instance/httpapi/websocket-tracker")
  const { ListenerStop } = await import("../../../src/server/listener-stop")
  const { EmptySettingsFixture } = await import("../../fixture/empty-settings")
  if (!path.isAbsolute(root)) throw new Error("Unsealed HTTP fixture requires an explicit test root")
  const scope = Scope.makeUnsafe()
  const server = createServer()
  const sockets = new Set<import("node:net").Socket>()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  // Exercise original HTTP/auth/browser handlers without claiming production
  // Windows startup or supplying a Native, Work or private-file witness.
  const layer = HttpRouter.serve(HttpApiApp.createRoutes(), {
    middleware: disposeMiddleware, disableLogger: true, disableListenLog: true,
  }).pipe(
    Layer.provideMerge(Layer.fresh(WebSocketTracker.layer)),
    Layer.provideMerge(NodeHttpServer.layer(() => server, {
      port: 0, host: "127.0.0.1", gracefulShutdownTimeout: "1 second",
    })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(EmptySettingsFixture.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  )
  const context = await Effect.runPromise(Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope).pipe(
    Effect.provide(HttpApiApp.context), Effect.onError(() => Scope.close(scope, Exit.void)),
  ))
  const stop = ListenerStop.make({ scope, unpublish: Effect.void,
    websockets: Context.get(context, WebSocketTracker.Service),
    http: { close: Effect.void, closeAll: Effect.sync(() => sockets.forEach((socket) => socket.destroy())) },
  })
  try {
    const address = Context.get(context, HttpServer.HttpServer).address
    if (address._tag !== "TcpAddress") throw new Error("Unsealed HTTP fixture requires TCP")
    await writeFile(path.join(root, "safequalification.json"), JSON.stringify({
      kind: "unsealed-browser-http-refusal-v1", productionServerListen: false,
      privateSettings: "absent-only-read; publish-and-parent-refused", nativeQualification: "not-provided",
      sealedWorkQualification: "not-provided", routeGraph: "original-HttpApiApp.createRoutes",
    }))
    return { url: new URL(`http://127.0.0.1:${address.port}`), stop }
  } catch (error) {
    await stop(true)
    throw error
  }
}
