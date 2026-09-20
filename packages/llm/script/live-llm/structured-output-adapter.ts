import { Effect, Layer, Schema } from "effect"
import { LLM } from "../../src"
import { configure } from "../../src/providers/openai-compatible"
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
const thinkingControl = config.providerID === "zai" ? { reasoning_effort: "low" } : { thinking: { type: "disabled" } }
const preflight = await preflightLiveLLM(config)
const provider = configure({ provider: config.providerID, baseURL: config.baseURL, apiKey: config.apiKey })
const dependencies = Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer)
const client = LLMClient.layer.pipe(Layer.provide(dependencies))
const startedAt = Date.now()

// GLM 5.x serializes tool-call numbers as strings (deterministic at temperature 0); keep
// strict Number for providers without the quirk so a regression there still fails hard.
const schemaNumber =
  config.providerID === "zai" ? Schema.Union([Schema.Number, Schema.NumberFromString]) : Schema.Number
const rawInputOption = config.providerID === "zai" ? { rawInput: false } : {}

const program = Effect.gen(function* () {
  const response = yield* LLM.generateObject({
    model: provider.model(config.modelID),
    system: "Return exactly the requested values through the required tool. Do not add or omit fields.",
    prompt: `Return this object exactly: ${JSON.stringify(expected)}`,
    schema: Schema.Struct({
      answer: schemaNumber,
      summary: Schema.String,
      nested: Schema.Struct({
        marker: Schema.String,
        items: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            score: schemaNumber,
          }),
        ),
      }),
    }),
    generation: { maxTokens: 256, temperature: 0 },
    http: { body: thinkingControl },
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
      // GLM stringifies tool-call numbers; the schema decode + strict object equality above
      // carry the value verification, so skip the byte-level input comparison for zai only.
      ...assertToolResponse(response.response, "generate_object", expected, rawInputOption),
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
