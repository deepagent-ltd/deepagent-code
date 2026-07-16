import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ProviderV2 } from "@deepagent-code/core/provider"

const root = "/provider"

const ProviderAuthErrorName = Schema.Union([
  Schema.Literal("BadRequest"),
  Schema.Literal("ProviderAuthOauthMissing"),
  Schema.Literal("ProviderAuthOauthCodeMissing"),
  Schema.Literal("ProviderAuthOauthCallbackFailed"),
  Schema.Literal("ProviderAuthValidationFailed"),
])
export class ProviderAuthApiError extends Schema.ErrorClass<ProviderAuthApiError>("ProviderAuthError")(
  {
    name: ProviderAuthErrorName,
    data: Schema.Struct({
      providerID: Schema.optional(ProviderV2.ID),
      field: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ProviderModelDiscoverError extends Schema.ErrorClass<ProviderModelDiscoverError>(
  "ProviderModelDiscoverError",
)(
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export const ProviderModelDiscoverInput = Schema.Struct({
  providerID: Schema.String,
  baseURL: Schema.String,
  apiKey: Schema.optional(Schema.String),
  authProviderID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literals(["openai-compatible", "anthropic"])),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export const ProviderDiscoveredModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

export const ProviderModelDiscoverResult = Schema.Struct({
  providerID: Schema.String,
  baseURL: Schema.String,
  // The protocol that actually answered discovery. When the client omits `kind`, the server probes
  // openai-compatible then anthropic and reports whichever succeeded so the client can persist the
  // matching SDK npm.
  kind: Schema.Literals(["openai-compatible", "anthropic"]),
  models: Schema.Array(ProviderDiscoveredModel),
  selected: ProviderDiscoveredModel,
})

export const ProviderApi = HttpApi.make("provider")
  .add(
    HttpApiGroup.make("provider")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ListResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.list",
            summary: "List providers",
            description: "Get a list of all available AI providers, including both available and connected ones.",
          }),
        ),
        HttpApiEndpoint.get("auth", `${root}/auth`, {
          query: WorkspaceRoutingQuery,
          success: described(ProviderAuth.Methods, "Provider auth methods"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.auth",
            summary: "Get provider auth methods",
            description: "Retrieve available authentication methods for all AI providers.",
          }),
        ),
        HttpApiEndpoint.post("discover", `${root}/models/discover`, {
          query: WorkspaceRoutingQuery,
          payload: ProviderModelDiscoverInput,
          success: described(ProviderModelDiscoverResult, "Discovered provider models"),
          error: ProviderModelDiscoverError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.models.discover",
            summary: "Discover provider models",
            description: "Probe a provider /models endpoint and return discovered chat models.",
          }),
        ),
        HttpApiEndpoint.post("authorize", `${root}/:providerID/oauth/authorize`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderAuth.AuthorizeInput,
          success: described(Schema.UndefinedOr(ProviderAuth.Authorization), "Authorization URL and method"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.authorize",
            summary: "Start OAuth authorization",
            description: "Start the OAuth authorization flow for a provider.",
          }),
        ),
        HttpApiEndpoint.post("callback", `${root}/:providerID/oauth/callback`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderAuth.CallbackInput,
          success: described(Schema.Boolean, "OAuth callback processed successfully"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.callback",
            summary: "Handle OAuth callback",
            description: "Handle the OAuth callback from a provider after user authorization.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "provider",
          description: "Experimental HttpApi provider routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "deepagent-code experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
