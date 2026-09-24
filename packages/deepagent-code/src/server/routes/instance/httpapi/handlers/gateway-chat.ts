import { createHash, randomUUID } from "node:crypto"
import { and, eq, gte, sql } from "drizzle-orm"
import { Cause, Effect, Option, Queue, Ref, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { LLMResponse } from "@deepagent-code/llm"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { DeepAgentRateLimitBucketTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { ProxyRequestLedgerTable } from "@deepagent-code/core/proxy/sql"
import { MechanismTraced, RequestAdmitted, ResponseCompleted } from "@deepagent-code/core/proxy/event"
import { InstanceRef } from "@/effect/instance-ref"
import { gatewayServiceTags } from "@/effect/gateway-service-tags"
import { LLMNative } from "@/session/llm/native-request"
import { parseChatPayload } from "../groups/gateway-wire"
import { collectEnhanced, proxyLaneID } from "./gateway-enhanced"
import { ProxyTenantContext, proxyError } from "../middleware/proxy-authorization"

class QuotaExceeded extends Error {
  constructor(readonly kind: "requests" | "tokens") {
    super("Proxy quota exceeded")
  }
}

class QuotaPending extends Error {}
class QuotaUsageUnknown extends Error {}

export const chat = Effect.gen(function* () {
  const services = yield* Effect.all(gatewayServiceTags)
  const db = services.database.db
  const store = services.store
  const provider = services.provider
  const auth = services.auth
  const client = services.client
  const events = services.events
  const modelsDev = services.modelsDev
  const sessions = services.sessions
  const scope = yield* Effect.scope

  return (input: { request: HttpServerRequest.HttpServerRequest }) =>
    Effect.gen(function* () {
      const body = yield* input.request.text.pipe(Effect.catch(() => Effect.succeed("")))
      const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body)
      const parsed = parseChatPayload(Option.isSome(decoded) ? decoded.value : undefined)
      if (!parsed.ok) return parsed.response
      const tenant = yield* ProxyTenantContext
      if (tenant.tier === "full" && !tenant.permission_policy?.length)
        return proxyError(503, "permission_policy_required", "Full proxy tier requires a permission policy", "deepagent_enhancement_error")
      if (tenant.tier !== "passthrough" && parsed.value.messages.at(-1)?.role !== "user")
        return proxyError(400, "invalid_request", "Enhanced chat requires a final user message")

      const requestID = input.request.headers["x-request-id"] || `req_${randomUUID()}`
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestID))
        return proxyError(400, "invalid_request_id", "Invalid X-Request-ID")
      const ledgerID = `${tenant.id}:${requestID}`
      const requestHash = createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex")
      const existing = yield* db
        .select({ request_hash: ProxyRequestLedgerTable.request_hash, completed_at: ProxyRequestLedgerTable.completed_at,
          finish_reason: ProxyRequestLedgerTable.finish_reason, tier: ProxyRequestLedgerTable.tier,
          provider_id: ProxyRequestLedgerTable.provider_id, model_id: ProxyRequestLedgerTable.model_id,
          lane_session_id: ProxyRequestLedgerTable.lane_session_id, admitted_at: ProxyRequestLedgerTable.admitted_at })
        .from(ProxyRequestLedgerTable)
        .where(eq(ProxyRequestLedgerTable.request_id, ledgerID))
        .get()
      const exactReplay = !!existing && existing.request_hash === requestHash && tenant.tier !== "passthrough"
      if (existing && !exactReplay)
        return proxyError(
          409,
          existing.request_hash === requestHash ? "request_replay_unavailable" : "request_conflict",
          "A request with this ID was already admitted",
        )
      if (exactReplay && existing?.completed_at && existing.finish_reason?.startsWith("enhancement_"))
        return proxyError(existing.finish_reason === "enhancement_timeout" ? 504 : 502,
          existing.finish_reason, "Previously admitted enhanced request failed", "deepagent_enhancement_error")

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
      const hint = input.request.headers["x-deepagent-session"] ?? parsed.value.user ?? "default"
      if (tenant.tier !== "passthrough" && (hint.length > 128 || hint.length === 0))
        return proxyError(400, "invalid_session_hint", "Invalid session hint")
      const laneSessionID = tenant.tier === "passthrough" ? undefined : proxyLaneID(tenant, hint)
      // An exact body retry must retain its original execution lane and provider binding. The
      // session hint is a header, and tenant settings can change after admission; neither is in
      // requestHash. Refuse before collectEnhanced can create or archive a different lane.
      if (exactReplay && (existing?.tier !== tenant.tier ||
          existing?.provider_id !== String(selected.entry.id) || existing?.model_id !== String(selected.model.id) ||
          existing?.lane_session_id !== laneSessionID))
        return proxyError(409, "request_replay_unavailable", "Request execution binding changed since admission")
      const credential = laneSessionID ? undefined : yield* auth.get(selected.entry.id)
      const options = { ...selected.entry.options, ...selected.model.options }
      const apiKey = credential?.type === "api" ? credential.key : typeof options.apiKey === "string" ? options.apiKey : selected.entry.key
      if (!laneSessionID && (!apiKey || credential?.type === "oauth"))
        return proxyError(501, "provider_not_supported", "Model transport is not available")

      const eventData = {
        requestID: ledgerID,
        tenantID: tenant.id,
        tier: tenant.tier,
        providerID: String(selected.entry.id),
        modelID: String(selected.model.id),
        ...(laneSessionID ? { laneSessionID } : {}),
      }
      const admitOnce = (admittedAt: number) => events
        .publishChecked(
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
                    pending: sql<number>`coalesce(sum(CASE WHEN ${ProxyRequestLedgerTable.completed_at} IS NULL THEN 1 ELSE 0 END), 0)`,
                    unknown: sql<number>`coalesce(sum(CASE WHEN ${ProxyRequestLedgerTable.completed_at} IS NOT NULL AND (${ProxyRequestLedgerTable.usage_input} IS NULL OR ${ProxyRequestLedgerTable.usage_output} IS NULL) THEN 1 ELSE 0 END), 0)`,
                  })
                  .from(ProxyRequestLedgerTable)
                  .where(
                    and(
                      eq(ProxyRequestLedgerTable.tenant_id, tenant.id),
                      gte(ProxyRequestLedgerTable.admitted_at, Math.floor(admittedAt / 86_400_000) * 86_400_000),
                    ),
                  )
                  .get()
                // A tenant's next request waits for an earlier provider exchange to settle. This
                // makes the durable usage total authoritative at admission without guessing a
                // future provider's tokens; a missing usage report blocks further admission.
                if ((spent?.pending ?? 0) > 0) return yield* Effect.fail(new QuotaPending())
                if ((spent?.unknown ?? 0) > 0) return yield* Effect.fail(new QuotaUsageUnknown())
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
                  lane_session_id: laneSessionID,
                  admitted_at: admittedAt,
                  stream: parsed.value.stream ?? false,
                })
              }),
          },
        )
        .pipe(
          Effect.as({ status: "admitted" as const }),
          Effect.catch((error) => Effect.succeed(
            error.cause instanceof QuotaExceeded
              ? { status: "quota" as const, kind: error.cause.kind }
              : error.cause instanceof QuotaPending
                ? { status: "pending" as const }
                : error.cause instanceof QuotaUsageUnknown
                  ? { status: "usage_unknown" as const }
                  : { status: "unavailable" as const },
          )),
          Effect.catchCause(() => Effect.succeed({ status: "unavailable" as const })),
        )
      const admission = exactReplay
        ? { status: "admitted" as const, admittedAt: existing!.admitted_at }
        : yield* Effect.gen(function* () {
            const deadline = Date.now() + tenant.deadline_ms
            while (true) {
              const admittedAt = Date.now()
              const result = yield* admitOnce(admittedAt)
              if (result.status !== "pending") return { ...result, admittedAt }
              if (Date.now() >= deadline) return { status: "pending_timeout" as const, admittedAt }
              yield* Effect.sleep("50 millis")
            }
          })
      const admittedAt = admission.admittedAt
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
      if (admission.status === "usage_unknown")
        return proxyError(503, "quota_usage_unknown", "Provider usage is unavailable for quota accounting")
      if (admission.status === "pending_timeout")
        return proxyError(503, "quota_wait_timeout", "An earlier tenant request has not settled")
      if (admission.status !== "admitted") return proxyError(503, "gateway_unavailable", "Gateway is unavailable")

      const complete = (output: {
        finishReason: string
        usage?: ReturnType<typeof LLMResponse.usage>
        cost: number | null
        firstTokenAt?: number
        completedAt?: number
        trace?: {
          activityID: string
          selections: { selectionID: string; tokenCount: number; projectionHash: string; selectedRefs: string; truncated: boolean }[]
        }
      }) => {
        const completedAt = output.completedAt ?? Date.now()
        return Effect.gen(function* () {
          yield* events.publish(
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
            costUnavailable: output.cost === null,
            mechanismTrace: output.trace,
          },
          {
            ...(laneSessionID && output.completedAt ? {
              id: EventV2.ID.make(`evt_proxy_complete_${createHash("sha256").update(ledgerID).digest("hex").slice(0, 40)}`),
              idempotent: true,
            } : {}),
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
          if (!output.trace) return
          yield* events.publish(MechanismTraced, { ...eventData, ...output.trace }, {
            id: EventV2.ID.make(`evt_proxy_trace_${createHash("sha256").update(ledgerID).digest("hex").slice(0, 40)}`),
            idempotent: true,
          }).pipe(Effect.ignore)
        })
      }

      const catalogCost = (yield* modelsDev.get())[selected.entry.id]?.models[selected.model.id]?.cost
      // Custom model tariffs are explicit config, while Provider.Info's zero default is not a
      // price declaration. Keep cost unavailable when neither catalog nor config knows a tariff.
      const modelCost = catalogCost ?? (selected.model.cost.input > 0 || selected.model.cost.output > 0
        ? { input: selected.model.cost.input, output: selected.model.cost.output,
            cache_read: selected.model.cost.cache.read, cache_write: selected.model.cost.cache.write }
        : undefined)
      const costFor = (usage: ReturnType<typeof LLMResponse.usage>) =>
        modelCost && usage?.inputTokens !== undefined && usage.outputTokens !== undefined
          ? ((usage.nonCachedInputTokens ?? usage.inputTokens) * modelCost.input +
              (usage.cacheReadInputTokens ?? 0) * (modelCost.cache_read ?? modelCost.input) +
              (usage.cacheWriteInputTokens ?? 0) * (modelCost.cache_write ?? modelCost.input) +
              usage.outputTokens * modelCost.output) /
            1_000_000
          : null

      if (laneSessionID) {
        const enhancedInput = {
          db,
          sessions,
          tenant,
          sessionID: laneSessionID,
          hint,
          requestID,
          request: parsed.value,
          providerID: selected.entry.id,
          modelID: selected.model.id,
        }
        const chunk = (choices: unknown[], finalUsage?: unknown) => `data: ${JSON.stringify({
          id: `chatcmpl-${requestID}`, object: "chat.completion.chunk", created: Math.floor(admittedAt / 1000),
          model: parsed.value.model, choices, ...(finalUsage ? { usage: finalUsage } : {}),
        })}\n\n`
        if (parsed.value.stream) {
          // The provider drain outlives its HTTP reader. A canceled or stalled reader must never
          // backpressure EventV2 listeners and leave the tenant's durable quota row pending.
          const queue = yield* Queue.dropping<string, Error>(128)
          let overflowed = false
          const offer = (value: string) => Effect.sync(() => {
            if (overflowed) return
            if (Queue.offerUnsafe(queue, value)) return
            overflowed = true
            Queue.failCauseUnsafe(queue, Cause.fail(new Error("Enhanced response consumer exceeded its 128-chunk buffer")))
          })
          yield* collectEnhanced({
            ...enhancedInput,
            onDelta: (text) => offer(chunk([{ index: 0, delta: { content: text }, finish_reason: null }])),
          }).pipe(
            Effect.catchCause(() => Effect.succeed({ ok: false as const, status: 503,
              code: "enhancement_failed", message: "Enhanced execution failed" })),
            Effect.flatMap((enhanced) => Effect.gen(function* () {
              if (!enhanced.ok) {
                yield* complete({ finishReason: enhanced.code, cost: null })
                yield* offer(`data: ${JSON.stringify({ error: { message: enhanced.message, type: "deepagent_enhancement_error", code: enhanced.code } })}\n\n`)
                return
              }
              const usage = enhanced.usage
              yield* complete({ finishReason: enhanced.finishReason, usage, cost: costFor(usage), firstTokenAt: enhanced.firstTokenAt,
                completedAt: enhanced.completedAt, trace: enhanced.trace })
              yield* offer(chunk([{ index: 0, delta: {}, finish_reason: enhanced.finishReason }]))
              if (parsed.value.stream_options?.include_usage && usage?.inputTokens !== undefined && usage.outputTokens !== undefined)
                yield* offer(chunk([], { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens,
                  total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens }))
            })),
            Effect.catchCause(() => offer(`data: ${JSON.stringify({ error: { message: "Enhanced execution failed", type: "deepagent_enhancement_error", code: "enhancement_failed" } })}\n\n`)),
            Effect.ensuring(offer("data: [DONE]\n\n")),
            Effect.forkIn(scope, { startImmediately: true }),
          )
          return HttpServerResponse.stream(
            Stream.make(chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }])).pipe(
              Stream.concat(Stream.fromQueue(queue).pipe(Stream.takeUntil((value) => value === "data: [DONE]\n\n"))),
              Stream.encodeText,
            ),
            { contentType: "text/event-stream", headers: { "cache-control": "no-cache, no-transform", "x-request-id": requestID } },
          )
        }
        const enhanced = yield* collectEnhanced(enhancedInput).pipe(Effect.catchCause(() => Effect.succeed({
          ok: false as const, status: 503, code: "enhancement_failed", message: "Enhanced execution failed",
        })))
        if (!enhanced.ok) {
          yield* complete({ finishReason: enhanced.code, cost: null })
          return proxyError(enhanced.status, enhanced.code, enhanced.message, "deepagent_enhancement_error")
        }
        const usage = enhanced.usage
        yield* complete({ finishReason: enhanced.finishReason, usage, cost: costFor(usage), firstTokenAt: enhanced.firstTokenAt,
          completedAt: enhanced.completedAt, trace: enhanced.trace })
        const usageWire = usage?.inputTokens !== undefined && usage.outputTokens !== undefined
          ? { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens,
              total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens }
          : null
        const payload = {
          id: `chatcmpl-${requestID}`,
          object: "chat.completion",
          created: Math.floor(admittedAt / 1000),
          model: parsed.value.model,
          choices: [{ index: 0, message: { role: "assistant", content: enhanced.text }, finish_reason: enhanced.finishReason }],
          usage: usageWire,
        }
        return HttpServerResponse.jsonUnsafe(payload, { headers: { "x-request-id": requestID, "cache-control": "no-store" } })
      }

      const baseURL = typeof options.baseURL === "string" ? options.baseURL : undefined

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
