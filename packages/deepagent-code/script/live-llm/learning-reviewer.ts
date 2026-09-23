import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { LLMClient } from "@deepagent-code/llm"
import { RequestExecutor, WebSocketExecutor } from "@deepagent-code/llm/route"
import { Effect, Layer } from "effect"
import { loadLiveLLMConfig, modelFingerprint, preflightLiveLLM, writeLiveArtifact } from "../../../llm/script/live-llm/config"
import type { Auth } from "../../src/auth"
import { createLearningReviewerPort } from "../../src/deepagent/learning-reviewer-runner"
import type { Provider } from "../../src/provider/provider"

const config = await loadLiveLLMConfig()
if (config.providerID !== "deepseek") throw new Error("Learning reviewer live qualification requires DeepSeek")
const preflight = await preflightLiveLLM(config)
const providerID = ProviderV2.ID.make(config.providerID)
const modelID = ModelV2.ID.make(config.modelID)
const model: Provider.Model = {
  id: modelID,
  providerID,
  api: { id: config.modelID, url: config.baseURL, npm: "@ai-sdk/openai-compatible" },
  name: "DeepSeek reviewer",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 4_096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
const provider: Provider.Info = {
  id: providerID,
  name: "DeepSeek",
  source: "config",
  env: [],
  options: {},
  models: { [modelID]: model },
}
const dependencies = Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer)
const program = Effect.gen(function* () {
  const llmClient = yield* LLMClient.Service
  const reviewer = createLearningReviewerPort({
    auth: { get: () => Effect.succeed({ type: "api", key: config.apiKey } as Auth.Info) },
    provider: {
      defaultModel: () => Effect.succeed({ providerID, modelID }),
      getSmallModel: () => Effect.succeed(model),
      getProvider: () => Effect.succeed(provider),
      getModel: () => Effect.succeed(model),
    },
    llmClient,
  })
  const identity = yield* reviewer.identity({
    attemptId: "review:live-learning-reviewer",
    jobId: "live-learning-reviewer",
    workspacePath: "/isolated/reviewer",
  })
  const result = yield* reviewer.execute({
    attemptId: "review:live-learning-reviewer",
    reviewSessionId: identity.reviewSessionId,
    workspacePath: "/isolated/reviewer",
    providerId: identity.providerId,
    modelId: identity.modelId,
    policyHash: identity.policyHash,
    requestRef: "live:learning-reviewer",
    request: JSON.stringify({
      schema_version: "deepagent-code.learning_review_request.v1",
      candidates: [{
        candidate_id: "candidate-live-1",
        type: "pattern",
        summary: "The evidence shows that rerunning the relevant package test after an edit caught a regression.",
        evidence_refs: ["artifact:live-test-result"],
        source_run_id: "live-reviewer-qualification",
        confidence: 0.9,
      }],
      instructions: "Return only a JSON object with verdict (approve, reject, or manual_review) and selected_candidate_ids (string array). Never invent candidates or modify evidence.",
    }),
  })
  if (result.selectedCandidateIds.some((id) => id !== "candidate-live-1"))
    throw new Error("Reviewer selected an unknown candidate")
  return { result, identity }
}).pipe(Effect.timeout(config.timeoutMs), Effect.provide(LLMClient.layer.pipe(Layer.provide(dependencies))))

const outcome = await Effect.runPromise(program)
await writeLiveArtifact(config, "learning-reviewer", {
  suite: "learning-reviewer",
  status: "passed",
  fingerprint: modelFingerprint(config),
  preflight,
  policyHash: outcome.identity.policyHash,
  verdict: outcome.result.verdict,
  selectedCandidateIds: outcome.result.selectedCandidateIds,
  completedAt: new Date().toISOString(),
}, { harnessFiles: [import.meta.path] })
console.log(`learning-reviewer: passed (${config.providerID}/${config.modelID}, ${outcome.result.verdict})`)
