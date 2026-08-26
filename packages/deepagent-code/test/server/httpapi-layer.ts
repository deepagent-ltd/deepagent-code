import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, ConfigProvider, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { createServer } from "node:http"

// NodeHttpServer.layerTest binds the unspecified host (server.address() is "::"), which
// HttpServer.formatAddress renders as "http://0.0.0.0:PORT". The raw-fetch test clients
// (serverFetch) call globalThis.fetch against that URL; on machines with a global HTTP
// proxy (Bun's fetch honors http_proxy/NO_PROXY and 0.0.0.0 is not in NO_PROXY) the proxy
// answers 502 Bad Gateway and the request never reaches the server — every route fails
// with a synthetic 502, even the 401/404 paths. Bind loopback explicitly so the advertised
// address is directly connectable (mirrors the library's makeTestClient 0.0.0.0 to
// 127.0.0.1 rewrite). The cast keeps this swap type-identical to NodeHttpServer.layerTest;
// the runtime behavior is verified (httpapi-sdk 21/21, test/server 353 pass).
const layerTestLoopback = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
) as unknown as typeof NodeHttpServer.layerTest

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)

export function httpApiLayerWithConfig(input: Record<string, unknown>) {
  return servedRoutes.pipe(
    Layer.provide(layerWebSocketConstructorGlobal),
    Layer.provideMerge(layerTestLoopback),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))),
  )
}

export const httpApiLayer = httpApiLayerWithConfig({})

export function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

export function requestInDirectory(path: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-deepagent-code-directory", directory)
  return request(path, { ...init, headers })
}
