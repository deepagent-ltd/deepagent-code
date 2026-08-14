export * as DurableLearningRuntime from "./learning-runtime"

import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentDurableLearning } from "@deepagent-code/core/deepagent/durable-learning"
import { DeepAgentLearningLifecycleTrigger } from "@deepagent-code/core/deepagent/learning-lifecycle-trigger"
import { Global } from "@deepagent-code/core/global"
import { Cause, Duration, Effect, Layer, Schedule } from "effect"

const pollInterval = Duration.seconds(1)

type ReviewerFactory = (workspacePath: string) => DeepAgentDurableLearning.ReviewerPort | undefined
const reviewerFactories = new Map<symbol, ReviewerFactory>()

export const registerLearningReviewerFactory = (factory: ReviewerFactory) => {
  const token = Symbol("learning-reviewer-factory")
  reviewerFactories.set(token, factory)
  return () => reviewerFactories.delete(token)
}

function reviewerForWorkspace(workspacePath: string) {
  return [...reviewerFactories.values()]
    .toReversed()
    .map((factory) => factory(workspacePath))
    .find((reviewer) => reviewer !== undefined)
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const owner = `learning-worker:${process.pid}:${crypto.randomUUID()}`
    const tick = Effect.suspend(() =>
      DeepAgentDurableLearning.drain(database.db, {
        owner,
        authorityRoot: Global.Path.agent.data,
        reviewerForWorkspace,
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("durable learning worker tick failed", { cause: Cause.pretty(cause) }).pipe(Effect.as([])),
      ),
    )

    AgentGateway.setLearningAuthority({
      record: (admission) =>
        Effect.runPromise(DeepAgentDurableLearning.record(database.db, admission).pipe(Effect.asVoid)),
      enqueue: (admission) =>
        Effect.runPromise(
          DeepAgentDurableLearning.admit(database.db, admission, {
            authorityRoot: Global.Path.agent.data,
          }).pipe(Effect.asVoid),
        ),
    })
    DeepAgentLearningLifecycleTrigger.setRuntimeObserver({
      observe: (input) =>
        Effect.runPromise(
          DeepAgentLearningLifecycleTrigger.observe(database.db, input, {
            authorityRoot: Global.Path.agent.data,
            runsDir: Global.Path.agent.runs,
          }),
        ),
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        AgentGateway.setLearningAuthority(undefined)
        DeepAgentLearningLifecycleTrigger.setRuntimeObserver(undefined)
      }),
    )

    yield* DeepAgentLearningLifecycleTrigger.recover(database.db, { authorityRoot: Global.Path.agent.data }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("durable learning lifecycle recovery failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.as([]),
        ),
      ),
    )
    yield* tick
    yield* tick.pipe(Effect.repeat(Schedule.spaced(pollInterval)), Effect.forkScoped)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
