import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMError } from "../../src"
import { Auth, LLMClient, RequestExecutor } from "../../src/route"
import * as OpenAIChat from "../../src/protocols/openai-chat"
import * as OpenAIResponses from "../../src/protocols/openai-responses"
import { byProvider as OpenAICompatibleProfiles, type OpenAICompatibleProfile } from "../../src/providers/openai-compatible-profile"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"

const JSON_HEADERS = { "content-type": "application/json" } as const

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4.1-mini" })

const request = LLM.request({
  id: "req_compact",
  model,
  system: "You are concise.",
  prompt: "Summarize this session.",
  generation: { maxTokens: 20, temperature: 0 },
})

const compactBody = (encryptedContent = "enc-blob") =>
  JSON.stringify({ output: [{ type: "compaction", id: "cmp_1", encrypted_content: encryptedContent }] })

// Unary compaction must never consume a status-retry budget: a failed compact
// should fail over to local summarization immediately, not burn retries.
// Applied inside each pipe exactly like executor.test.ts does.

const readBody = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClientRequest.toWeb(request).pipe(
    Effect.orDie,
    Effect.flatMap((web) => Effect.promise(() => web.json())),
  )

describe("OpenAI Responses unary compaction (/responses/compact)", () => {
  it.effect("prepends encrypted compaction state to an ordinary Responses request", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.updateRequest(request, {
          providerOptions: { openai: { compactionEncryptedContent: "enc-normal-turn" } },
        }),
      )
      expect(prepared.body).toMatchObject({
        stream: true,
        input: [
          { type: "compaction", encrypted_content: "enc-normal-turn" },
          { role: "system", content: "You are concise." },
          { role: "user", content: [{ type: "input_text", text: "Summarize this session." }] },
        ],
      })
    }),
  )

  it.effect("posts a unary compact request with the stream field stripped", () =>
    OpenAIResponses.compactConversation({ request }).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://api.openai.test/v1/responses/compact")
            expect(web.method).toBe("POST")
            expect(web.headers.get("content-type")).toBe("application/json")
            const body = (yield* Effect.promise(() => web.json())) as Record<string, unknown>
            expect(body.model).toBe("gpt-4.1-mini")
            expect(body.stream).toBeUndefined()
            expect(body.tool_choice).toBeUndefined()
            expect(body.input).toEqual([
              { role: "system", content: "You are concise." },
              { role: "user", content: [{ type: "input_text", text: "Summarize this session." }] },
            ])
            return input.respond(compactBody(), { headers: JSON_HEADERS })
          }),
        ),
      ),
      Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
    ),
  )

  it.effect("prepends the prior compaction item when previousEncryptedContent is staged", () =>
    OpenAIResponses.compactConversation({ request, previousEncryptedContent: "prior-enc" }).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const body = (yield* readBody(input.request)) as Record<string, unknown>
            const inputItems = body.input as ReadonlyArray<Record<string, unknown>>
            expect(inputItems[0]).toEqual({ type: "compaction", encrypted_content: "prior-enc" })
            expect(inputItems[1]).toEqual({ role: "system", content: "You are concise." })
            return input.respond(compactBody("enc-blob-2"), { headers: JSON_HEADERS })
          }),
        ),
      ),
      Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
    ),
  )

  it.effect("parses the compact response and surfaces the encrypted context", () =>
    OpenAIResponses.compactConversation({ request }).pipe(
      Effect.provide(fixedResponse(compactBody("enc-abc"), { headers: JSON_HEADERS })),
      Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.encryptedContent).toBe("enc-abc")
          expect(result.output).toEqual([{ type: "compaction", id: "cmp_1", encrypted_content: "enc-abc" }])
        }),
      ),
    ),
  )

  it.effect("round-trips encrypted_content across successive compactions", () =>
    Effect.gen(function* () {
      const first = yield* OpenAIResponses.compactConversation({ request }).pipe(
        Effect.provide(fixedResponse(compactBody("enc-round-1"), { headers: JSON_HEADERS })),
        Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
      )
      expect(first.encryptedContent).toBe("enc-round-1")
      const second = yield* OpenAIResponses.compactConversation({
        request,
        previousEncryptedContent: first.encryptedContent,
      }).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const body = (yield* readBody(input.request)) as Record<string, unknown>
              expect((body.input as ReadonlyArray<Record<string, unknown>>)[0]).toEqual({
                type: "compaction",
                encrypted_content: "enc-round-1",
              })
              return input.respond(compactBody("enc-round-2"), { headers: JSON_HEADERS })
            }),
          ),
        ),
        Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
      )
      expect(second.encryptedContent).toBe("enc-round-2")
    }),
  )

  it.effect("fails when the response carries no compaction item (local fail-over signal)", () =>
    OpenAIResponses.compactConversation({ request }).pipe(
      Effect.provide(fixedResponse(JSON.stringify({ output: [] }), { headers: JSON_HEADERS })),
      Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(LLMError)
          expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
        }),
      ),
    ),
  )

  it.effect("fails on a malformed compact payload (local fail-over signal)", () =>
    OpenAIResponses.compactConversation({ request }).pipe(
      Effect.provide(fixedResponse("not-json", { headers: JSON_HEADERS })),
      Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(LLMError)
        }),
      ),
    ),
  )

  it.effect("fails on provider HTTP errors (local fail-over signal)", () =>
    OpenAIResponses.compactConversation({ request }).pipe(
      Effect.provide(fixedResponse(JSON.stringify({ error: "boom" }), { status: 500, headers: JSON_HEADERS })),
      Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(LLMError)
          expect(error.reason).toMatchObject({ _tag: "ProviderInternal" })
        }),
      ),
    ),
  )

  it.effect("rejects requests bound to a non-responses route", () =>
    OpenAIResponses.compactConversation({
      request: LLM.request({
        id: "req_chat",
        model: OpenAIChat.route.model({ id: "gpt-4.1-mini" }),
        prompt: "hi",
      }),
    }).pipe(
      // The route check fails before any HTTP happens; the layer only exists
      // to satisfy the environment requirement.
      Effect.provide(fixedResponse("unused", { headers: JSON_HEADERS })),
      Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(LLMError)
          expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
        }),
      ),
    ),
  )
})

describe("remote compaction capability flags", () => {
  test("exposes compact support on the OpenAI Responses protocol", () => {
    expect(OpenAIResponses.supportsRemoteCompaction).toBe(true)
    expect(OpenAIResponses.COMPACT_PATH).toBe("/responses/compact")
  })

  test("only verified opt-ins assume compact support among OpenAI-compatible families", () => {
    // 2026-08-18 用户决策:DeepSeek 官方 API 支持 /responses/compact,为已验证 opt-in;
    // 其余 openai-compatible 家族(含 vLLM/SGLang 类)永不默认假设。
    expect(OpenAICompatibleProfiles["deepseek"]?.supportsResponsesCompact).toBe(true)
    for (const [provider, profile] of Object.entries(OpenAICompatibleProfiles)) {
      if (provider === "deepseek") continue
      expect((profile as OpenAICompatibleProfile).supportsResponsesCompact ?? false).toBe(false)
    }
  })
})
