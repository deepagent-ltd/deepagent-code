import { Effect, Layer } from "effect"
import { LLM, ToolDefinition } from "../../src"
import { deepseek } from "../../src/providers/openai-compatible"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "../../src/route"
import { assertTextResponse, assertToolResponse } from "./assertions"
import {
  liveLLMArtifactDirectory,
  loadLiveLLMConfig,
  modelFingerprint,
  preflightLiveLLM,
  writeLiveArtifact,
  type ModelFingerprint,
} from "./config"

const suite = "provider-smoke"

const startedAt = new Date().toISOString()
const bootstrap = {
  artifactDirectory: liveLLMArtifactDirectory(),
  fingerprint: {
    providerID: "deepseek",
    modelID: process.env.DEEPAGENT_CODE_LIVE_LLM_MODEL?.trim() || "deepseek-v4-flash",
    modelRevision: process.env.DEEPAGENT_CODE_LIVE_LLM_REVISION?.trim() || undefined,
    baseURL: (process.env.DEEPAGENT_CODE_LIVE_LLM_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/$/, ""),
  } satisfies ModelFingerprint,
}
await writeLiveArtifact(bootstrap, suite, {
  suite,
  mode: "live",
  stack: "adapter",
  status: "running",
  phase: "configuration",
  fingerprint: bootstrap.fingerprint,
  startedAt,
})
const config = await loadLiveLLMConfig().catch((error: unknown) =>
  failProviderSmoke(bootstrap, bootstrap.fingerprint, error, "configuration", startedAt),
)
const preflight = await preflightLiveLLM(config).catch((error: unknown) =>
  failProviderSmoke(config, modelFingerprint(config), error, "preflight", startedAt),
)
const provider = deepseek.configure({ baseURL: config.baseURL, apiKey: config.apiKey })
const model = provider.model(config.modelID)
const dependencies = Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer)
const client = LLMClient.layer.pipe(Layer.provide(dependencies))
const special = `line one\nline "two" 'quoted' 雪-${crypto.randomUUID()}`

const program = Effect.gen(function* () {
  const llm = yield* LLMClient.Service
  const prepared = yield* llm.prepare(
    LLM.request({
      model,
      prompt: "Reply with a short acknowledgement.",
      generation: { maxTokens: 64, temperature: 0 },
      http: { body: { thinking: { type: "disabled" } } },
    }),
  )
  if (prepared.model.provider !== config.providerID || prepared.model.id !== config.modelID) {
    throw new Error("Prepared request provider/model identity does not match live configuration")
  }

  const textStartedAt = Date.now()
  const text = assertTextResponse(
    yield* llm.generate(
      LLM.request({
        model,
        system: "Follow the user instruction exactly and answer briefly.",
        prompt: "Reply with a short acknowledgement.",
        generation: { maxTokens: 64, temperature: 0 },
        http: { body: { thinking: { type: "disabled" } } },
      }),
    ),
  )

  const expectedInput = { value: special }
  const toolStartedAt = Date.now()
  const tool = assertToolResponse(
    yield* llm.generate(
      LLM.request({
        model,
        system:
          "Call the required tool once. Parse the supplied JSON string literal, then pass its decoded string value. " +
          "JSON escapes represent characters and must not be double-escaped.",
        prompt: `Parse this JSON string literal and pass the decoded value to echo_special: ${JSON.stringify(special)}`,
        tools: [
          ToolDefinition.make({
            name: "echo_special",
            description: "Echo a synthetic value for provider protocol verification.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          }),
        ],
        toolChoice: "echo_special",
        generation: { maxTokens: 128, temperature: 0 },
        http: { body: { thinking: { type: "disabled" } } },
      }),
    ),
    "echo_special",
    expectedInput,
  )

  return {
    suite,
    mode: "live",
    stack: "adapter",
    status: "passed",
    fingerprint: modelFingerprint(config),
    preflight,
    prepared: { route: prepared.route, protocol: prepared.protocol },
    text: { ...text, durationMs: Date.now() - textStartedAt },
    tool: { ...tool, durationMs: Date.now() - toolStartedAt, inputHash: Bun.hash(special).toString(16) },
    completedAt: new Date().toISOString(),
  }
}).pipe(Effect.timeout(config.timeoutMs), Effect.provide(Layer.mergeAll(dependencies, client)))

const artifact = await Effect.runPromise(program).catch((error: unknown) =>
  failProviderSmoke(config, modelFingerprint(config), error, "provider", startedAt),
)
await writeLiveArtifact(config, suite, artifact)
console.log(
  `${suite}: passed (${artifact.fingerprint.providerID}/${artifact.fingerprint.modelID}, ` +
    `${artifact.text.usage.totalTokens + artifact.tool.usage.totalTokens} tokens)`,
)

async function failProviderSmoke(
  artifactConfig: Parameters<typeof writeLiveArtifact>[0],
  fingerprint: ModelFingerprint,
  error: unknown,
  phase: "configuration" | "preflight" | "provider",
  startedAt: string,
): Promise<never> {
  await writeLiveArtifact(artifactConfig, suite, {
    suite,
    mode: "live",
    stack: "adapter",
    status: "failed",
    fingerprint,
    phase,
    error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
    startedAt,
    completedAt: new Date().toISOString(),
  })
  throw error
}
