import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { DeepAgentDurableLearning } from "@deepagent-code/core/deepagent/durable-learning"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { LLMClient, LLMEvent } from "@deepagent-code/llm"
import type { LLMClientShape } from "@deepagent-code/llm/route"
import { RequestExecutor, WebSocketExecutor } from "@deepagent-code/llm/route"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { registerLearningReviewerFactory } from "./learning-runtime"

const responseSchema = Schema.Struct({
  verdict: Schema.Literals(["approve", "reject", "manual_review"]),
  selected_candidate_ids: Schema.Array(Schema.String),
})

const responseJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["approve", "reject", "manual_review"] },
    selected_candidate_ids: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "selected_candidate_ids"],
}

// DeepSeek live soak saw intermittent empty text at 1,024; 20/20 calls returned valid JSON at 4,096.
// This is a bounded output allowance, not permission to retry a dispatched durable reviewer.
const maxOutputTokens = 4_096
const temperature = 0

const reviewerRunId = (attemptId: string) => `learning-review-run:${Hash.sha256(attemptId).slice(0, 32)}`

const policyHash = (providerId: string, modelId: string) =>
  Hash.sha256(
    CanonicalJson.stringify({
      version: "deepagent-code.learning-reviewer-policy.v4",
      provider_id: providerId,
      model_id: modelId,
      input: "frozen_candidate_request_only",
      system: [],
      history: false,
      workspace: false,
      released_knowledge: false,
      tools: [],
      temperature,
      max_output_tokens: maxOutputTokens,
      response_schema: responseJsonSchema,
      response_transport: providerId === "openai" ? "json_schema" : "validated_json_text",
      learning: false,
    }),
  )

export function createLearningReviewerPort(input: {
  readonly auth: Pick<Auth.Interface, "get">
  readonly provider: Pick<Provider.Interface, "defaultModel" | "getSmallModel" | "getProvider" | "getModel">
  readonly llmClient: LLMClientShape
}) {
  return {
    identity: (request: { readonly attemptId: string; readonly jobId: string; readonly workspacePath: string }) =>
      Effect.gen(function* () {
        const fallback = yield* input.provider.defaultModel()
        const small = yield* input.provider.getSmallModel(fallback.providerID)
        const providerId = small?.providerID ?? fallback.providerID
        const modelId = small?.id ?? fallback.modelID
        return {
          // The durable schema retains this legacy field name. The value is an opaque reviewer-run
          // identity, not a Session ID: reviewer execution never creates or reads a Session row.
          reviewSessionId: reviewerRunId(request.attemptId),
          providerId,
          modelId,
          policyHash: policyHash(providerId, modelId),
        }
      }),
    execute: (request: {
      readonly attemptId: string
      readonly reviewSessionId: string
      readonly workspacePath: string
      readonly providerId: string
      readonly modelId: string
      readonly policyHash: string
      readonly requestRef: string
      readonly request: string
    }) =>
      Effect.gen(function* () {
        if (request.reviewSessionId !== reviewerRunId(request.attemptId)) {
          return yield* Effect.fail(new Error("isolated reviewer run identity no longer matches its prepared receipt"))
        }
        if (policyHash(request.providerId, request.modelId) !== request.policyHash) {
          return yield* Effect.fail(new Error("isolated reviewer policy no longer matches its prepared receipt"))
        }
        const providerId = ProviderV2.ID.make(request.providerId)
        const modelId = ModelV2.ID.make(request.modelId)
        const provider = yield* input.provider.getProvider(providerId)
        const model = yield* input.provider.getModel(providerId, modelId)
        const auth = yield* input.auth.get(request.providerId)
        const abort = new AbortController()
        const native = LLMNativeRuntime.stream({
          model,
          provider,
          auth,
          llmClient: input.llmClient,
          messages: [{ role: "user", content: request.request }],
          tools: {},
          temperature,
          maxOutputTokens,
          providerOptions: {},
          headers: {},
          abort: abort.signal,
          // Compatible providers such as DeepSeek serve Responses but do not necessarily
          // support constrained text.format. The same schema is validated locally below.
          responseFormat:
            request.providerId === "openai"
              ? { name: "learning_reviewer_response", schema: responseJsonSchema }
              : undefined,
          durableAttempt: true,
        })
        if (native.type === "unsupported") {
          return yield* Effect.fail(new Error(`isolated reviewer native runtime is unavailable: ${native.reason}`))
        }
        const events = yield* native.stream.pipe(Stream.runCollect, Effect.ensuring(Effect.sync(() => abort.abort())))
        const output = Array.from(events)
          .filter(LLMEvent.is.textDelta)
          .map((event) => event.text)
          .join("")
        const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(output)
        if (Option.isNone(decoded)) {
          return yield* Effect.fail(new Error("isolated reviewer returned invalid JSON output"))
        }
        const parsed = Schema.decodeUnknownOption(responseSchema)(decoded.value)
        if (Option.isNone(parsed)) {
          return yield* Effect.fail(new Error("isolated reviewer returned invalid structured output"))
        }
        return {
          verdict: parsed.value.verdict,
          selectedCandidateIds: parsed.value.selected_candidate_ids,
        }
      }),
  } satisfies DeepAgentDurableLearning.ReviewerPort
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const provider = yield* Provider.Service
    const llmClient = yield* LLMClient.Service
    yield* registerLearningReviewerFactory(() => createLearningReviewerPort({ auth, provider, llmClient }))
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(
    LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
  ),
)

export * as LearningReviewerRunner from "./learning-reviewer-runner"
