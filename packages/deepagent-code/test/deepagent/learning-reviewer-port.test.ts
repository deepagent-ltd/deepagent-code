import { expect, test } from "bun:test"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { LLMEvent, type LLMRequest } from "@deepagent-code/llm"
import type { LLMClientShape } from "@deepagent-code/llm/route"
import { Effect, Exit, Stream } from "effect"
import { createLearningReviewerPort } from "@/deepagent/learning-reviewer-runner"
import type { Provider } from "@/provider/provider"

const model: Provider.Model = {
  id: ModelV2.ID.make("gpt-reviewer"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "gpt-reviewer",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "Reviewer",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const providerInfo: Provider.Info = {
  id: model.providerID,
  name: "OpenAI",
  source: "config",
  env: ["OPENAI_API_KEY"],
  options: { apiKey: "test-key" },
  models: { [model.id]: model },
}

test("reviewer uses one frozen native request without Session, workspace, tools, history, or knowledge", async () => {
  const state: { requests: LLMRequest[]; modelLookups: number } = { requests: [], modelLookups: 0 }
  const llmClient = {
    prepare: () => Effect.die("reviewer does not prepare outside the stream dispatch"),
    stream: (request: LLMRequest) => {
      state.requests.push(request)
      return Stream.make(
        LLMEvent.textDelta({
          id: "review-output",
          text: '{"verdict":"approve","selected_candidate_ids":["candidate-1"]}',
        }),
        LLMEvent.finish({ reason: "stop" }),
      )
    },
    generate: () => Effect.die("reviewer uses the native stream transport"),
  } as LLMClientShape
  const provider = {
    defaultModel: () => Effect.succeed({ providerID: model.providerID, modelID: model.id }),
    getSmallModel: () => Effect.succeed(undefined),
    getProvider: () => Effect.succeed(providerInfo),
    getModel: () =>
      Effect.sync(() => {
        state.modelLookups += 1
        return model
      }),
  }
  const port = createLearningReviewerPort({
    auth: { get: () => Effect.succeed(undefined) },
    provider,
    llmClient,
  })
  const request =
    '{"schema_version":"deepagent-code.learning_review_request.v1","candidates":[{"candidate_id":"candidate-1"}]}'

  const identity = await Effect.runPromise(
    port.identity({ attemptId: "review:job-1", jobId: "job-1", workspacePath: "/workspace/private" }),
  )
  expect(identity.reviewSessionId).toStartWith("learning-review-run:")
  expect(state.requests).toHaveLength(0)
  expect(state.modelLookups).toBe(0)

  const rejected = await Effect.runPromise(
    port
      .execute({
        attemptId: "review:job-1",
        reviewSessionId: identity.reviewSessionId,
        workspacePath: "/workspace/private",
        providerId: identity.providerId,
        modelId: identity.modelId,
        policyHash: "0".repeat(64),
        requestRef: "artifact:request",
        request,
      })
      .pipe(Effect.exit),
  )
  expect(Exit.isFailure(rejected)).toBe(true)
  expect(state.requests).toHaveLength(0)
  expect(state.modelLookups).toBe(0)

  const result = await Effect.runPromise(
    port.execute({
      attemptId: "review:job-1",
      reviewSessionId: identity.reviewSessionId,
      workspacePath: "/workspace/private",
      providerId: identity.providerId,
      modelId: identity.modelId,
      policyHash: identity.policyHash,
      requestRef: "artifact:request",
      request,
    }),
  )
  expect(result).toEqual({ verdict: "approve", selectedCandidateIds: ["candidate-1"] })
  expect(state.modelLookups).toBe(1)
  expect(state.requests).toHaveLength(1)
  expect(state.requests[0].system).toEqual([])
  expect(state.requests[0].messages).toEqual([
    { role: "user", content: [{ type: "text", text: request }], id: undefined, metadata: undefined, native: undefined },
  ])
  expect(state.requests[0].tools).toEqual([])
  expect(state.requests[0].generation?.temperature).toBe(0)
  expect(state.requests[0].metadata).toBeUndefined()
  expect(state.requests[0].responseFormat).toMatchObject({ type: "json", name: "learning_reviewer_response" })
  expect(JSON.stringify(state.requests[0])).not.toContain("/workspace/private")
})

test("reviewer rejects a mismatched durable run identity before model dispatch", async () => {
  let calls = 0
  const port = createLearningReviewerPort({
    auth: { get: () => Effect.succeed(undefined) },
    provider: {
      defaultModel: () => Effect.succeed({ providerID: model.providerID, modelID: model.id }),
      getSmallModel: () => Effect.succeed(undefined),
      getProvider: () => Effect.succeed(providerInfo),
      getModel: () =>
        Effect.sync(() => {
          calls += 1
          return model
        }),
    },
    llmClient: {
      prepare: () => Effect.die("unexpected prepare"),
      stream: () => Stream.die("unexpected dispatch"),
      generate: () => Effect.die("unexpected generate"),
    } as LLMClientShape,
  })
  const identity = await Effect.runPromise(
    port.identity({ attemptId: "review:job-2", jobId: "job-2", workspacePath: "/workspace/private" }),
  )
  const outcome = await Effect.runPromise(
    port
      .execute({
        attemptId: "review:job-2",
        reviewSessionId: "learning-review-run:tampered",
        workspacePath: "/workspace/private",
        providerId: identity.providerId,
        modelId: identity.modelId,
        policyHash: identity.policyHash,
        requestRef: "artifact:request",
        request: "{}",
      })
      .pipe(Effect.exit),
  )
  expect(Exit.isFailure(outcome)).toBe(true)
  expect(calls).toBe(0)
})

test("reviewer freezes the configured small model into its durable identity", async () => {
  const small = { ...model, id: ModelV2.ID.make("gpt-small-reviewer") }
  const port = createLearningReviewerPort({
    auth: { get: () => Effect.succeed(undefined) },
    provider: {
      defaultModel: () => Effect.succeed({ providerID: model.providerID, modelID: model.id }),
      getSmallModel: () => Effect.succeed(small),
      getProvider: () => Effect.succeed(providerInfo),
      getModel: () => Effect.succeed(small),
    },
    llmClient: {
      prepare: () => Effect.die("unexpected prepare"),
      stream: () => Stream.die("unexpected dispatch"),
      generate: () => Effect.die("unexpected generate"),
    } as LLMClientShape,
  })
  const identity = await Effect.runPromise(
    port.identity({ attemptId: "review:small", jobId: "job-small", workspacePath: "/workspace/private" }),
  )
  expect(identity.providerId).toBe(small.providerID)
  expect(identity.modelId).toBe(small.id)
  expect(identity.policyHash).toMatch(/^[a-f0-9]{64}$/)
})

test("DeepSeek reviewer validates JSON locally without unsupported wire text.format", async () => {
  const deepseek = {
    ...model,
    id: ModelV2.ID.make("deepseek-flash"),
    providerID: ProviderV2.ID.make("deepseek"),
    api: { id: "deepseek-flash", url: "https://api.deepseek.com", npm: "@ai-sdk/openai-compatible" },
  }
  const requests: LLMRequest[] = []
  const port = createLearningReviewerPort({
    auth: { get: () => Effect.succeed(undefined) },
    provider: {
      defaultModel: () => Effect.succeed({ providerID: deepseek.providerID, modelID: deepseek.id }),
      getSmallModel: () => Effect.succeed(deepseek),
      getProvider: () => Effect.succeed({ ...providerInfo, id: deepseek.providerID, models: { [deepseek.id]: deepseek } }),
      getModel: () => Effect.succeed(deepseek),
    },
    llmClient: {
      prepare: () => Effect.die("unexpected prepare"),
      stream: (request: LLMRequest) => {
        requests.push(request)
        return Stream.make(
          LLMEvent.textDelta({ id: "review-output", text: '{"verdict":"reject","selected_candidate_ids":[]}' }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
      generate: () => Effect.die("unexpected generate"),
    } as LLMClientShape,
  })
  const identity = await Effect.runPromise(
    port.identity({ attemptId: "review:deepseek", jobId: "job-deepseek", workspacePath: "/private" }),
  )
  expect(
    await Effect.runPromise(
      port.execute({
        attemptId: "review:deepseek",
        reviewSessionId: identity.reviewSessionId,
        workspacePath: "/private",
        providerId: identity.providerId,
        modelId: identity.modelId,
        policyHash: identity.policyHash,
        requestRef: "artifact:request",
        request: '{"candidates":[]}',
      }),
    ),
  ).toEqual({ verdict: "reject", selectedCandidateIds: [] })
  expect(requests).toHaveLength(1)
  expect(requests[0].responseFormat).toBeUndefined()
  expect(requests[0].system).toEqual([])
  expect(requests[0].tools).toEqual([])
})
