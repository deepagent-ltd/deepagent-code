import { Effect, Layer } from "effect"
import { AgentExecution } from "@deepagent-code/core/deepagent/agent-execution"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { Database } from "@deepagent-code/core/database/database"

type Input = {
  readonly action: "claim" | "complete" | "get"
  readonly database: string
  readonly now: number
  readonly workspaceID: string
  readonly eventID: string
  readonly taskID: string
  readonly ownerID?: string
  readonly agentID?: string
  readonly generation?: number
  readonly leaseMs?: number
  readonly resources?: ReadonlyArray<string>
  readonly continuationRef?: string
  readonly artifacts?: ReadonlyArray<string>
}

const input = JSON.parse(Bun.argv[2] ?? "{}") as Input
const key = {
  workspaceID: input.workspaceID,
  eventID: input.eventID as DeepAgentEvent.ID,
  taskID: input.taskID,
}

const program = Effect.gen(function* () {
  const execution = yield* AgentExecution.Service
  if (input.action === "get") return yield* execution.get(key)
  if (input.action === "complete") {
    if (!input.ownerID || input.generation === undefined) return false
    return yield* execution.complete({
      ...key,
      ownerID: input.ownerID,
      generation: input.generation,
      ...(input.continuationRef ? { continuationRef: input.continuationRef } : {}),
      ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    })
  }
  if (!input.ownerID || !input.agentID) return { type: "invalid" }
  return yield* execution.claim({
    ...key,
    ownerID: input.ownerID,
    agentID: input.agentID,
    ...(input.leaseMs ? { leaseMs: input.leaseMs } : {}),
    ...(input.resources ? { resources: input.resources } : {}),
  })
})

const result = await Effect.runPromise(
  program.pipe(
    Effect.provide(
      AgentExecution.layerWith({ now: () => input.now }).pipe(
        Layer.provide(Database.layerFromPath(input.database)),
      ),
    ),
  ),
)
console.log(JSON.stringify(result))
