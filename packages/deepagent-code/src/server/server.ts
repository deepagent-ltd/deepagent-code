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
import { devCampaignMint } from "@/effect/dev-campaign-mint"
import { builtAppRuntimeRoot, embeddedServerMemoMap } from "@/effect/app-runtime"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseBootstrapError, type BootstrapState } from "@deepagent-code/core/database/bootstrap"
import { ProcessLifecycle } from "@/effect/process-lifecycle"

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

type DefaultServer = {
  readonly app: ServerApp
  readonly dispose: () => Promise<void>
}

let defaultServer: {
  readonly value: DefaultServer
  readonly dispose: () => Promise<void>
  readonly unregister: () => void
} | undefined

export const Default = () => {
  if (defaultServer) return defaultServer.value
  const web = HttpApiApp.webHandler(embeddedServerMemoMap())
  const app: ServerApp = {
    fetch: (request: Request) => web.handler(request, HttpApiApp.context),
    request(input, init) {
      return app.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
  const value = { app, dispose: disposeDefault }
  defaultServer = {
    value,
    dispose: web.dispose,
    unregister: ProcessLifecycle.register("server.default", disposeDefault),
  }
  return value
}

export async function disposeDefault() {
  const current = defaultServer
  if (!current) return
  defaultServer = undefined
  current.unregister()
  await current.dispose()
}

export async function openapi() {
  return OpenApi.fromApi(PublicApi)
}

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
    // `Layer.fresh`: the tracker latches `closing` after closeAll, so a hot-restarted listener
    // must never reuse a memoized instance built by a previous (now stopped) listener's scope
    // when the memo map is shared with the AppRuntime root.
    Layer.provideMerge(Layer.fresh(WebSocketTracker.layer)),
    Layer.provideMerge(serverLayer({ port, hostname: opts.hostname })),
    // Install a fresh `ConfigProvider` per listener so `Config.string(...)`
    // reads reflect the current `process.env`. Effect's default
    // `ConfigProvider` snapshots `process.env` on first read and caches the
    // result on a module-singleton Reference; without overriding it here,
    // every later `Server.listen()` keeps observing that initial snapshot.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  )
}

function maintenanceListenerLayer(opts: ListenOptions, port: number, filename: string, state: BootstrapState) {
  return HttpRouter.serve(HttpApiApp.createMaintenanceRoutes(filename, state, opts), {
    middleware: disposeMiddleware,
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provideMerge(Layer.fresh(WebSocketTracker.layer)),
    Layer.provideMerge(serverLayer({ port, hostname: opts.hostname })),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  )
}

function startWithPortFallback(opts: ListenOptions) {
  if (opts.port !== 0) return startListener(opts, opts.port)
  // Match the legacy listener port-resolution behavior: explicit `0` prefers
  // 4096 first, then any free port.
  return startListener(opts, 4096).pipe(
    Effect.catchCause((cause) =>
      errorCode(Cause.squash(cause)) === "EADDRINUSE" ? startListener(opts, 0) : Effect.failCause(cause),
    ),
  )
}

function startListener(opts: ListenOptions, port: number) {
  return Effect.gen(function* () {
    const filename = Database.path()
    // When this process already built the AppRuntime root for the SAME database file (serve/web/acp
    // handlers and the TUI worker run inside AppRuntime before calling Server.listen), that root
    // has preflighted, migrated, and lifetime-locked the file. Re-running the external preflight
    // here would observe this process's OWN runtime lock and misclassify it as
    // another_process_active (maintenance-only boot). Adopt the built root instead: its memo map
    // resolves the route graph's Database/session authorities to the SAME instances, keeping one
    // owner and one lock. A root built for a different file (tests re-pointing
    // Flag.DEEPAGENT_CODE_DB) does not match and keeps the private-root path below.
    const root = builtAppRuntimeRoot()
    const sharedRoot = root?.databasePath === filename ? root : undefined
    const state =
      sharedRoot !== undefined || filename === ":memory:"
        ? undefined
        : yield* Effect.promise(() => Database.bootstrap(filename))
    const scope = Scope.makeUnsafe()
    const selected = state && !state.ready
      ? maintenanceListenerLayer(opts, port, filename, state)
      : listenerLayer(opts, port)
    const built = yield* Layer.buildWithMemoMap(selected, sharedRoot?.memoMap ?? Layer.makeMemoMapUnsafe(), scope).pipe(
      Effect.provide(HttpApiApp.context),
      Effect.exit,
    )
    if (Exit.isSuccess(built))
      return {
        scope,
        server: Context.get(built.value, HttpServer.HttpServer),
        http: Context.get(built.value, ListenerServerService),
        websockets: Context.get(built.value, WebSocketTracker.Service),
      } satisfies ListenerState

    yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
    const failure = Cause.squash(built.cause)
    if (state && !state.ready) return yield* Effect.failCause(built.cause)
    if (!(failure instanceof DatabaseBootstrapError)) return yield* Effect.failCause(built.cause)

    const maintenanceScope = Scope.makeUnsafe()
    const maintenance = yield* Layer.buildWithMemoMap(
      maintenanceListenerLayer(opts, port, filename, failure.state),
      Layer.makeMemoMapUnsafe(),
      maintenanceScope,
    ).pipe(
      Effect.provide(HttpApiApp.context),
      Effect.onError(() => Scope.close(maintenanceScope, Exit.void).pipe(Effect.ignore)),
    )
    return {
      scope: maintenanceScope,
      server: Context.get(maintenance, HttpServer.HttpServer),
      http: Context.get(maintenance, ListenerServerService),
      websockets: Context.get(maintenance, WebSocketTracker.Service),
    } satisfies ListenerState
  })
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  if ("code" in error && typeof error.code === "string") return error.code
  if ("cause" in error) return errorCode(error.cause)
  return undefined
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
  server.maxConnections = 2048
  const upgradedSockets = new Set<Duplex>()
  const activeSockets = new Set<Duplex>()
  const serverRef = { forceStop: false }
  let closePromise: Promise<void> | undefined
  const close = server.close.bind(server)
  // Bounded graceful close: Bun's node:http server.close(callback) only fires once
  // ALL active connections complete, and deepagent-code serves SSE/streaming
  // endpoints whose clients may hold sockets open indefinitely — an unbounded
  // wait would let stop() hang forever. Give the graceful close a budget, then
  // destroy the tracked sockets directly (closeAllConnections() is a no-op once
  // server.close() consumed its symbol, and upgraded sockets are excluded from
  // it anyway).
  const GRACEFUL_CLOSE_BUDGET_MS = 2_000
  // Node's closeAllConnections() deliberately excludes upgraded sockets.
  // Keep explicit ownership so forced shutdown cannot wait on a peer's
  // WebSocket close-handshake timeout.
  const destroyConnections = () => {
    server.closeAllConnections()
    upgradedSockets.forEach((socket) => socket.destroy())
    upgradedSockets.clear()
    activeSockets.forEach((socket) => socket.destroy())
    activeSockets.clear()
  }
  server.on("connection", (socket) => {
    activeSockets.add(socket)
    socket.once("close", () => activeSockets.delete(socket))
  })
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
            let settled = false
            const finish = (error?: Error) => {
              if (settled) return
              settled = true
              clearTimeout(budget)
              if (error) reject(error)
              else resolve()
            }
            const budget = setTimeout(() => {
              // Bun's node:http shim does not count upgraded sockets in `server.close()` and
              // can leave the close callback pending after a server-initiated WebSocket close.
              // Destroy both tracked sets at the bounded deadline so graceful stop cannot poison
              // a later forced stop or hold process disposal past its owner budget.
              destroyConnections()
              // Some Bun releases never invoke the callback after an upgraded socket was closed
              // by the server. The deadline is therefore also the authoritative completion point;
              // waiting for the callback here would make the advertised bound meaningless.
              finish()
            }, GRACEFUL_CLOSE_BUDGET_MS)
            server.close((error) => finish(error))
          })
          return closePromise
        }),
      }),
    ),
  )
}

export * as Server from "./server"
