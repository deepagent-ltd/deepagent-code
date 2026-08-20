import { Route, type RouteRoutedModelInput } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import * as OpenAIResponses from "./openai-responses"

const ADAPTER = "openai-compatible-responses"

export type OpenAICompatibleResponsesModelInput = RouteRoutedModelInput

/**
 * Route for non-OpenAI providers that expose an OpenAI Responses-compatible
 * `/responses` endpoint (e.g. DeepSeek). Reuses `OpenAIResponses.protocol`
 * end-to-end and overrides only the route id so providers can be resolved
 * per-family without colliding with native OpenAI.
 *
 * It intentionally does NOT reuse `OpenAIResponses.route`, which hardcodes
 * `provider: "openai"`; `Route.model` prefers the route-owned provider
 * (see route/client.ts `makeRouteModel`) and would mis-attribute a DeepSeek
 * model to OpenAI. Provider helpers configure the route endpoint and provider
 * before model selection.
 */
export const route = Route.make({
  id: ADAPTER,
  protocol: OpenAIResponses.protocol,
  endpoint: Endpoint.path("/responses"),
  framing: Framing.sse,
})

export * as OpenAICompatibleResponses from "./openai-compatible-responses"
