import { MCP } from "@/mcp"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { McpServerNotFoundError } from "../errors"
import {
  AddPayload,
  AuthCallbackPayload,
  CatalogEnablePayload,
  CatalogInstantiateApiError,
  StatusMap,
  UnsupportedOAuthError,
} from "../groups/mcp"

export const mcpHandlers = HttpApiBuilder.group(InstanceHttpApi, "mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    const status = Effect.fn("McpHttpApi.status")(function* () {
      return yield* mcp.status()
    })

    const add = Effect.fn("McpHttpApi.add")(function* (ctx: { payload: typeof AddPayload.Type }) {
      // M7 (S1-v3.4) SECURITY: strip any client-supplied `riskTier`. The permission gate derives the
      // tier by catalog-matching the live config (mcp/index.ts), so a persisted `riskTier` is never
      // trusted — but dropping it here keeps the stored config honest and avoids a misleading flag.
      const { riskTier: _dropped, ...config } = ctx.payload.config as typeof ctx.payload.config & {
        riskTier?: unknown
      }
      const result = (yield* mcp.add(ctx.payload.name, config as typeof ctx.payload.config)).status
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
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.startAuth(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authCallback = Effect.fn("McpHttpApi.authCallback")(function* (ctx: {
      params: { name: string }
      payload: typeof AuthCallbackPayload.Type
    }) {
      return yield* mcp
        .finishAuth(ctx.params.name, ctx.payload.code)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
    })

    const authAuthenticate = Effect.fn("McpHttpApi.authAuthenticate")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.authenticate(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authRemove = Effect.fn("McpHttpApi.authRemove")(function* (ctx: { params: { name: string } }) {
      const status = yield* mcp.status()
      if (!(ctx.params.name in status))
        return yield* new McpServerNotFoundError({
          name: ctx.params.name,
          message: `MCP server not found: ${ctx.params.name}`,
        })
      yield* mcp.removeAuth(ctx.params.name)
      return { success: true as const }
    })

    const connect = Effect.fn("McpHttpApi.connect")(function* (ctx: { params: { name: string } }) {
      yield* mcp
        .connect(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
      return true
    })

    const disconnect = Effect.fn("McpHttpApi.disconnect")(function* (ctx: { params: { name: string } }) {
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

    return handlers
      .handle("status", status)
      .handle("add", add)
      .handle("catalog", catalog)
      .handle("catalogEnable", catalogEnable)
      .handle("authStart", authStart)
      .handle("authCallback", authCallback)
      .handle("authAuthenticate", authAuthenticate)
      .handle("authRemove", authRemove)
      .handle("connect", connect)
      .handle("disconnect", disconnect)
  }),
)
