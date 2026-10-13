import { NodeHttpServer } from "@effect/platform-node"
import { Session } from "@/session/session"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { ServerAuth } from "@/server/auth"
import { CorsConfig } from "@/server/cors"
import { mcpMutationAuthorizationLayer } from "@/server/routes/instance/httpapi/handlers/mcp"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { McpApi, McpPaths, McpAppInvocationOperationError } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { testEffect } from "../lib/effect"

const TestHttpApi = HttpApi.make("deepagent-code-instance").addHttpApi(McpApi)
const fakeSession = Layer.mock(Session.Service)({})
const testMcpHandlers = HttpApiBuilder.group(TestHttpApi, "mcp", (handlers) =>
  Effect.succeed(
    handlers
      .handle("apps", () => Effect.die("unexpected MCP apps"))
      .handle("appOpen", () => Effect.die("unexpected MCP appOpen"))
      .handle("appCheck", () => Effect.die("unexpected MCP appCheck"))
      .handle("appClose", () => Effect.die("unexpected MCP appClose"))
      .handle("appInvoke", () => Effect.fail(new McpAppInvocationOperationError({ code: "unavailable", error: "App invocation is not installed in this OAuth-only fixture" })))
      .handle("appInvocationStatus", () => Effect.fail(new McpAppInvocationOperationError({ code: "unavailable", error: "App invocation is not installed in this OAuth-only fixture" })))
      .handle("appInvocationResult", () => Effect.fail(new McpAppInvocationOperationError({ code: "unavailable", error: "App invocation is not installed in this OAuth-only fixture" })))
      .handle("appInvocationList", () => Effect.fail(new McpAppInvocationOperationError({ code: "unavailable", error: "App invocation is not installed in this OAuth-only fixture" })))
      .handle("appViewTools", () => Effect.fail(new McpAppInvocationOperationError({ code: "unavailable", error: "App invocation is not installed in this OAuth-only fixture" })))
      .handle("status", () => Effect.die("unexpected MCP status"))
      .handle("add", () => Effect.die("unexpected MCP add"))
      .handle("catalog", () => Effect.die("unexpected MCP catalog"))
      .handle("catalogEnable", () => Effect.die("unexpected MCP catalogEnable"))
      .handle("authStart", () =>
        Effect.succeed({ authorizationUrl: "https://auth.example/start", oauthState: "state-123" }),
      )
      .handle("authCallback", () => Effect.die("unexpected MCP authCallback"))
      .handle("authAuthenticate", () => Effect.die("unexpected MCP authAuthenticate"))
      .handle("authRemove", () => Effect.die("unexpected MCP authRemove"))
      .handle("connect", () => Effect.die("unexpected MCP connect"))
      .handle("disconnect", () => Effect.die("unexpected MCP disconnect"))
      .handle("removeConfig", () => Effect.die("unexpected MCP removeConfig"))
      .handle("credentialsInitialize", () => Effect.die("unexpected MCP credentialsInitialize"))
      .handle("credentialsPreview", () => Effect.die("unexpected MCP credentialsPreview"))
      .handle("credentialsCommit", () => Effect.die("unexpected MCP credentialsCommit"))
      .handle("credentialsStatus", () => Effect.die("unexpected MCP credentialsStatus"))
      .handle("credentialsReconcile", () => Effect.die("unexpected MCP credentialsReconcile"))
      .handle("bindingPreview", () => Effect.die("unexpected MCP bindingPreview"))
      .handle("bindingRepair", () => Effect.die("unexpected MCP bindingRepair")),
  ),
)

const passthroughAuthorization = Layer.succeed(
  Authorization,
  Authorization.of((effect) => effect),
)

const passthroughInstanceContext = Layer.succeed(
  InstanceContextMiddleware,
  InstanceContextMiddleware.of((effect) => effect),
)

const testWorkspaceRouting = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory: process.cwd() }))),
  ),
)

const credentials = { username: "mcp-fixture", password: crypto.randomUUID() }
const currentAuthorization = mcpMutationAuthorizationLayer.pipe(
  Layer.provide(
    ServerAuth.Config.layer({ username: credentials.username, password: Option.some(credentials.password) }),
  ),
  Layer.provide(Layer.succeed(CorsConfig, undefined)),
)

const it = testEffect(
  HttpRouter.serve(
    HttpApiBuilder.layer(TestHttpApi).pipe(
      Layer.provide(testMcpHandlers),
      Layer.provide(currentAuthorization),
      Layer.provide([passthroughAuthorization, passthroughInstanceContext, testWorkspaceRouting, fakeSession]),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
)

describe("mcp HttpApi OAuth", () => {
  it.live("rejects an unauthenticated OAuth start before its handler", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(McpPaths.auth.replace(":name", "demo")).pipe(HttpClient.execute)
      expect(response.status).toBe(401)
    }),
  )

  it.live("preserves oauth state when starting OAuth", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(McpPaths.auth.replace(":name", "demo")).pipe(
        HttpClientRequest.setHeader("Authorization", ServerAuth.header(credentials)!),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        authorizationUrl: "https://auth.example/start",
        oauthState: "state-123",
      })
    }),
  )
})
