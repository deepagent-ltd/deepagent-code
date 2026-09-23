import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProxyAuthorization } from "../middleware/proxy-authorization"

const Model = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("model"),
  created: Schema.Int,
  owned_by: Schema.String,
})

export const GatewayHttpApi = HttpApi.make("deepagent-code-gateway").add(
  HttpApiGroup.make("gateway")
    .add(
      HttpApiEndpoint.get("models", "/v1/models", {
        success: Schema.Struct({ object: Schema.Literal("list"), data: Schema.Array(Model) }),
      }).annotateMerge(OpenApi.annotations({ summary: "List proxy tenant models" })),
    )
    .add(
      HttpApiEndpoint.post("chat", "/v1/chat/completions", {
        payload: Schema.Unknown,
        success: Schema.Unknown,
      }).annotateMerge(OpenApi.annotations({ summary: "Create a proxy chat completion" })),
    )
    .add(
      HttpApiEndpoint.post("responses", "/v1/responses", {
        payload: Schema.Unknown,
        success: Schema.Unknown,
      }).annotateMerge(OpenApi.annotations({ summary: "Create a text-only proxy response" })),
    )
    .middleware(ProxyAuthorization),
)
