import { ProviderAuth } from "@/provider/auth"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { ModelsDev } from "@deepagent-code/core/models-dev"
import { Provider } from "@/provider/provider"
import { discoverProviderModels, discoverWithProtocol, isChatModel, normalizeBaseURL } from "@/provider/model-discovery"
import { discoverModelsCached } from "@/provider/discovery-cache"
import { buildCatalogIndex, projectSpec, specMatchFor } from "@/provider/catalog-spec"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"

import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError, ProviderModelDiscoverError, ProviderModelRefreshError } from "../groups/provider"
import { OFFICIAL_PROVIDER_ID_SET, ProviderV2 } from "@deepagent-code/core/provider"

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
    const env = yield* Env.Service
    const modelsDev = yield* ModelsDev.Service
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service

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
      const chatModels = models.length ? models : result.models

      // Attach best-effort catalog specs (context/reasoning/…) matched by model id, cross-provider, so
      // the dialog can preview and pre-fill the editable spec fields. Undefined when there's no match.
      const catalog = yield* ModelsDev.Service.use((s) => s.get())
      const catalogIndex = buildCatalogIndex(catalog)
      const selectable = chatModels.map((model) => {
        const match = specMatchFor(model.id, model.id, catalogIndex)
        return match ? { ...model, spec: projectSpec(match) } : model
      })

      const requested = ctx.payload.modelID?.trim()
      const selected = requested
        ? (selectable.find((model) => model.id === requested) ?? { id: requested, name: requested })
        : selectable[0]

      return { providerID, baseURL, kind: result.kind, models: selectable, selected }
    })

    const refreshModels = Effect.fn("ProviderHttpApi.refreshModels")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      const providerID = ctx.params.providerID
      if (OFFICIAL_PROVIDER_ID_SET.has(providerID)) {
        yield* modelsDev.refresh(true)
        yield* provider.reload()
        const refreshed = yield* provider.getProvider(providerID)
        if (refreshed) return Provider.toPublicInfo(refreshed)
        return yield* new ProviderModelRefreshError({ message: `Provider not found: ${providerID}` })
      }

      const item = (yield* cfg.get()).provider?.[providerID]
      const catalog = yield* modelsDev.get()
      const legacyDiscovery =
        item?.npm === undefined &&
        typeof item?.options?.baseURL === "string" &&
        Object.keys(item.models ?? {}).length > 0 &&
        catalog[providerID] !== undefined
      if (!item || (!item.discovery && !legacyDiscovery)) {
        return yield* new ProviderModelRefreshError({
          message: `Provider ${providerID} does not have runtime model discovery enabled`,
        })
      }

      const baseURL = item.options?.baseURL
      if (typeof baseURL !== "string" || !baseURL.trim()) {
        return yield* new ProviderModelRefreshError({ message: `Provider ${providerID} is missing a base URL` })
      }

      const envs = yield* env.all()
      const apiKey =
        typeof item.options?.apiKey === "string"
          ? item.options.apiKey
          : item.env?.map((key) => envs[key]).find((value): value is string => typeof value === "string" && !!value)
      const headers =
        item.options?.headers && typeof item.options.headers === "object"
          ? Object.fromEntries(
              Object.entries(item.options.headers).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : undefined
      if (!apiKey && !headers) {
        return yield* new ProviderModelRefreshError({
          message: `Provider ${providerID} is missing discovery credentials`,
        })
      }

      const kind = (item.npm ?? catalog[providerID]?.npm) === "@ai-sdk/anthropic" ? "anthropic" : "openai-compatible"
      const input = { providerID, baseURL, apiKey, kind, headers } as const
      const discovered = yield* Effect.tryPromise({
        try: () => discoverProviderModels(input),
        catch: (error) =>
          new ProviderModelRefreshError({ message: error instanceof Error ? error.message : String(error) }),
      })
      const models = yield* discoverModelsCached(fs, flock, input, () => Promise.resolve(discovered), true)
      if (!models.length) {
        return yield* new ProviderModelRefreshError({ message: `Provider ${providerID} returned no chat models` })
      }

      yield* provider.reload()
      const refreshed = yield* provider.getProvider(providerID)
      if (refreshed) return Provider.toPublicInfo(refreshed)
      return yield* new ProviderModelRefreshError({ message: `Provider not found after refresh: ${providerID}` })
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
      .handle("refreshModels", refreshModels)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
