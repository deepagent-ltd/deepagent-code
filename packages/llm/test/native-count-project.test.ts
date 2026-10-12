import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LLM, Message, ToolCallPart, ToolChoice, ToolDefinition } from "../src"
import { Auth } from "../src/route/auth"
import { LLMClient } from "../src/route/client"
import { RequestExecutor } from "../src/route/executor"
import { OpenAIResponses } from "../src/protocols/openai-responses"
import { testEffect } from "./lib/effect"

const it = testEffect(LLMClient.nativeManagedLayer.pipe(
  Layer.provide(RequestExecutor.defaultLayer),
  Layer.provide(Layer.succeed(LLMClient.Middleware, () => ({ prepare: (next) => next, stream: (next) => next }))),
))

for (const mode of ["tool-history", "named-tool", "final-overlay", "previous-response", "conversation", "unknown-input", "truncation"] as const) {
  it.live(`native count project input ${mode} uses the actual complete encoded input`, () => Effect.gen(function* () {
    const client = yield* LLMClient.Service
    const seen: { path: string; body: string }[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        seen.push({ path: new URL(request.url).pathname, body: await request.text() })
        if (new URL(request.url).pathname.endsWith("/input_tokens"))
          return Response.json({ object: "response.input_tokens", input_tokens: 117 })
        return new Response('data: {"type":"response.completed","response":{"id":"project-count"}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
    const request = LLM.request({
      model: OpenAIResponses.route.with({
        endpoint: { baseURL: `${server.url.origin}/v1` },
        auth: Auth.value("private-project-count-fixture").bearer(),
      }).model({ id: "gpt-4.1-2025-04-14" }),
      system: "Approved project instructions",
      messages: [
        Message.user("读取获准文件，返回结论"),
        Message.assistant([ToolCallPart.make({ id: "actual-call-1", name: "read", input: { path: "src/中文.ts" } })]),
        Message.tool({ id: "actual-call-1", name: "read", result: "export const value = 7", resultType: "text" }),
      ],
      tools: [ToolDefinition.make({
        name: "read", description: "Read an approved project file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      })],
      toolChoice: mode === "named-tool" ? ToolChoice.named("read") : "auto",
      generation: { maxTokens: 32 },
      providerOptions: { openai: { store: false } },
      ...(mode === "tool-history" || mode === "named-tool" ? {} : { http: { body: mode === "final-overlay"
        ? { instructions: "Explicit additional reviewed instructions", parallel_tool_calls: false, text: { format: { type: "json_schema", name: "answer", strict: true, schema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } } } }
        : mode === "previous-response" ? { previous_response_id: "unobserved-history" }
        : mode === "conversation" ? { conversation: "unobserved-conversation" }
        : mode === "truncation" ? { truncation: "auto" }
        : { future_context: "must-not-be-silently-dropped" } } }),
    })
    yield* LLMClient.bindNativeRequest(client, request)
    const outcome = yield* client.generate(request).pipe(
      Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
      Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
      Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: (observation) =>
        LLMClient.countNativeInput(client, request, observation, Date.now() + 5_000).pipe(
          Effect.tap((count) => Effect.sync(() => expect(count.inputTokens).toBe(117))),
          Effect.asVoid,
          Effect.orDie,
        ) }),
      Effect.exit,
    )
    if (["previous-response", "conversation", "unknown-input", "truncation"].includes(mode)) {
      expect(outcome._tag).toBe("Failure")
      expect(seen).toEqual([])
      return
    }
    expect(outcome._tag).toBe("Success")
    expect(seen.map((entry) => entry.path)).toEqual(["/v1/responses/input_tokens", "/v1/responses"])
    const count = JSON.parse(seen[0]!.body)
    const generation = JSON.parse(seen[1]!.body)
    expect(count.model).toBe("gpt-4.1-2025-04-14")
    expect(count.tools).toEqual(generation.tools)
    expect(count.tools[0].parameters.properties.path.type).toBe("string")
    expect(count.tool_choice).toEqual(mode === "named-tool" ? { type: "function", name: "read" } : "auto")
    expect(count.input).toEqual(generation.input)
    expect(count.input).toContainEqual({ type: "function_call", call_id: "actual-call-1", name: "read", arguments: '{"path":"src/中文.ts"}' })
    expect(count.input).toContainEqual({ type: "function_call_output", call_id: "actual-call-1", output: "export const value = 7" })
    if (mode === "final-overlay") {
      expect(count.instructions).toBe("Explicit additional reviewed instructions")
      expect(count.parallel_tool_calls).toBe(false)
      expect(count.text).toEqual(generation.text)
    }
    expect(count.max_output_tokens).toBeUndefined()
    expect(count.stream).toBeUndefined()
    expect(count.store).toBeUndefined()
  }))
}
