import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { finishLiveScript } from "./lifecycle"
import {
  loadLiveLLMConfig,
  liveLLMKeyFileReference,
  modelFingerprint,
  preflightLiveLLM,
  writeLiveArtifact,
} from "../../../llm/script/live-llm/config"

const suite = "structured-output-legacy"
const runtimeProviderID = "live-deepseek"
const config = await loadLiveLLMConfig()
const preflight = await preflightLiveLLM(config)
const testRoot = await mkdtemp(path.join(os.tmpdir(), "deepagent-code-live-llm-"))
const isolatedHome = path.join(testRoot, "home")
const isolatedData = path.join(testRoot, "deepagent-home")

await mkdir(isolatedHome, { recursive: true })
await mkdir(path.join(isolatedData, "node_modules"), { recursive: true })
await Bun.write(
  path.join(isolatedData, "package.json"),
  JSON.stringify({ private: true, dependencies: { "@deepagent-code/plugin": "workspace:*" } }),
)
await Bun.write(
  path.join(isolatedData, "package-lock.json"),
  JSON.stringify({
    lockfileVersion: 3,
    packages: { "": { dependencies: { "@deepagent-code/plugin": "workspace:*" } } },
  }),
)
process.env.HOME = isolatedHome
process.env.XDG_DATA_HOME = path.join(testRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(testRoot, "config")
process.env.XDG_CACHE_HOME = path.join(testRoot, "cache")
process.env.XDG_STATE_HOME = path.join(testRoot, "state")
process.env.DEEPAGENT_CODE_TEST_HOME = isolatedHome
process.env.DEEPAGENT_CODE_HOME = isolatedData
process.env.DEEPAGENT_CODE_CONFIG_DIR = isolatedData
process.env.DEEPAGENT_CODE_DISABLE_AUTOUPDATE = "1"
process.env.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = "1"
process.env.DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS = "1"
process.env.DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE = config.apiKeyFile

const { SessionV1 } = await import("@deepagent-code/core/v1/session")
const { ModelV2 } = await import("@deepagent-code/core/model")
const { ProviderV2 } = await import("@deepagent-code/core/provider")
const { Effect, Layer, Schema } = await import("effect")
const { SessionPrompt } = await import("../../src/session/prompt")
const { Session } = await import("../../src/session/session")
const { testInstanceStoreLayer, withTmpdirInstance } = await import("../../test/fixture/fixture")

const marker = crypto.randomUUID()
const providerID = ProviderV2.ID.make(runtimeProviderID)
const modelID = ModelV2.ID.make(config.modelID)
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
const outputSchema = Schema.Struct({
  answer: Schema.Number,
  summary: Schema.String,
  nested: Schema.Struct({
    marker: Schema.String,
    items: Schema.Array(Schema.Struct({ name: Schema.String, score: Schema.Number })),
  }),
})
const workspaceConfig: ConfigV1.Info = {
  snapshot: false,
  enabled_providers: [runtimeProviderID],
  model: `${runtimeProviderID}/${config.modelID}`,
  provider: {
    [runtimeProviderID]: {
      name: "DeepSeek live test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      api: config.baseURL,
      options: {
        apiKey: liveLLMKeyFileReference(config),
        baseURL: config.baseURL,
        maxRetries: 0,
        timeout: config.timeoutMs,
      },
      models: {
        [config.modelID]: {
          id: config.modelID,
          name: "DeepSeek V4 Flash live test",
          reasoning: false,
          temperature: true,
          tool_call: true,
          release_date: "2026-07-27",
          limit: { context: 1_000_000, output: 4096 },
          cost: { input: 0, output: 0 },
          modalities: { input: ["text"], output: ["text"] },
          options: { thinking: { type: "disabled" } },
        },
      },
    },
  },
}

const program = Effect.gen(function* () {
  const prompts = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "Live structured output" })
  const startedAt = Date.now()
  const result = yield* prompts.prompt({
    sessionID: session.id,
    model: { providerID, modelID },
    agent: "build",
    parts: [
      {
        type: "text",
        text: `Return this object exactly through StructuredOutput: ${JSON.stringify(expected)}`,
      },
    ],
    format: new SessionV1.OutputFormatJsonSchema({
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          answer: { type: "number" },
          summary: { type: "string" },
          nested: {
            type: "object",
            properties: {
              marker: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, score: { type: "number" } },
                  required: ["name", "score"],
                  additionalProperties: false,
                },
              },
            },
            required: ["marker", "items"],
            additionalProperties: false,
          },
        },
        required: ["answer", "summary", "nested"],
        additionalProperties: false,
      },
      retryCount: 2,
    }),
  })

  if (result.info.role !== "assistant") throw new Error("Legacy SessionPrompt did not return an assistant message")
  if (result.info.error) throw new Error(`Legacy SessionPrompt returned ${result.info.error.name}`)
  if (!result.info.finish) throw new Error("Legacy SessionPrompt did not persist a finish reason")
  if (result.info.providerID !== runtimeProviderID || result.info.modelID !== config.modelID) {
    throw new Error("Legacy SessionPrompt persisted the wrong provider/model identity")
  }

  const output = Schema.decodeUnknownSync(outputSchema)(result.info.structured)
  if (JSON.stringify(output) !== JSON.stringify(expected)) {
    throw new Error("Legacy SessionPrompt structured metadata did not preserve the requested values")
  }
  const structuredParts = result.parts.filter(
    (part) => part.type === "tool" && part.tool === "StructuredOutput" && part.state.status === "completed",
  )
  if (structuredParts.length !== 1) {
    throw new Error(`Expected one completed StructuredOutput part, received ${structuredParts.length}`)
  }

  const messages = yield* sessions.messages({ sessionID: session.id })
  const persisted = messages.find((message) => message.info.id === result.info.id)
  if (persisted?.info.role !== "assistant") throw new Error("Structured assistant message was not persisted")
  const persistedOutput = Schema.decodeUnknownSync(outputSchema)(persisted.info.structured)
  if (JSON.stringify(persistedOutput) !== JSON.stringify(expected)) {
    throw new Error("Persisted assistant structured metadata differs from the returned message")
  }
  const user = messages.find((message) => message.info.role === "user")
  if (user?.info.role !== "user" || user.info.format?.type !== "json_schema") {
    throw new Error("Structured output format was not persisted on the user message")
  }
  const inputTokens = result.info.tokens.input + result.info.tokens.cache.read + result.info.tokens.cache.write
  if (inputTokens <= 0 || result.info.tokens.output <= 0) {
    throw new Error("Legacy SessionPrompt did not persist provider token usage")
  }

  return {
    suite,
    mode: "live",
    stack: "legacy-session",
    status: "passed",
    fingerprint: { ...modelFingerprint(config), runtimeProviderID },
    preflight: { durationMs: preflight.durationMs },
    session: {
      messageCount: messages.length,
      structuredToolParts: structuredParts.length,
      topLevelFields: Object.keys(output).toSorted(),
      itemCount: output.nested.items.length,
      markerHash: Bun.hash(marker).toString(16),
      finishReason: result.info.finish,
      usage: {
        inputTokens,
        outputTokens: result.info.tokens.output,
        reasoningTokens: result.info.tokens.reasoning,
      },
      durationMs: Date.now() - startedAt,
    },
    completedAt: new Date().toISOString(),
  }
})

try {
  const artifact = await Effect.runPromise(
    program.pipe(
      withTmpdirInstance({ git: true, config: workspaceConfig }),
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer).pipe(Layer.provide(testInstanceStoreLayer)),
      ),
      Effect.timeout(config.timeoutMs),
    ),
  )
  await writeLiveArtifact(
    { ...config, artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
    suite,
    artifact,
  )
  console.log(
    `${suite}: passed (${artifact.fingerprint.providerID}/${artifact.fingerprint.modelID}, ` +
      `${artifact.session.usage.inputTokens + artifact.session.usage.outputTokens} tokens)`,
  )
} finally {
  await rm(testRoot, { recursive: true, force: true })
}
finishLiveScript()
