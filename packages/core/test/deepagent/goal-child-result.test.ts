import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LLM, LLMClient, LLMEvent } from "@deepagent-code/llm"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { AmazonBedrock } from "@deepagent-code/llm/providers/compat"
import path from "node:path"

import { GoalChildResult } from "../../src/deepagent/goal-child-result"

const { EventStreamCodec } = await import(Bun.resolveSync("@smithy/eventstream-codec", path.resolve(import.meta.dir, "../../../llm")))

// Exercise the shipped binary framing/encoder over a real loopback socket. Bedrock is not a
// supported production SessionRunnerModel route; this is a protocol/accounting oracle only.
for (const complete of [true, false]) {
  test(`native Bedrock loopback usage preserves unknown reasoning; input breakdown complete=${complete}`, async () => {
    const codec = new EventStreamCodec(
      (value: Uint8Array) => new TextDecoder().decode(value),
      (value: string) => new TextEncoder().encode(value),
    )
    const usage = {
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      ...(complete ? { cacheReadInputTokens: 3, cacheWriteInputTokens: 2 } : {}),
    }
    const frames = (
      [
        ["messageStart", { role: "assistant" }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "known result" } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "end_turn" }],
        ["metadata", { usage }],
      ] as const
    ).map(([type, payload]) =>
      codec.encode({
        headers: {
          ":message-type": { type: "string", value: "event" },
          ":event-type": { type: "string", value: type },
          ":content-type": { type: "string", value: "application/json" },
        },
        body: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    )
    const bodies: unknown[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        expect(new URL(request.url).pathname).toBe("/model/test-model/converse-stream")
        bodies.push(await request.json())
        return new Response(Buffer.concat(frames), {
          headers: { "content-type": "application/vnd.amazon.eventstream" },
        })
      },
    })
    try {
      const response = await Effect.runPromise(
        LLMClient.generate(
          LLM.request({
            model: AmazonBedrock.configure({ apiKey: "private-fixture", baseURL: server.url.origin }).model(
              "test-model",
            ),
            system: "Fixed instruction",
            prompt: "Bounded text",
            cache: "none",
            generation: { maxTokens: 32 },
          }),
        ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))), Effect.scoped),
      )
      expect(bodies).toHaveLength(1)
      const finished = response.events.filter(LLMEvent.is.stepFinish)
      expect(finished).toHaveLength(1)
      expect(finished[0].usage?.reasoningTokens).toBeUndefined()
      const result = GoalChildResult.normalizeUsage(finished[0].usage!)
      if (complete)
        expect(result?.usage).toEqual({
          input: 20,
          nonCachedInput: 15,
          output: 10,
          reasoning: null,
          visibleOutput: null,
          cacheRead: 3,
          cacheWrite: 2,
        })
      if (!complete) expect(result).toBeUndefined()
    } finally {
      await server.stop(true)
    }
  })
}
