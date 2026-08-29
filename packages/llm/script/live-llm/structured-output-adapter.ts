import { Effect, Layer, Schema } from "effect"
import { LLM } from "../../src"
import { deepseek } from "../../src/providers/openai-compatible"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "../../src/route"
import { assertToolResponse } from "./assertions"
import { loadLiveLLMConfig, modelFingerprint, preflightLiveLLM, writeLiveArtifact } from "./config"

const suite = "structured-output-adapter"
const marker = crypto.randomUUID()
const expected = {
  answer: 37,
  summary: "schema verified",
  nested: {
    marker,
    items: [
      { name: "alpha", score: 7 },
      { name: "beta", score: 11 },
    ],
  },
}

const config = await loadLiveLLMConfig()
const preflight = await preflightLiveLLM(config)
const provider = deepseek.configure({ baseURL: config.baseURL, apiKey: config.apiKey })
const dependencies = Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer)
const client = LLMClient.layer.pipe(Layer.provide(dependencies))
const startedAt = Date.now()

const program = Effect.gen(function* () {
  const response = yield* LLM.generateObject({
    model: provider.model(config.modelID),
    system: "Return exactly the requested values through the required tool. Do not add or omit fields.",
    prompt: `Return this object exactly: ${JSON.stringify(expected)}`,
    schema: Schema.Struct({
      answer: Schema.Number,
      summary: Schema.String,
      nested: Schema.Struct({
        marker: Schema.String,
        items: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            score: Schema.Number,
          }),
        ),
      }),
    }),
    generation: { maxTokens: 256, temperature: 0 },
    http: { body: { thinking: { type: "disabled" } } },
  })

  if (JSON.stringify(response.object) !== JSON.stringify(expected)) {
    throw new Error("Structured output passed schema decoding but did not preserve the requested values")
  }

  return {
    suite,
    mode: "live",
    stack: "adapter",
    status: "passed",
    fingerprint: modelFingerprint(config),
    preflight,
    structured: {
      ...assertToolResponse(response.response, "generate_object", expected),
      topLevelFields: Object.keys(response.object).toSorted(),
      itemCount: response.object.nested.items.length,
      markerHash: Bun.hash(marker).toString(16),
      durationMs: Date.now() - startedAt,
    },
    completedAt: new Date().toISOString(),
  }
}).pipe(Effect.timeout(config.timeoutMs), Effect.provide(Layer.mergeAll(dependencies, client)))

const artifact = await Effect.runPromise(program)
await writeLiveArtifact(config, suite, artifact)
console.log(
  `${suite}: passed (${artifact.fingerprint.providerID}/${artifact.fingerprint.modelID}, ` +
    `${artifact.structured.usage.totalTokens} tokens)`,
)
