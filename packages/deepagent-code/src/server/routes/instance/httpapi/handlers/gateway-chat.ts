import { createHash, randomUUID } from "node:crypto"
import { and, eq, gte, sql } from "drizzle-orm"
import { Cause, Effect, Option, Ref, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { LLMResponse } from "@deepagent-code/llm"
import { LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentRateLimitBucketTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { ModelsDev } from "@deepagent-code/core/models-dev"
import { ProxyRequestLedgerTable } from "@deepagent-code/core/proxy/sql"
import { RequestAdmitted, ResponseCompleted } from "@deepagent-code/core/proxy/event"
import { Auth } from "@/auth"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { LLMNative } from "@/session/llm/native-request"
import { parseChatPayload } from "../groups/gateway-wire"
import { ProxyTenantContext, proxyError } from "../middleware/proxy-authorization"

class QuotaExceeded extends Error {
  constructor(readonly kind: "requests" | "tokens") {
    super("Proxy quota exceeded")
  }
}

export const chat = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const store = yield* InstanceStore.Service
  const provider = yield* Provider.Service
  const auth = yield* Auth.Service
  const client = yield* LLMClient.Service
  const events = yield* EventV2Bridge.Service
  const modelsDev = yield* ModelsDev.Service

  return (input: { request: HttpServerRequest.HttpServerRequest }) =>
    Effect.gen(function* () {
      const body = yield* input.request.text.pipe(Effect.catch(() => Effect.succeed("")))
      const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body)
      const parsed = parseChatPayload(Option.isSome(decoded) ? decoded.value : undefined)
      if (!parsed.ok) return parsed.response
      const tenant = yield* ProxyTenantContext
      if (tenant.tier !== "passthrough")
        return proxyError(501, "enhancement_unavailable", "Enhanced proxy tier is not available")

      const requestID = input.request.headers["x-request-id"] || `req_${randomUUID()}`
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestID))
        return proxyError(400, "invalid_request_id", "Invalid X-Request-ID")
      const ledgerID = `${tenant.id}:${requestID}`
      const requestHash = createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex")
      const existing = yield* db
        .select({ request_hash: ProxyRequestLedgerTable.request_hash })
        .from(ProxyRequestLedgerTable)
        .where(eq(ProxyRequestLedgerTable.request_id, ledgerID))
        .get()
      if (existing)
        return proxyError(
          409,
          existing.request_hash === requestHash ? "request_replay_unavailable" : "request_conflict",
          "A request with this ID was already admitted",
        )

      const instance = yield* store.load({ directory: tenant.directory })
      const catalog = yield* provider.list().pipe(Effect.provideService(InstanceRef, instance))
      const candidates = Object.values(catalog).flatMap((entry) =>
        Object.values(entry.models)
          .filter(
            (model) =>
              tenant.model_allowlist.includes(`${entry.id}/${model.id}`) &&
              (parsed.value.model === model.id || parsed.value.model === `${entry.id}/${model.id}`),
          )
          .map((model) => ({ entry, model })),
      )
      if (candidates.length !== 1) return proxyError(404, "model_not_found", "Model is not available")
      const selected = candidates[0]!
      const credential = yield* auth.get(selected.entry.id)
      const options = { ...selected.entry.options, ...selected.model.options }
      const apiKey =
        credential?.type === "api"
          ? credential.key
          : typeof options.apiKey === "string"
            ? options.apiKey
            : selected.entry.key
      if (!apiKey || credential?.type === "oauth")
        return proxyError(501, "provider_not_supported", "Model transport is not available")
      const baseURL = typeof options.baseURL === "string" ? options.baseURL : undefined

      const admittedAt = Date.now()
      const eventData = {
        requestID: ledgerID,
        tenantID: tenant.id,
        tier: tenant.tier,
        providerID: String(selected.entry.id),
        modelID: String(selected.model.id),
      }
      const admission = yield* events
        .publish(
          RequestAdmitted,
          { ...eventData, admittedAt, stream: parsed.value.stream ?? false },
          {
            commit: () =>
              Effect.gen(function* () {
                const windowStart = Math.floor(admittedAt / 60_000) * 60_000
                const bucketID = `proxy:${tenant.id}:requests`
                const bucket = yield* db
                  .select()
                  .from(DeepAgentRateLimitBucketTable)
                  .where(
                    and(
                      eq(DeepAgentRateLimitBucketTable.workspace_id, bucketID),
                      eq(DeepAgentRateLimitBucketTable.window_start, windowStart),
                    ),
                  )
                  .get()
                if (tenant.quota_requests_per_minute <= 0 || (bucket && bucket.count >= tenant.quota_requests_per_minute))
                  return yield* Effect.fail(new QuotaExceeded("requests"))
                const spent = yield* db
                  .select({
                    tokens: sql<number>`coalesce(sum(coalesce(${ProxyRequestLedgerTable.usage_input}, 0) + coalesce(${ProxyRequestLedgerTable.usage_output}, 0)), 0)`,
                  })
                  .from(ProxyRequestLedgerTable)
                  .where(
                    and(
                      eq(ProxyRequestLedgerTable.tenant_id, tenant.id),
                      gte(ProxyRequestLedgerTable.admitted_at, Math.floor(admittedAt / 86_400_000) * 86_400_000),
                    ),
                  )
                  .get()
                if (tenant.quota_tokens_per_day <= 0 || (spent?.tokens ?? 0) >= tenant.quota_tokens_per_day)
                  return yield* Effect.fail(new QuotaExceeded("tokens"))
                yield* db
                  .insert(DeepAgentRateLimitBucketTable)
                  .values({ workspace_id: bucketID, window_start: windowStart, count: (bucket?.count ?? 0) + 1 })
                  .onConflictDoUpdate({
                    target: [DeepAgentRateLimitBucketTable.workspace_id, DeepAgentRateLimitBucketTable.window_start],
                    set: { count: (bucket?.count ?? 0) + 1 },
                  })
                yield* db.insert(ProxyRequestLedgerTable).values({
                  request_id: ledgerID,
                  request_hash: requestHash,
                  tenant_id: tenant.id,
                  tier: tenant.tier,
                  provider_id: String(selected.entry.id),
                  model_id: String(selected.model.id),
                  admitted_at: admittedAt,
                  stream: parsed.value.stream ?? false,
                })
              }),
          },
        )
        .pipe(
          Effect.as({ status: "admitted" as const }),
          Effect.catchCause((cause) => {
            const failure = cause.reasons.find(
              (reason) => Cause.isDieReason(reason) && reason.defect instanceof QuotaExceeded,
            )
            return Effect.succeed(
              failure && Cause.isDieReason(failure) && failure.defect instanceof QuotaExceeded
                ? { status: "quota" as const, kind: failure.defect.kind }
                : { status: "unavailable" as const },
            )
          }),
        )
      if (admission.status === "quota") {
        const quota = admission.kind === "requests" ? tenant.quota_requests_per_minute : tenant.quota_tokens_per_day
        const reset =
          admission.kind === "requests"
            ? Math.ceil((Math.floor(admittedAt / 60_000) * 60_000 + 60_000 - admittedAt) / 1000)
            : Math.ceil((Math.floor(admittedAt / 86_400_000) * 86_400_000 + 86_400_000 - admittedAt) / 1000)
        return HttpServerResponse.setHeader(
          HttpServerResponse.setHeader(
            HttpServerResponse.setHeader(
              HttpServerResponse.setHeader(proxyError(429, "rate_limit_exceeded", "Proxy quota exceeded"), "x-request-id", requestID),
              `x-ratelimit-limit-${admission.kind}`,
              String(quota),
            ),
            `x-ratelimit-remaining-${admission.kind}`,
            "0",
          ),
          `x-ratelimit-reset-${admission.kind}`,
          String(reset),
        )
      }
      if (admission.status !== "admitted") return proxyError(503, "gateway_unavailable", "Gateway is unavailable")

      const complete = (output: {
        finishReason: string
        usage?: ReturnType<typeof LLMResponse.usage>
        cost: number | null
        firstTokenAt?: number
      }) => {
        const completedAt = Date.now()
        return events.publish(
          ResponseCompleted,
          {
            ...eventData,
            completedAt,
            finishReason: output.finishReason,
            usageInput: output.usage?.inputTokens,
            usageOutput: output.usage?.outputTokens,
            usageReasoning: output.usage?.reasoningTokens,
            usageCacheRead: output.usage?.cacheReadInputTokens,
            usageCacheWrite: output.usage?.cacheWriteInputTokens,
            usageSource: output.usage ? "provider" : undefined,
          },
          {
            commit: () =>
              db
                .update(ProxyRequestLedgerTable)
                .set({
                  usage_input: output.usage?.inputTokens,
                  usage_output: output.usage?.outputTokens,
                  usage_reasoning: output.usage?.reasoningTokens,
                  usage_cache_read: output.usage?.cacheReadInputTokens,
                  usage_cache_write: output.usage?.cacheWriteInputTokens,
                  usage_source: output.usage ? "provider" : undefined,
                  cost_total: output.cost,
                  finish_reason: output.finishReason,
                  first_token_at: output.firstTokenAt,
                  completed_at: completedAt,
                })
                .where(eq(ProxyRequestLedgerTable.request_id, ledgerID))
                .run()
                .pipe(Effect.asVoid),
          },
        )
      }

      const modelCost = (yield* modelsDev.get())[selected.entry.id]?.models[selected.model.id]?.cost
      const costFor = (usage: ReturnType<typeof LLMResponse.usage>) =>
        modelCost && usage?.inputTokens !== undefined && usage.outputTokens !== undefined
          ? ((usage.nonCachedInputTokens ?? usage.inputTokens) * modelCost.input +
              (usage.cacheReadInputTokens ?? 0) * (modelCost.cache_read ?? modelCost.input) +
              (usage.cacheWriteInputTokens ?? 0) * (modelCost.cache_write ?? modelCost.input) +
              usage.outputTokens * modelCost.output) /
            1_000_000
          : null

      const request = LLMNative.request({
        model: selected.model,
        apiKey,
        baseURL,
        messages: parsed.value.messages.map((message) => ({ role: message.role, content: message.content })),
        temperature: parsed.value.temperature,
        topP: parsed.value.top_p,
        maxOutputTokens: parsed.value.max_completion_tokens ?? parsed.value.max_tokens,
      })
      if (parsed.value.stream) {
        const state = yield* Ref.make({
          usage: undefined as ReturnType<typeof LLMResponse.usage>,
          finishReason: "stop",
          firstTokenAt: undefined as number | undefined,
        })
        const chunk = (choices: unknown[], usage?: unknown) =>
          `data: ${JSON.stringify({
            id: `chatcmpl-${requestID}`,
            object: "chat.completion.chunk",
            created: Math.floor(admittedAt / 1000),
            model: parsed.value.model,
            choices,
            ...(usage ? { usage } : {}),
          })}\n\n`
        const providerStream = client.stream(request).pipe(
          Stream.provideService(RequestExecutor.CurrentRetryLimit, 0),
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              if ("usage" in event && event.usage) yield* Ref.update(state, (current) => ({ ...current, usage: event.usage }))
              if (event.type === "finish") yield* Ref.update(state, (current) => ({ ...current, finishReason: event.reason }))
              if (event.type !== "text-delta") return ""
              yield* Ref.update(state, (current) => ({ ...current, firstTokenAt: current.firstTokenAt ?? Date.now() }))
              return chunk([{ index: 0, delta: { content: event.text }, finish_reason: null }])
            }),
          ),
          Stream.filter((value) => value.length > 0),
          Stream.concat(
            Stream.fromEffect(
              Effect.gen(function* () {
                const final = yield* Ref.get(state)
                yield* complete({
                  finishReason: final.finishReason,
                  usage: final.usage,
                  cost: costFor(final.usage),
                  firstTokenAt: final.firstTokenAt,
                })
                return (
                  chunk([{ index: 0, delta: {}, finish_reason: final.finishReason }]) +
                  (parsed.value.stream_options?.include_usage && final.usage?.inputTokens !== undefined && final.usage.outputTokens !== undefined
                    ? chunk([], {
                        prompt_tokens: final.usage.inputTokens,
                        completion_tokens: final.usage.outputTokens,
                        total_tokens: final.usage.totalTokens ?? final.usage.inputTokens + final.usage.outputTokens,
                      })
                    : "") +
                  "data: [DONE]\n\n"
                )
              }),
            ),
          ),
          Stream.catchCause(() =>
            Stream.fromEffect(complete({ finishReason: "error", cost: null })).pipe(
              Stream.map(() => `data: ${JSON.stringify({ error: { message: "Model provider failed", type: "api_error", code: "provider_error" } })}\n\n`),
            ),
          ),
        )
        return HttpServerResponse.stream(
          Stream.make(chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }])).pipe(
            Stream.concat(providerStream),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: {
              "cache-control": "no-cache, no-transform",
              "x-accel-buffering": "no",
              "x-request-id": requestID,
            },
          },
        )
      }

      // Passthrough is a zero-session, non-execution path: one provider HTTP exchange through
      // the existing Route/Endpoint/Framing client. Never project a synthetic Session history.
      const result = yield* client
        .generate(request)
        .pipe(
          Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
          Effect.match({ onFailure: (error) => ({ error }), onSuccess: (response) => ({ response }) }),
        )
      if ("error" in result) {
        yield* complete({ finishReason: "error", cost: null })
        const reason = result.error.reason
        const http = "http" in reason ? reason.http : undefined
        const status = http?.response?.status
        const body = http?.body
        if (status && body && !http?.bodyTruncated) {
          return HttpServerResponse.text(body, {
            status,
            contentType: "application/json",
            headers: { "x-request-id": requestID, "cache-control": "no-store" },
          })
        }
        return proxyError(status ?? 502, "provider_error", "Model provider failed")
      }

      const response = result.response
      const usage = LLMResponse.usage(response)
      const finish = response.events.findLast((event) => event.type === "finish" || event.type === "step-finish")
      const finishReason = finish && "reason" in finish ? finish.reason : "stop"
      yield* complete({ finishReason, usage, cost: costFor(usage) })
      return HttpServerResponse.jsonUnsafe(
        {
          id: `chatcmpl-${requestID}`,
          object: "chat.completion",
          created: Math.floor(admittedAt / 1000),
          model: parsed.value.model,
          choices: [{ index: 0, message: { role: "assistant", content: response.text }, finish_reason: finishReason }],
          usage:
            usage?.inputTokens !== undefined && usage.outputTokens !== undefined
              ? {
                  prompt_tokens: usage.inputTokens,
                  completion_tokens: usage.outputTokens,
                  total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
                  prompt_tokens_details: {
                    cached_tokens: usage.cacheReadInputTokens ?? 0,
                  },
                  completion_tokens_details: {
                    reasoning_tokens: usage.reasoningTokens ?? 0,
                  },
                }
              : null,
        },
        { headers: { "x-request-id": requestID, "cache-control": "no-store" } },
      )
    }).pipe(Effect.catchCause(() => Effect.succeed(proxyError(503, "gateway_unavailable", "Gateway is unavailable"))))
})
