import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentExecution } from "@deepagent-code/core/deepagent/agent-execution"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { SecurityResolvers } from "@deepagent-code/core/deepagent/security-resolvers"
import { TaskPartitioner } from "@deepagent-code/core/deepagent/task-partitioner"
import { Database } from "@deepagent-code/core/database/database"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { AgentHandoffConsumer, HANDOFF_GROUP } from "@/session/agent-handoff-consumer"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { pollWithTimeout, testEffect } from "../lib/effect"

const agents: AgentDescriptor[] = [
  {
    id: "agent_a",
    name: "agent_a",
    displayName: "agent_a",
    visible: true,
    autonomy: "level_2",
    capabilities: ["code_edit", "test_run"],
  },
  {
    id: "agent_b",
    name: "agent_b",
    displayName: "agent_b",
    visible: true,
    autonomy: "level_2",
    capabilities: ["code_edit", "test_run"],
  },
]

const makeLayer = (runtimeAllowed: boolean, runLoop = false) => {
  const database = Database.layerFromPath(":memory:")
  const core = Layer.mergeAll(DeepAgentEventBus.layer, AgentExecution.layer).pipe(Layer.provideMerge(database))
  const registry = Layer.succeed(AgentListProviderService, {
    listAgents: () => Effect.succeed(agents),
    findByTrigger: () => Effect.succeed([]),
    findByCapability: () => Effect.succeed([]),
  })
  const security = Layer.succeed(SecurityResolvers.Service, {
    resolveTrustedSources: () => Effect.succeed(["ci"] as const),
    actorHasWorkspacePermission: () => Effect.succeed(true),
    runtimeAllowsOperation: () => Effect.succeed(runtimeAllowed),
  })
  const consumer = AgentHandoffConsumer.layerWith({ runLoop }).pipe(
    Layer.provide(core),
    Layer.provide(registry),
    Layer.provide(security),
    Layer.provide(RuntimeFlags.layer({ v4MultiAgentRuntime: true })),
  )
  return Layer.mergeAll(core, consumer)
}

const seed = Effect.gen(function* () {
  const bus = yield* DeepAgentEventBus.Service
  const execution = yield* AgentExecution.Service
  yield* bus.registerConsumerGroup(HANDOFF_GROUP, LMNEvents.AGENT_HANDOFF_REQUESTED)
  const original = yield* bus.publish({
    type: "ci.failure",
    source: "ci",
    workspaceID: "wrk_1",
    idempotencyKey: "original-ci-failure",
    priority: "normal",
    payload: { files: ["src/a.ts"] },
  })
  const task = TaskPartitioner.partition(original, { stableIDPrefix: original.id }).subtasks[0]
  if (!task) return yield* Effect.die("partition did not produce a task")
  const claim = yield* execution.claim({
    workspaceID: original.workspaceID,
    eventID: original.id,
    taskID: task.id,
    ownerID: "runtime_a",
    agentID: "agent_a",
  })
  if (claim.type !== "claimed") return yield* Effect.die("initial execution claim failed")
  const handoffID = "handoff_1"
  const pending = yield* execution.prepareHandoff({
    workspaceID: original.workspaceID,
    eventID: original.id,
    taskID: task.id,
    ownerID: "runtime_a",
    generation: claim.record.generation,
    handoffID,
    toAgentID: "agent_b",
    reason: "runner_failed",
    continuationRef: "agent/partial",
  })
  if (!pending) return yield* Effect.die("handoff preparation failed")
  const event = yield* bus.publish({
    type: LMNEvents.AGENT_HANDOFF_REQUESTED,
    source: "system",
    workspaceID: original.workspaceID,
    correlationID: original.id,
    causationID: original.id,
    idempotencyKey: `handoff:${handoffID}`,
    priority: "normal",
    payload: {
      type: LMNEvents.AGENT_HANDOFF_REQUESTED,
      handoffID,
      eventID: original.id,
      taskID: task.id,
      fromAgentID: "agent_a",
      toAgentID: "agent_b",
      generation: claim.record.generation,
      reason: "runner_failed",
      continuationRef: "agent/partial",
    },
  })
  return { original, task, event, generation: claim.record.generation }
})

describe("AgentHandoffConsumer", () => {
  const allowed = testEffect(makeLayer(true))
  const denied = testEffect(makeLayer(false))
  const daemon = testEffect(makeLayer(true, true))

  allowed.effect("validates, atomically transfers, acks, and idempotently accepts redelivery", () =>
    Effect.gen(function* () {
      const input = yield* seed
      const consumer = yield* AgentHandoffConsumer.Service
      const execution = yield* AgentExecution.Service
      expect(yield* consumer.handle(input.event)).toBe("accepted")
      const transferred = yield* execution.get({
        workspaceID: input.original.workspaceID,
        eventID: input.original.id,
        taskID: input.task.id,
      })
      expect(transferred?.status).toBe("available")
      expect(transferred?.assignedAgentID).toBe("agent_b")
      expect(transferred?.continuationRef).toBe("agent/partial")
      expect(yield* consumer.handle(input.event)).toBe("accepted")
      expect(
        (yield* execution.get({
          workspaceID: input.original.workspaceID,
          eventID: input.original.id,
          taskID: input.task.id,
        }))?.generation,
      ).toBe(input.generation)
    }),
  )

  denied.effect("fails closed on runtime permission and discharges the permanent request", () =>
    Effect.gen(function* () {
      const input = yield* seed
      const consumer = yield* AgentHandoffConsumer.Service
      const execution = yield* AgentExecution.Service
      expect(yield* consumer.handle(input.event)).toBe("rejected")
      const rejected = yield* execution.get({
        workspaceID: input.original.workspaceID,
        eventID: input.original.id,
        taskID: input.task.id,
      })
      expect(rejected?.status).toBe("failed")
      expect(rejected?.lastError).toBe("handoff_security_runtime_operation")
      expect(
        (yield* (yield* DeepAgentEventBus.Service).dueRetries(input.event.createdAt + 1)).some(
          (delivery) => delivery.subscriptionGroup === HANDOFF_GROUP && delivery.eventID === input.event.id,
        ),
      ).toBe(false)
    }),
  )

  daemon.live("the scoped production loop consumes a published handoff without a direct handle call", () =>
    Effect.gen(function* () {
      const input = yield* seed
      const execution = yield* AgentExecution.Service
      const transferred = yield* pollWithTimeout(
        execution
          .get({
            workspaceID: input.original.workspaceID,
            eventID: input.original.id,
            taskID: input.task.id,
          })
          .pipe(Effect.map((record) => (record?.status === "available" ? record : undefined))),
        "handoff daemon did not transfer the pending execution",
      )
      expect(transferred.assignedAgentID).toBe("agent_b")
      expect(transferred.continuationRef).toBe("agent/partial")
      expect(
        (yield* (yield* DeepAgentEventBus.Service).dueRetries(input.event.createdAt + 1)).some(
          (delivery) => delivery.subscriptionGroup === HANDOFF_GROUP && delivery.eventID === input.event.id,
        ),
      ).toBe(false)
    }),
  )
})
