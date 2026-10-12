import { timingSafeEqual } from "node:crypto"
import { ServerAuth } from "@/server/auth"
import { CorsConfig, type CorsOptions } from "@/server/cors"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { Global } from "@deepagent-code/core/global"
import { McpAppResource } from "@/mcp/app-resource"
import { McpAppInvocationSchema } from "@deepagent-code/core/session/mcp-app-invocation.schema"
import { McpReadModel } from "@/mcp/read-model"
import { McpSecretMigration } from "@/mcp/secret-migration"
import { SecretRefScope } from "@/mcp/secret-ref-scope"
import { assertSafeInstanceRoot } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { provideInstanceContext } from "../middleware/instance-context"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { ServerCapabilities } from "@deepagent-code/core/server-capabilities"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { McpServerNotFoundError, ServiceUnavailableError } from "../errors"
import {
  AddPayload,
  ConfigRemovalError,
  McpAuthenticationRequired,
  McpMutationAuthorization,
  AuthCallbackPayload,
  CatalogEnablePayload,
  CatalogInstantiateApiError,
  StatusMap,
  UnsupportedOAuthError,
  OAuthFlowApiError,
  SecretMigrationCommit,
  BindingRepairCommand,
  SecretOperationError,
  SecretUnavailableError,
  McpAppOperationError,
  McpAppInvocationOperationError,
} from "../groups/mcp"

function requireMcpAuthentication(authentication: ServerAuth.Info, cors: CorsOptions | undefined) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const denied = () =>
      new McpAuthenticationRequired({
        error: "Configure a non-empty server password and authenticate this MCP operation",
      })
    if (!ServerAuth.required(authentication) || Option.isNone(authentication.password)) return yield* denied()
    const value = request.headers.authorization
    if (
      !value?.startsWith("Basic ") ||
      value.length > 8192 ||
      new URL(request.originalUrl, "http://localhost").searchParams.has("auth_token")
    )
      return yield* denied()
    const actual = Buffer.from(value)
    const expected = Buffer.from(
      `Basic ${Buffer.from(`${authentication.username}:${authentication.password.value}`).toString("base64")}`,
    )
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return yield* denied()
    const origin = request.headers.origin
    if (origin && origin !== "oc://renderer" && !cors?.cors?.includes(origin)) {
      if (!URL.canParse(origin)) return yield* denied()
      const url = new URL(origin)
      if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) || url.host !== request.headers.host)
        return yield* denied()
    }
  })
}

export const mcpMutationAuthorizationLayer = Layer.effect(
  McpMutationAuthorization,
  Effect.gen(function* () {
    const authentication = yield* ServerAuth.Config
    const cors = yield* CorsConfig
    const authorized = requireMcpAuthentication(authentication, cors)
    return McpMutationAuthorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.method === "GET") return yield* effect
        const rejected = yield* authorized.pipe(
          Effect.match({
            onSuccess: () => undefined,
            onFailure: (error) => HttpServerResponse.jsonUnsafe({ error: error.error }, { status: 401 }),
          }),
        )
        return rejected ?? (yield* effect)
      }),
    )
  }),
)

export const mcpHandlersBase = HttpApiBuilder.group(InstanceHttpApi, "mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const config = yield* Config.Service
    const reads = yield* McpReadModel.Service
    const instances = yield* InstanceStore.Service
    const authentication = yield* ServerAuth.Config
    const cors = yield* CorsConfig
    const requireAuthentication = requireMcpAuthentication(authentication, cors)

    const appOperation = <A>(operation: Effect.Effect<A, McpAppResource.Error>) =>
      provideInstanceContext(operation, instances).pipe(
        Effect.catchTag("McpAppResourceError", (error) => Effect.fail(new McpAppOperationError({
          code: error.reason,
          error: `MCP App ${error.reason}; refresh the current server and explicitly reopen the view`,
        }))),
      )
    const appUnavailable = new McpAppResource.Error({ reason: "unavailable" })
    const invocationOperation = <A, R>(operation: Effect.Effect<A, McpAppInvocationSchema.Error, R>) =>
      provideInstanceContext(operation, instances).pipe(
        Effect.catchTag("McpAppInvocation.Error", (error) => Effect.fail(new McpAppInvocationOperationError({
          code: error.code,
          error: `MCP App invocation ${error.code}; inspect the original invocation before any explicit retry`,
        }))),
      )
    const invocationUnavailable = new McpAppInvocationSchema.Error({ code: "unavailable", message: "MCP App invocation service is unavailable" })

    const secretOperation = <A, E>(
      operation: (service: McpSecretMigration.Interface) => Effect.Effect<A, McpSecretMigration.Error | E>,
    ) =>
      Effect.gen(function* () {
        yield* requireAuthentication
        const route = yield* WorkspaceRouteContext
        if (route.workspaceID || !mcp.secretMigration)
          return yield* new SecretUnavailableError({
            code: "unavailable",
            error: "Scoped MCP credential operation unavailable",
          })
        yield* Effect.try({
          try: () => assertSafeInstanceRoot(route.directory),
          catch: () => new SecretUnavailableError({ code: "unavailable", error: "Scoped MCP directory unavailable" }),
        })
        // A preview/status must not bootstrap an instance, connect its MCPs or create authority.
        return yield* operation(mcp.secretMigration).pipe(
          Effect.provideService(SecretRefScope.RequestDirectory, route.directory),
          Effect.catchIf(
            (error): error is McpSecretMigration.Error => error instanceof McpSecretMigration.Error,
            (error) =>
              Effect.fail(
                error.reason === "unavailable"
                  ? new SecretUnavailableError({ code: "unavailable", error: error.message })
                  : new SecretOperationError({ code: error.reason, error: error.message }),
              ),
          ),
        )
      })

    const status = Effect.fn("McpHttpApi.status")(function* () {
      return yield* reads.status(yield* WorkspaceRouteContext)
    })

    const add = Effect.fn("McpHttpApi.add")(function* (ctx: { payload: typeof AddPayload.Type }) {
      // Admin-controlled ServerCapabilities gate. The instance runtime has no core
      // Policy service, so we evaluate the injected capability set directly from the
      // env (deny-only, fail-open-when-unset — same semantics as Policy.evaluate).
      // See server-capabilities.ts / docs/code-server-runtime-v1.md §3.1.
      if (!ServerCapabilities.isAllowed(ServerCapabilities.Actions.mcpInstall))
        return yield* new HttpApiError.BadRequest({})
      // M7 (S1-v3.4) SECURITY: strip any client-supplied `riskTier`. The permission gate derives the
      // tier by catalog-matching the live config (mcp/index.ts), so a persisted `riskTier` is never
      // trusted — but dropping it here keeps the stored config honest and avoids a misleading flag.
      const { riskTier: _dropped, ...config } = ctx.payload.config as typeof ctx.payload.config & {
        riskTier?: unknown
      }
      const result = (yield* mcp.add(ctx.payload.name, config as typeof ctx.payload.config).pipe(
        Effect.catchTag("MCP.OAuthFlowError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )).status
      return yield* Schema.decodeUnknownEffect(StatusMap)(
        "status" in result ? { [ctx.payload.name]: result } : result,
      ).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const catalog = Effect.fn("McpHttpApi.catalog")(function* () {
      return yield* mcp.catalog()
    })

    const catalogEnable = Effect.fn("McpHttpApi.catalogEnable")(function* (ctx: {
      payload: typeof CatalogEnablePayload.Type
    }) {
      yield* requireAuthentication
      // Same ServerCapabilities gate as `add` — enabling a catalog entry installs an
      // MCP server. This endpoint does not declare BadRequest, so deny surfaces as
      // CatalogInstantiateApiError (a declared error on this endpoint).
      if (!ServerCapabilities.isAllowed(ServerCapabilities.Actions.mcpInstall))
        return yield* new CatalogInstantiateApiError({
          error: "MCP server installation is disabled by the server administrator.",
        })
      const enabled = yield* mcp
        .enableCatalogEntry(ctx.payload.id, {
          params: ctx.payload.params,
          credentialRefs: ctx.payload.credentialRefs,
        })
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `Unknown catalog entry: ${error.name}` }),
            ),
          ),
          Effect.catchTag("CatalogInstantiateError", (error) =>
            Effect.fail(new CatalogInstantiateApiError({ error: error.message })),
          ),
          Effect.catchTag("MCP.OAuthFlowError", (error) =>
            Effect.fail(new CatalogInstantiateApiError({ error: error.message })),
          ),
        )
      const result = enabled.status
      const status = yield* Schema.decodeUnknownEffect(StatusMap)(
        "status" in result ? { [enabled.name]: result } : result,
      ).pipe(Effect.mapError(() => new CatalogInstantiateApiError({ error: "failed to decode status" })))
      // Return the instantiated name+config so the caller persists it to cfg.mcp (durable), matching
      // the manual-add flow; the backend only connected it in-memory.
      return { status, name: enabled.name, config: enabled.config }
    })

    const authStart = Effect.fn("McpHttpApi.authStart")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        yield* requireAuthentication
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.startAuth(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.OAuthFlowError", (error) => Effect.fail(new OAuthFlowApiError({ error: error.message }))),
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authCallback = Effect.fn("McpHttpApi.authCallback")(function* (ctx: {
      params: { name: string }
      payload: typeof AuthCallbackPayload.Type
    }) {
      yield* requireAuthentication
      return yield* mcp.finishAuth(ctx.params.name, ctx.payload.code, ctx.payload.oauthState, ctx.payload.iss).pipe(
        Effect.catchTag("MCP.OAuthFlowError", (error) => Effect.fail(new OAuthFlowApiError({ error: error.message }))),
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authAuthenticate = Effect.fn("McpHttpApi.authAuthenticate")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        yield* requireAuthentication
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.authenticate(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.OAuthFlowError", (error) => Effect.fail(new OAuthFlowApiError({ error: error.message }))),
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authRemove = Effect.fn("McpHttpApi.authRemove")(function* (ctx: { params: { name: string } }) {
      yield* requireAuthentication
      const status = yield* mcp.status()
      if (!(ctx.params.name in status))
        return yield* new McpServerNotFoundError({
          name: ctx.params.name,
          message: `MCP server not found: ${ctx.params.name}`,
        })
      yield* mcp
        .removeAuth(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.OAuthFlowError", (error) =>
            Effect.fail(new OAuthFlowApiError({ error: error.message })),
          ),
        )
      return { success: true as const }
    })

    const connect = Effect.fn("McpHttpApi.connect")(function* (ctx: { params: { name: string } }) {
      yield* requireAuthentication
      yield* mcp.connect(ctx.params.name).pipe(
        Effect.catchTag("MCP.OAuthFlowError", (error) => Effect.fail(new OAuthFlowApiError({ error: error.message }))),
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
      return true
    })

    const disconnect = Effect.fn("McpHttpApi.disconnect")(function* (ctx: { params: { name: string } }) {
      yield* requireAuthentication
      yield* mcp
        .disconnect(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
      return true
    })

    const removeConfig = Effect.fn("McpHttpApi.removeConfig")(function* (ctx: { params: { name: string } }) {
      const route = yield* WorkspaceRouteContext
      if (route.workspaceID || !config.mcpSnapshot || !config.removeGlobalMcp || !mcp.disconnectForRemoval)
        return yield* new ServiceUnavailableError({ message: "Scoped MCP configuration removal is unavailable" })
      const original = yield* config.mcpSnapshot()
      if (Object.hasOwn(original.config.mcp ?? {}, ctx.params.name)) {
        if (original.config.mcp_origins?.[ctx.params.name] !== Global.Path.config)
          return yield* new ConfigRemovalError({ code: "readonly", error: "This MCP server is supplied by another configuration source; remove it at that source." })
        yield* mcp.disconnectForRemoval(ctx.params.name).pipe(
          Effect.catchTag("MCP.RemovalCloseError", () => Effect.fail(new ConfigRemovalError({
            code: "unknown", error: "MCP close was not confirmed. Its original client and configuration are retained; do not reconnect or repeat tool operations.",
          }))),
          Effect.catchTag("MCP.NotFoundError", (error) => Effect.fail(new McpServerNotFoundError({
            name: error.name, message: `MCP server not found: ${error.name}`,
          }))),
        )
      }
      yield* config.removeGlobalMcp(ctx.params.name, original).pipe(
        Effect.catchTag("ConfigMcpRemovalError", (error) => Effect.fail(new ConfigRemovalError({
          code: error.reason,
          error: error.reason === "readonly"
            ? "This MCP server is supplied by another configuration source; remove it at that source."
            : "The MCP configuration changed or another source still supplies this server; refresh the current configuration.",
        }))),
      )
      return { removed: true as const }
    })

    return handlers
      .handle("apps", () => appOperation(mcp.appResources?.() ?? Effect.fail(appUnavailable)))
      .handle("appOpen", (ctx) => Effect.andThen(requireAuthentication, appOperation(mcp.appResourceRead?.(ctx.payload) ?? Effect.fail(appUnavailable))))
      .handle("appCheck", (ctx) => Effect.andThen(requireAuthentication, appOperation(mcp.appResourceCheck?.(ctx.payload) ?? Effect.fail(appUnavailable))))
      .handle("appClose", (ctx) => Effect.andThen(requireAuthentication, appOperation(
        mcp.appResourceClose ? mcp.appResourceClose(ctx.payload).pipe(Effect.as(true)) : Effect.fail(appUnavailable),
      )))
      .handle("appInvoke", (ctx) => Effect.andThen(requireAuthentication, invocationOperation(mcp.appInvoke?.(ctx.payload) ?? Effect.fail(invocationUnavailable))))
      .handle("appViewTools", (ctx) => Effect.andThen(requireAuthentication, invocationOperation(mcp.appViewTools?.(ctx.payload) ?? Effect.fail(invocationUnavailable))))
      .handle("appInvocationStatus", (ctx) => Effect.andThen(requireAuthentication, invocationOperation(mcp.appInvocationStatus?.(ctx.payload) ?? Effect.fail(invocationUnavailable))))
      .handle("appInvocationResult", (ctx) => Effect.andThen(requireAuthentication, invocationOperation(mcp.appInvocationResult?.(ctx.payload) ?? Effect.fail(invocationUnavailable))))
      .handle("appInvocationList", (ctx) => Effect.andThen(requireAuthentication, invocationOperation(mcp.appInvocationList?.(ctx.payload) ?? Effect.fail(invocationUnavailable))))
      .handle("status", status)
      .handle("add", (ctx) => Effect.andThen(requireAuthentication, provideInstanceContext(add(ctx), instances)))
      .handle("removeConfig", (ctx) =>
        Effect.andThen(requireAuthentication, provideInstanceContext(removeConfig(ctx), instances)),
      )
      .handle("catalog", catalog)
      .handle("catalogEnable", (ctx) =>
        Effect.andThen(requireAuthentication, provideInstanceContext(catalogEnable(ctx), instances)),
      )
      .handle("authStart", (ctx) =>
        Effect.andThen(requireAuthentication, provideInstanceContext(authStart(ctx), instances)),
      )
      .handle("authCallback", (ctx) =>
        Effect.andThen(requireAuthentication, provideInstanceContext(authCallback(ctx), instances)),
      )
      .handle("authAuthenticate", (ctx) =>
        Effect.andThen(requireAuthentication, provideInstanceContext(authAuthenticate(ctx), instances)),
      )
      .handle("authRemove", (ctx) =>
        Effect.andThen(requireAuthentication, provideInstanceContext(authRemove(ctx), instances)),
      )
      .handle("connect", (ctx) =>
        Effect.andThen(requireAuthentication, provideInstanceContext(connect(ctx), instances)),
      )
      .handle("disconnect", (ctx) =>
        Effect.andThen(requireAuthentication, provideInstanceContext(disconnect(ctx), instances)),
      )
      .handle("credentialsInitialize", (ctx) => secretOperation((service) => service.initialize(ctx.params.name)))
      .handle("credentialsPreview", (ctx) => secretOperation((service) => service.preview(ctx.params.name)))
      .handle("credentialsCommit", (ctx: { params: { name: string }; payload: typeof SecretMigrationCommit.Type }) =>
        secretOperation((service) => service.commit({ ...ctx.payload, name: ctx.params.name })),
      )
      .handle("credentialsStatus", (ctx) =>
        secretOperation((service) =>
          Effect.gen(function* () {
            const status = yield* service.status(ctx.params.requestID, ctx.params.name)
            if (!status) return yield* new HttpApiError.NotFound({})
            return status
          }),
        ),
      )
      .handle("credentialsReconcile", (ctx) =>
        secretOperation((service) => service.reconcile(ctx.params.requestID, ctx.params.name)),
      )
      .handle("bindingPreview", (ctx) => secretOperation((service) => service.previewBinding(ctx.params.name)))
      .handle("bindingRepair", (ctx: { params: { name: string }; payload: typeof BindingRepairCommand.Type }) =>
        secretOperation((service) => service.repairBinding(ctx.payload.previewID, ctx.params.name)),
      )
  }),
)
export const mcpHandlers = mcpHandlersBase.pipe(Layer.provide(McpReadModel.layer))
