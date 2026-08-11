import "./init-projectors"

import { NodeHttpServer } from "@effect/platform-node"
import * as Log from "@deepagent-code/core/util/log"
import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import type { Duplex } from "node:stream"
import { MDNS } from "./mdns"
import { HttpApiApp } from "./routes/instance/httpapi/server"
import { disposeMiddleware } from "./routes/instance/httpapi/lifecycle"
import { WebSocketTracker } from "./routes/instance/httpapi/websocket-tracker"
import { PublicApi } from "./routes/instance/httpapi/public"
import type { CorsOptions } from "./cors"
import { lazy } from "@/util/lazy"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

const log = Log.create({ service: "server" })

// Tracks whether this process has already completed a successful Server.listen.
// First call is cold start; subsequent calls are hot restarts.
let serverHasListened = false

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
}

type ServerApp = {
  fetch(request: Request): Response | Promise<Response>
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

type ListenOptions = CorsOptions & {
  port: number
  hostname: string
  mdns?: boolean
  mdnsDomain?: string
}
type ListenerState = {
  scope: Scope.Scope
  server: Context.Service.Shape<typeof HttpServer.HttpServer>
  http: ListenerServer
  websockets: WebSocketTracker.Interface
}
interface ListenerServer {
  readonly closeAll: Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

class ListenerServerService extends Context.Service<ListenerServerService, ListenerServer>()(
  "@deepagent-code/ListenerServer",
) {}

export const Default = lazy(() => {
  const handler = HttpApiApp.webHandler().handler
  const app: ServerApp = {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input, init) {
      return app.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
  return { app }
})

export async function openapi() {
  return OpenApi.fromApi(PublicApi)
}

export let url: URL

export async function listen(opts: ListenOptions): Promise<Listener> {
  return Effect.runPromise(listenEffect(opts))
}

const listenEffect: (opts: ListenOptions) => Effect.Effect<Listener, unknown> = Effect.fn("Server.listen")(function* (
  opts: ListenOptions,
) {
  const cold = !serverHasListened
  const layerBuildT0 = yield* Effect.sync(() => Date.now())
  const state = yield* startWithPortFallback(opts)
  yield* Effect.sync(() => {
    log.info("startup", {
      event: "server.layer_build",
      durationMs: Date.now() - layerBuildT0,
      cold,
    })
    serverHasListened = true
  })
  const address = yield* tcpAddress(state)
  const listenerUrl = makeURL(opts.hostname, address.port)
  url = listenerUrl

  const unpublishMdns = yield* setupMdns(opts, address.port, state.scope)

  return {
    hostname: opts.hostname,
    port: address.port,
    url: listenerUrl,
    stop: makeStop(state, unpublishMdns),
  }
})

function listenerLayer(opts: ListenOptions, port: number) {
  return HttpRouter.serve(HttpApiApp.createRoutes(opts), {
    middleware: disposeMiddleware,
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provideMerge(WebSocketTracker.layer),
    Layer.provideMerge(serverLayer({ port, hostname: opts.hostname })),
    // Install a fresh `ConfigProvider` per listener so `Config.string(...)`
    // reads reflect the current `process.env`. Effect's default
    // `ConfigProvider` snapshots `process.env` on first read and caches the
    // result on a module-singleton Reference; without overriding it here,
    // every later `Server.listen()` keeps observing that initial snapshot.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  )
}

function startWithPortFallback(opts: ListenOptions) {
  if (opts.port !== 0) return startListener(opts, opts.port)
  // Match the legacy listener port-resolution behavior: explicit `0` prefers
  // 4096 first, then any free port.
  return startListener(opts, 4096).pipe(Effect.catch(() => startListener(opts, 0)))
}

function startListener(opts: ListenOptions, port: number) {
  const scope = Scope.makeUnsafe()
  return Layer.buildWithMemoMap(listenerLayer(opts, port), Layer.makeMemoMapUnsafe(), scope).pipe(
    Effect.provide(HttpApiApp.context),
    Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
    Effect.map(
      (ctx): ListenerState => ({
        scope,
        server: Context.get(ctx, HttpServer.HttpServer),
        http: Context.get(ctx, ListenerServerService),
        websockets: Context.get(ctx, WebSocketTracker.Service),
      }),
    ),
  )
}

function tcpAddress(state: ListenerState) {
  return Effect.gen(function* () {
    if (state.server.address._tag === "TcpAddress") return state.server.address
    yield* Scope.close(state.scope, Exit.void).pipe(Effect.ignore)
    return yield* Effect.die(new Error(`Unexpected HttpServer address tag: ${state.server.address._tag}`))
  })
}

function makeURL(hostname: string, port: number) {
  const result = new URL("http://localhost")
  result.hostname = hostname
  result.port = String(port)
  return result
}

function setupMdns(opts: ListenOptions, port: number, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const publish =
      opts.mdns && port && opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost" && opts.hostname !== "::1"
    if (publish) {
      const advertisement = yield* Effect.sync(() => MDNS.publish(port, opts.mdnsDomain))
      const unpublish = Effect.sync(() => advertisement.unpublish())
      yield* Scope.addFinalizer(scope, unpublish)
      return unpublish
    }
    if (opts.mdns) log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    return Effect.void
  })
}

function makeStop(state: ListenerState, unpublishMdns: Effect.Effect<void>) {
  const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)
  let unpublishPromise: Promise<void> | undefined
  let closeWebsocketsPromise: Promise<void> | undefined
  let forceClosePromise: Promise<void> | undefined
  let closeServerPromise: Promise<void> | undefined
  let closeScopePromise: Promise<void> | undefined
  let forceRequested = false

  return (close?: boolean) => {
    if (close) forceRequested = true
    unpublishPromise ??= run(unpublishMdns)
    closeWebsocketsPromise ??= unpublishPromise.then(() => run(state.websockets.closeAll))
    if (close) forceClosePromise ??= closeWebsocketsPromise.then(() => run(forceClose(state)))
    closeServerPromise ??= closeWebsocketsPromise.then(() => {
      if (forceRequested) {
        forceClosePromise ??= run(forceClose(state))
        return forceClosePromise.then(() => run(state.http.close))
      }
      return run(state.http.close)
    })
    closeScopePromise ??= closeServerPromise.then(() =>
      run(
        Scope.close(state.scope, Exit.void).pipe(
          Effect.timeoutOption("2 seconds"),
          Effect.tap((result) =>
            Option.isNone(result)
              ? Effect.sync(() => log.warn("listener scope close exceeded shutdown budget", { budgetMs: 2_000 }))
              : Effect.void,
          ),
          Effect.asVoid,
          Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.failCause(cause))),
        ),
      ),
    )

    return Promise.all([closeScopePromise, close ? forceClosePromise : undefined]).then(() => undefined)
  }
}

function forceClose(state: ListenerState) {
  return state.http.closeAll
}

function serverLayer(opts: { port: number; hostname: string }) {
  const server = createServer()
  const upgradedSockets = new Set<Duplex>()
  const serverRef = { forceStop: false }
  let closePromise: Promise<void> | undefined
  const close = server.close.bind(server)
  // Node's closeAllConnections() deliberately excludes upgraded sockets.
  // Keep explicit ownership so forced shutdown cannot wait on a peer's
  // WebSocket close-handshake timeout.
  const destroyConnections = () => {
    server.closeAllConnections()
    upgradedSockets.forEach((socket) => socket.destroy())
    upgradedSockets.clear()
  }
  server.on("upgrade", (_request, socket) => {
    upgradedSockets.add(socket)
    socket.once("close", () => upgradedSockets.delete(socket))
  })
  // Keep shutdown owned by NodeHttpServer. The wrapper covers a graceful stop
  // that entered its finalizer immediately before a concurrent forced stop.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Node's overloads don't preserve a monkey-patched method assignment.
  server.close = ((callback?: Parameters<typeof server.close>[0]) => {
    const result = close(callback)
    if (serverRef.forceStop) destroyConnections()
    return result
  }) as typeof server.close

  return Layer.mergeAll(
    NodeHttpServer.layer(() => server, { port: opts.port, host: opts.hostname, gracefulShutdownTimeout: "1 second" }),
    Layer.succeed(ListenerServerService)(
      ListenerServerService.of({
        closeAll: Effect.sync(() => {
          serverRef.forceStop = true
          destroyConnections()
        }),
        close: Effect.promise(() => {
          closePromise ??= new Promise<void>((resolve, reject) => {
            if (!server.listening) {
              resolve()
              return
            }
            server.close((error) => {
              if (error) reject(error)
              else resolve()
            })
          })
          return closePromise
        }),
      }),
    ),
  )
}

export * as Server from "./server"
