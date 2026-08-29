export * as SessionRunnerModel from "./model"

import { type Model } from "@deepagent-code/llm"
import * as AnthropicMessages from "@deepagent-code/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@deepagent-code/llm/protocols/openai-compatible-chat"
import { OpenAICompatibleResponses } from "@deepagent-code/llm/protocols"
import * as OpenAIResponses from "@deepagent-code/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@deepagent-code/llm/route"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { ModelProtocolDisabledReason } from "../../contract/model-protocol"
import { ModelV2 } from "../../model"
import { ModelRequest } from "../../model-request"
import { resolveModelProtocol } from "../../model-protocol"
import { PluginBoot } from "../../plugin/boot"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {}

/** A model whose protocol selection is explicitly disabled (unknown/conflict). */
export class ModelProtocolDisabledError extends Schema.TaggedErrorClass<ModelProtocolDisabledError>()(
  "SessionRunnerModel.ModelProtocolDisabledError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    protocol: Schema.String.pipe(Schema.optional),
    reason: ModelProtocolDisabledReason,
    selectionState: Schema.String,
  },
) {}

export type Error =
  | Catalog.ProviderNotFoundError
  | Catalog.ModelNotFoundError
  | ModelNotSelectedError
  | UnsupportedApiError
  | ModelProtocolDisabledError

/**
 * A resolved model plus the `ModelV2.Info`/`ProviderV2.Info` it was resolved
 * from. The runner needs the catalog `Info` (not just the lowered llm `Model`)
 * to bind the C2-04 protocol attempt identity (route/protocol/origin/
 * capability/lowering) onto the prepared attempt, per design §4.1 step 8 —
 * built only from the already-resolved config, never from a business-turn probe.
 * `info`/`provider` are optional so embedded resolvers that only lower a bare
 * llm `Model` (test stubs) leave the identity unbound rather than synthesizing one.
 */
export interface ResolvedModel {
  readonly model: Model
  readonly info?: ModelV2.Info
  readonly provider?: ProviderV2.Info
}

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<ResolvedModel, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

const apiKey = (model: ModelV2.Info, provider?: ProviderV2.Info) => {
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
  return provider?.enabled !== false && provider?.enabled.via === "env" ? Auth.config(provider.enabled.name) : undefined
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const options = model.request.options ?? {}
  const namespace = model.api.type === "aisdk" ? ModelRequest.namespace(model.api.package) : undefined
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    generation: model.request.generation,
    providerOptions: namespace && Object.keys(options).length > 0 ? { [namespace]: options } : undefined,
    http: { body: httpBody },
    limits: { context: model.limit.context, input: model.limit.input, output: model.limit.output },
  })
}

const withVariant = (model: ModelV2.Info, variantID: ModelV2.VariantID | undefined) => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant) return model
  return produce(model, (draft) => {
    ModelRequest.assign(draft.request, variant)
  })
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

const routeFor = (
  protocol: NonNullable<ReturnType<typeof resolveModelProtocol>["protocol"]>,
  model: ModelV2.Info,
  key: ReturnType<typeof apiKey> | undefined,
): Effect.Effect<Model, UnsupportedApiError> => {
  switch (protocol) {
    case "openai.responses":
      return Effect.succeed(
        withDefaults(model, OpenAIResponses.route)
          .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
          .model({ id: model.api.id }),
      )
    case "openai-compatible.responses":
      if (model.api.url === undefined) {
        return Effect.fail(new UnsupportedApiError({ providerID: model.providerID, modelID: model.id, api: apiName(model) }))
      }
      return Effect.succeed(
        withDefaults(model, OpenAICompatibleResponses.route)
          .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
          .model({ id: model.api.id }),
      )
    case "anthropic.messages":
      return Effect.succeed(
        withDefaults(model, AnthropicMessages.route)
          .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
          .model({ id: model.api.id }),
      )
    case "openai-compatible.chat":
      if (model.api.url === undefined) {
        return Effect.fail(new UnsupportedApiError({ providerID: model.providerID, modelID: model.id, api: apiName(model) }))
      }
      return Effect.succeed(
        withDefaults(model, OpenAICompatibleChat.route)
          .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
          .model({ id: model.api.id }),
      )
  }
  return Effect.fail(new UnsupportedApiError({ providerID: model.providerID, modelID: model.id, api: apiName(model) }))
}

/**
 * Select the route by the explicitly resolved protocol (design §5.2, C2-02).
 * Compatible models are no longer uniformly routed to Chat: a model that
 * resolves to `openai-compatible.responses` goes to the Responses adapter. A
 * disabled selection (unknown/conflict) is a typed error — never a silent
 * fallback to a guessed Chat route.
 */
export const fromCatalogModel = (
  model: ModelV2.Info,
  provider?: ProviderV2.Info,
): Effect.Effect<Model, ModelProtocolDisabledError | UnsupportedApiError> => {
  const selection = resolveModelProtocol(model, provider)
  if (!selection.protocol || selection.selectionState === "disabled") {
    return Effect.fail(
      new ModelProtocolDisabledError({
        providerID: model.providerID,
        modelID: model.id,
        protocol: model.api.protocol ?? provider?.api.protocol,
        reason: selection.disabledReason ?? "model_protocol_selection_required",
        selectionState: selection.selectionState,
      }),
    )
  }
  return routeFor(selection.protocol, model, apiKey(model, provider))
}

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, provider?: ProviderV2.Info) =>
  fromCatalogModel(withVariant(model, session.model?.variant), provider)

export const supported = (model: ModelV2.Info) => {
  const selection = resolveModelProtocol(model)
  if (selection.protocol === null || selection.selectionState === "disabled") return false
  if (selection.protocol === "openai-compatible.chat" || selection.protocol === "openai-compatible.responses") {
    return model.api.url !== undefined
  }
  return true
}

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const boot = yield* PluginBoot.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        yield* boot.wait()
        const selected = session.model
          ? yield* catalog.model.get(session.model.providerID, session.model.id)
          : (Option.getOrUndefined((yield* catalog.model.default()).pipe(Option.filter(supported))) ??
            (yield* catalog.model.available()).find(supported))
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        const provider = yield* catalog.provider.get(selected.providerID)
        return { model: yield* resolve(session, selected, provider), info: selected, provider }
      }),
    })
  }),
)
