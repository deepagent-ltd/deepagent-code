import { Attention } from "@deepagent-code/core/attention"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "../errors"
import { AttentionNotFoundError } from "../groups/attention"

// A fresh handler layer per listener keeps its host profile out of a shared memoMap.
export const createAttentionHandler = () =>
  HttpApiBuilder.group(Api, "server.attention", (handlers) =>
    Effect.gen(function* () {
      const attention = yield* Attention.Service
      const checkScope = Effect.fn("AttentionHttp.scope")(function* (workspace?: string) {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (
          workspace !== undefined ||
          new URL(request.url, "http://localhost").searchParams.has("location[workspace]") ||
          request.headers["x-deepagent-code-workspace"] !== undefined
        )
          return yield* new InvalidRequestError({
            message: "Attention supports implicit-local scope only",
            field: "workspace",
          })
      })
      const map = {
        "Attention.Unavailable": (error: Attention.Unavailable) =>
          new ServiceUnavailableError({ service: "attention", message: error.reason }),
        "Attention.NotFound": () => new AttentionNotFoundError({ message: "Attention item not found" }),
        "Attention.Stale": () =>
          new ConflictError({ message: "Attention item changed; refresh before marking it viewed" }),
        "Attention.Invalid": (error: Attention.Invalid) =>
          new InvalidRequestError({ message: `Invalid attention ${error.field}`, field: error.field }),
      }
      return handlers
        .handle("attention.capability", (ctx) => checkScope(ctx.query.workspace).pipe(Effect.as(attention.capability)))
        .handle("attention.list", (ctx) =>
          checkScope(ctx.query.workspace).pipe(
            Effect.andThen(attention.list(ctx.query)),
            Effect.catchTags({
              "Attention.Unavailable": (error) => Effect.fail(map["Attention.Unavailable"](error)),
              "Attention.Invalid": (error) => Effect.fail(map["Attention.Invalid"](error)),
            }),
          ),
        )
        .handle("attention.get", (ctx) =>
          checkScope(ctx.query.workspace).pipe(
            Effect.andThen(attention.get(ctx.params.itemID)),
            Effect.map((data) => ({ data })),
            Effect.catchTags({
              "Attention.Unavailable": (error) => Effect.fail(map["Attention.Unavailable"](error)),
              "Attention.NotFound": () => Effect.fail(map["Attention.NotFound"]()),
            }),
          ),
        )
        .handle("attention.seen", (ctx) =>
          checkScope(ctx.query.workspace).pipe(
            Effect.andThen(attention.seen(ctx.params.itemID, ctx.payload.revision)),
            Effect.map((data) => ({ data })),
            Effect.catchTags({
              "Attention.Unavailable": (error) => Effect.fail(map["Attention.Unavailable"](error)),
              "Attention.NotFound": () => Effect.fail(map["Attention.NotFound"]()),
              "Attention.Stale": () => Effect.fail(map["Attention.Stale"]()),
            }),
          ),
        )
    }),
  )
