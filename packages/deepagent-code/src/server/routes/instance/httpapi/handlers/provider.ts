import { ProviderAuth } from "@/provider/auth"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@deepagent-code/core/models-dev"
import { Provider } from "@/provider/provider"
import { discoverWithProtocol, isChatModel, normalizeBaseURL } from "@/provider/model-discovery"

import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError, ProviderModelDiscoverError } from "../groups/provider"
import { ProviderV2 } from "@deepagent-code/core/provider"

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: {} })
    }),
  )
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const authSvc = yield* Auth.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      const all = yield* ModelsDev.Service.use((s) => s.get())
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered: Record<string, (typeof all)[string]> = {}
      for (const [key, value] of Object.entries(all)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filtered[key] = value
      }
      const connected = yield* provider.list()
      const providers = Object.assign(
        mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
        connected,
      )
      const configErrors = yield* cfg.getErrors()
      const providerErrors = yield* provider.errors()
      const errors = [...configErrors, ...providerErrors]
      return {
        all: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
        connected: Object.keys(connected),
        errors: errors.length ? errors : undefined,
      }
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const discover = Effect.fn("ProviderHttpApi.discover")(function* (ctx) {
      const providerID = ctx.payload.providerID.trim()
      let baseURL: string
      try {
        baseURL = normalizeBaseURL(ctx.payload.baseURL)
      } catch {
        return yield* Effect.fail(new ProviderModelDiscoverError({ message: "Invalid provider baseURL" }))
      }

      const apiKey = yield* Effect.gen(function* () {
        const inlineKey = ctx.payload.apiKey?.trim()
        if (inlineKey) return inlineKey
        const authID = ctx.payload.authProviderID?.trim() || providerID
        const stored = yield* authSvc.get(authID).pipe(Effect.orDie)
        if (stored?.type === "api") return stored.key
        return undefined
      })
      if (!apiKey) return yield* Effect.fail(new ProviderModelDiscoverError({ message: "Missing provider API key" }))

      // Honor an explicit kind; otherwise probe openai-compatible then anthropic and report which
      // protocol answered so the client persists the matching SDK npm.
      const result = yield* Effect.tryPromise({
        try: () =>
          discoverWithProtocol({
            providerID,
            baseURL,
            apiKey,
            kind: ctx.payload.kind,
            headers: ctx.payload.headers,
          }),
        catch: (error) =>
          new ProviderModelDiscoverError({ message: error instanceof Error ? error.message : String(error) }),
      })

      const models = result.models.filter((model) => isChatModel(model.id))
      const selectable = models.length ? models : result.models
      const requested = ctx.payload.modelID?.trim()
      const selected = requested
        ? (selectable.find((model) => model.id === requested) ?? { id: requested, name: requested })
        : selectable[0]

      return { providerID, baseURL, kind: result.kind, models: selectable, selected }
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        }),
      )
      return true
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handle("discover", discover)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
