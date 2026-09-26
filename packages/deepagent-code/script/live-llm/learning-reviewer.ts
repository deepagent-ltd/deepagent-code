import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { LLMClient } from "@deepagent-code/llm"
import { RequestExecutor, WebSocketExecutor } from "@deepagent-code/llm/route"
import { Cause, Effect, Exit, Layer } from "effect"
import {
  loadLiveLLMConfig,
  modelFingerprint,
  preflightLiveLLM,
  writeLiveArtifact,
} from "../../../llm/script/live-llm/config"
import type { Auth } from "../../src/auth"
import { createLearningReviewerPort } from "../../src/deepagent/learning-reviewer-runner"
import type { Provider } from "../../src/provider/provider"

const config = await loadLiveLLMConfig()
if (config.providerID !== "deepseek") throw new Error("Learning reviewer live qualification requires DeepSeek")
const runs = Number(process.env.DEEPAGENT_CODE_LEARNING_REVIEWER_SOAK_RUNS ?? "1")
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20)
  throw new Error("DEEPAGENT_CODE_LEARNING_REVIEWER_SOAK_RUNS must be an integer from 1 to 20")
if (runs > 1 && process.env.DEEPAGENT_DURABLE_LEARNING_REVIEWER !== "true")
  throw new Error("Reviewer soak requires DEEPAGENT_DURABLE_LEARNING_REVIEWER=true")
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
  return yield* Effect.forEach(
    Array.from({ length: runs }, (_, index) => index + 1),
    (index) =>
      Effect.gen(function* () {
        const startedAt = Date.now()
        const candidateID = `candidate-live-${index}`
        const attemptID = `review:live-learning-reviewer-${index}`
        const outcome = yield* Effect.gen(function* () {
          const identity = yield* reviewer.identity({
            attemptId: attemptID,
            jobId: `live-learning-reviewer-${index}`,
            workspacePath: "/isolated/reviewer",
          })
          const result = yield* reviewer.execute({
            attemptId: attemptID,
            reviewSessionId: identity.reviewSessionId,
            workspacePath: "/isolated/reviewer",
            providerId: identity.providerId,
            modelId: identity.modelId,
            policyHash: identity.policyHash,
            requestRef: `live:learning-reviewer:${index}`,
            request: JSON.stringify({
              schema_version: "deepagent-code.learning_review_request.v1",
              candidates: [
                {
                  candidate_id: candidateID,
                  type: "pattern",
                  summary:
                    "The evidence shows that rerunning the relevant package test after an edit caught a regression.",
                  evidence_refs: ["artifact:live-test-result"],
                  source_run_id: `live-reviewer-qualification-${index}`,
                  confidence: 0.9,
                },
              ],
              instructions:
                "Return only a JSON object with verdict (approve, reject, or manual_review) and selected_candidate_ids (string array). Never invent candidates or modify evidence.",
            }),
          })
          if (result.selectedCandidateIds.some((id) => id !== candidateID))
            return yield* Effect.fail(new Error("Reviewer selected an unknown candidate"))
          return {
            verdict: result.verdict,
            selectedCandidateIds: result.selectedCandidateIds,
            policyHash: identity.policyHash,
          }
        }).pipe(Effect.timeout(config.timeoutMs), Effect.exit)
        return Exit.isSuccess(outcome)
          ? { index, status: "passed" as const, latencyMs: Date.now() - startedAt, ...outcome.value }
          : {
              index,
              status: "failed" as const,
              latencyMs: Date.now() - startedAt,
              error: Cause.pretty(outcome.cause).split("\n")[0]?.slice(0, 240),
            }
      }),
    { concurrency: 1 },
  )
}).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(dependencies))))

const outcomes = await Effect.runPromise(program)
const latencies = outcomes.map((outcome) => outcome.latencyMs).sort((a, b) => a - b)
const failed = outcomes.filter((outcome) => outcome.status === "failed")
const suite = runs === 1 ? "learning-reviewer" : "learning-reviewer-soak"
await writeLiveArtifact(
  config,
  suite,
  {
    suite,
    status: failed.length === 0 ? "passed" : "failed",
    fingerprint: modelFingerprint(config),
    preflight,
    reviewerOptIn: process.env.DEEPAGENT_DURABLE_LEARNING_REVIEWER === "true",
    runs,
    failures: failed.length,
    errorRate: failed.length / runs,
    p95LatencyMs: latencies[Math.ceil(runs * 0.95) - 1],
    outcomes,
    completedAt: new Date().toISOString(),
  },
  { harnessFiles: [import.meta.path] },
)
if (failed.length > 0) throw new Error(`learning-reviewer: ${failed.length}/${runs} calls failed`)
console.log(
  `${suite}: passed (${config.providerID}/${config.modelID}, ${runs} calls, p95 ${latencies[Math.ceil(runs * 0.95) - 1]}ms)`,
)
