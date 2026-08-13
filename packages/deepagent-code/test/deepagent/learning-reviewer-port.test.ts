import { expect, test } from "bun:test"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Effect, Exit } from "effect"
import { Agent } from "@/agent/agent"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { createLearningReviewerPort, SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"

test("isolated reviewer creates its session only after durable identity preparation", async () => {
  const workspacePath = "/workspace/learning-reviewer"
  const state: {
    session?: Session.Info
    createCalls: number
    promptCalls: number
  } = {
    createCalls: 0,
    promptCalls: 0,
  }
  const reviewer: Agent.Info = {
    name: "reviewer",
    mode: "subagent",
    permission: [],
    options: {},
  }
  const port = createLearningReviewerPort({
    agents: {
      get: () => Effect.succeed(reviewer),
    } as unknown as Agent.Interface,
    provider: {
      defaultModel: () =>
        Effect.succeed({
          providerID: ProviderV2.ID.make("test-provider"),
          modelID: ModelV2.ID.make("test-model"),
        }),
    } as unknown as Provider.Interface,
    sessions: {
      get: (id: SessionID) =>
        state.session?.id === id
          ? Effect.succeed(state.session)
          : Effect.fail(new NotFoundError({ message: `Session not found: ${id}` })),
      create: (input?: Parameters<Session.Interface["create"]>[0]) =>
        Effect.sync(() => {
          state.createCalls += 1
          state.session = {
            id: input?.id!,
            slug: "learning-reviewer",
            projectID: "project-learning-reviewer",
            directory: input?.directory!,
            title: input?.title!,
            version: "test",
            agent: input?.agent,
            model: input?.model,
            metadata: input?.metadata,
            permission: input?.permission,
            time: { created: 1, updated: 1 },
          } as Session.Info
          return state.session
        }),
    } as unknown as Session.Interface,
    prompt: {
      resolvePromptParts: (request: string) => Effect.succeed([{ type: "text", text: request }]),
      prompt: () =>
        Effect.sync(() => {
          state.promptCalls += 1
          return {
            info: {
              role: "assistant",
              structured: { verdict: "approve", selected_candidate_ids: ["candidate-1"] },
            },
            parts: [],
          } as unknown as SessionV1.WithParts
        }),
    } as unknown as SessionPrompt.Interface,
    instances: {
      provide: <A, E, R>(_input: InstanceStore.LoadInput, effect: Effect.Effect<A, E, R>) => effect,
    } as unknown as InstanceStore.Interface,
  })

  const identity = await Effect.runPromise(port.identity({ attemptId: "review:job-1", jobId: "job-1", workspacePath }))
  expect(state.createCalls).toBe(0)
  expect(state.promptCalls).toBe(0)

  const rejected = await Effect.runPromise(
    port
      .execute({
        attemptId: "review:job-1",
        reviewSessionId: identity.reviewSessionId,
        workspacePath,
        providerId: identity.providerId,
        modelId: identity.modelId,
        policyHash: "0".repeat(64),
        requestRef: "artifact:request",
        request: "Review candidate-1",
      })
      .pipe(Effect.exit),
  )
  expect(Exit.isFailure(rejected)).toBe(true)
  expect(state.createCalls).toBe(0)
  expect(state.promptCalls).toBe(0)

  const result = await Effect.runPromise(
    port.execute({
      attemptId: "review:job-1",
      reviewSessionId: identity.reviewSessionId,
      workspacePath,
      providerId: identity.providerId,
      modelId: identity.modelId,
      policyHash: identity.policyHash,
      requestRef: "artifact:request",
      request: "Review candidate-1",
    }),
  )
  expect(result).toEqual({ verdict: "approve", selectedCandidateIds: ["candidate-1"] })
  expect(state.createCalls).toBe(1)
  expect(state.promptCalls).toBe(1)
  expect(state.session).toMatchObject({
    id: identity.reviewSessionId,
    directory: workspacePath,
    agent: "reviewer",
    model: { providerID: identity.providerId, id: identity.modelId },
    metadata: { deepagent: { learning_reviewer_attempt_id: "review:job-1" } },
  })
})
