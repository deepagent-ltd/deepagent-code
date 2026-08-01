import { Effect, Layer, Stream } from "effect"
import { LLM, LLMEvent, LLMResponse } from "../../src"
import { deepseek } from "../../src/providers/openai-compatible"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "../../src/route"
import { assertTextResponse } from "./assertions"
import { loadLiveLLMConfig, modelFingerprint, preflightLiveLLM, writeLiveArtifact } from "./config"

const suite = "provider-abort"
const config = await loadLiveLLMConfig()
const preflight = await preflightLiveLLM(config)
const provider = deepseek.configure({ baseURL: config.baseURL, apiKey: config.apiKey })
const dependencies = Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer)
const client = LLMClient.layer.pipe(Layer.provide(dependencies))

const program = Effect.gen(function* () {
  const llm = yield* LLMClient.Service
  const interruptedStartedAt = Date.now()
  const interrupted = Array.from(
    yield* llm
      .stream(
        LLM.request({
          model: provider.model(config.modelID),
          system: "Follow the requested output format exactly.",
          prompt: "Write the integers from 1 through 1000, one integer per line.",
          generation: { maxTokens: 2048, temperature: 0 },
          http: { body: { thinking: { type: "disabled" } } },
        }),
      )
      .pipe(Stream.takeUntil(LLMEvent.is.textDelta), Stream.runCollect),
  )
  if (!interrupted.some(LLMEvent.is.textDelta) || interrupted.some(LLMEvent.is.finish)) {
    throw new Error("Provider abort probe did not stop during an active text stream")
  }

  const recoveryStartedAt = Date.now()
  const recoveryResponse = yield* llm.generate(
    LLM.request({
      model: provider.model(config.modelID),
      prompt: "Reply with exactly RECOVERED.",
      generation: { maxTokens: 32, temperature: 0 },
      http: { body: { thinking: { type: "disabled" } } },
    }),
  )
  const recovery = assertTextResponse(recoveryResponse)
  if (!LLMResponse.text(recoveryResponse).toUpperCase().includes("RECOVERED")) {
    throw new Error("Provider did not recover after stream cancellation")
  }

  return {
    suite,
    mode: "ext",
    stack: "adapter",
    status: "passed",
    fingerprint: modelFingerprint(config),
    preflight,
    interrupted: {
      eventTypes: interrupted.map((event) => event.type),
      durationMs: Date.now() - interruptedStartedAt,
    },
    recovery: { ...recovery, durationMs: Date.now() - recoveryStartedAt },
    completedAt: new Date().toISOString(),
  }
}).pipe(Effect.timeout(config.timeoutMs), Effect.provide(Layer.mergeAll(dependencies, client)))

const artifact = await Effect.runPromise(program)
await writeLiveArtifact(config, suite, artifact)
console.log(
  `${suite}: passed (${artifact.fingerprint.providerID}/${artifact.fingerprint.modelID}, ` +
    `${artifact.recovery.usage.totalTokens} recovery tokens)`,
)
