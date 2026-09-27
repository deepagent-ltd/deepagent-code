import { Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { GatewayHttpApi } from "../groups/gateway"
import { parseResponsesPayload } from "../groups/gateway-wire"
import { ProxyTenantContext } from "../middleware/proxy-authorization"
import { proxyError } from "../middleware/proxy-authorization"
import { chat } from "./gateway-chat"

export const gatewayHandlers = HttpApiBuilder.group(GatewayHttpApi, "gateway", (handlers) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const provider = yield* Provider.Service
    const chatHandler = yield* chat

    return handlers.handle("models", () =>
      Effect.gen(function* () {
        const tenant = yield* ProxyTenantContext
        const instance = yield* store.load({ directory: tenant.directory })
        const catalog = yield* provider.list().pipe(Effect.provideService(InstanceRef, instance))
        return {
          object: "list" as const,
          data: Object.values(catalog)
            .flatMap((entry) =>
              Object.values(entry.models)
                .filter((model) => tenant.model_allowlist.includes(`${entry.id}/${model.id}`))
                .map((model) => ({
                  id: model.id,
                  object: "model" as const,
                  created: Math.floor(Date.parse(model.release_date) / 1000) || 0,
                  owned_by: entry.id,
                })),
            )
            .sort((a, b) => a.id.localeCompare(b.id)),
        }
      }),
    ).handleRaw("chat", chatHandler).handleRaw("responses", (input: { request: HttpServerRequest.HttpServerRequest }) =>
      Effect.gen(function* () {
        const body = yield* input.request.text.pipe(Effect.catch(() => Effect.succeed("")))
        const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body)
        const parsed = parseResponsesPayload(Option.isSome(decoded) ? decoded.value : undefined)
        if (!parsed.ok) return parsed.response
        const request = HttpServerRequest.fromWeb(new Request(new URL("/v1/chat/completions", "http://localhost"), {
          method: "POST",
          headers: { ...input.request.headers, "content-type": "application/json" },
          body: JSON.stringify(parsed.value),
        }))
        const completion = yield* chatHandler({ request })
        if (completion.status !== 200) return completion
        const payload = (yield* Effect.tryPromise(() => HttpServerResponse.toWeb(completion).json())
          .pipe(Effect.catch(() => Effect.succeed(null)))) as {
            id: string
            created: number
            model: string
            choices: { message: { content: string }; finish_reason: string }[]
            usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null
          } | null
        const text = payload?.choices[0]?.message.content
        if (!payload || typeof text !== "string") return proxyError(502, "response_mapping_failed", "Model response could not be mapped")
        return HttpServerResponse.jsonUnsafe({
          id: `resp_${payload.id}`,
          object: "response",
          created_at: payload.created,
          status: "completed",
          model: payload.model,
          output: [{ id: `msg_${payload.id}`, type: "message", status: "completed", role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }] }],
          output_text: text,
          usage: payload.usage ? { input_tokens: payload.usage.prompt_tokens,
            output_tokens: payload.usage.completion_tokens, total_tokens: payload.usage.total_tokens } : null,
          error: null,
          incomplete_details: null,
        }, { headers: { "x-request-id": completion.headers["x-request-id"] ?? "", "cache-control": "no-store" } })
      }),
    )
  }),
)
