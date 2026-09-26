import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { AgentExecution } from "@deepagent-code/core/deepagent/agent-execution"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { HandoffAdmission } from "@deepagent-code/core/deepagent/handoff-admission"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { SecurityResolvers } from "@deepagent-code/core/deepagent/security-resolvers"
import { TaskPartitioner } from "@deepagent-code/core/deepagent/task-partitioner"
import { Database } from "@deepagent-code/core/database/database"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { AgentHandoffConsumer, HANDOFF_GROUP } from "@/session/agent-handoff-consumer"
import { MultiAgentRuntime } from "@/session/multi-agent-runtime"
import type { SubagentTurnRunner } from "@/session/goal-loop-wiring"
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

const registry = Layer.succeed(AgentListProviderService, {
  listAgents: () => Effect.succeed(agents),
  findByTrigger: () => Effect.succeed([]),
  findByCapability: () => Effect.succeed([]),
})

const makeLayer = (runtimeAllowed: boolean, runLoop = false) => {
  const database = Database.layerFromPath(":memory:")
  const core = Layer.mergeAll(
    DeepAgentEventBus.layer,
    AgentExecution.layer,
    HandoffAdmission.layer,
    ApprovalQueue.layer,
  ).pipe(Layer.provideMerge(database))
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

  allowed.effect("owner A failure transfers through the consumer and owner B continues the assigned task", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const execution = yield* AgentExecution.Service
      const queue = yield* ApprovalQueue.Service
      const consumer = yield* AgentHandoffConsumer.Service
      yield* bus.registerConsumerGroup(HANDOFF_GROUP, LMNEvents.AGENT_HANDOFF_REQUESTED)
      const original = yield* bus.publish({
        type: "ci.failure",
        source: "ci",
        workspaceID: "wrk_handoff_integration",
        idempotencyKey: "handoff-integration",
        priority: "normal",
        payload: { directory: "/tmp/handoff-integration", files: ["src/a.ts"] },
      })
      const fixTaskID = TaskPartitioner.partition(original, { stableIDPrefix: original.id }).subtasks[0].id
      const dependencies = Layer.mergeAll(
        Layer.succeed(DeepAgentEventBus.Service, bus),
        Layer.succeed(AgentExecution.Service, execution),
        Layer.succeed(ApprovalQueue.Service, queue),
        registry,
      )
      const runtime = (ownerID: string, runner: SubagentTurnRunner) =>
        Layer.build(
          MultiAgentRuntime.layerWith({
            execution,
            ownerID,
            runner,
            dagCoordination: true,
          }).pipe(Layer.provide(dependencies)),
        ).pipe(Effect.map((context) => Context.get(context, MultiAgentRuntime.Service)))
      const first = yield* runtime("runtime_a", () =>
        Effect.succeed({
          ok: false,
          reason: "runner_failed",
          structured: undefined,
          text: "",
          tokensUsed: 0,
          cost: 0,
          continuationRef: "agent/partial",
        }),
      )
      const resumed: { agentType: string; baseRef?: string; generation?: number }[] = []
      const second = yield* runtime("runtime_b", (input) =>
        Effect.sync(() => {
          resumed.push({ agentType: input.agentType, baseRef: input.baseRef, generation: input.generation })
          return {
            ok: true,
            structured: undefined,
            text: "repaired",
            tokensUsed: 0,
            cost: 0,
            continuationRef: "agent/final",
          }
        }),
      )
      const pending = yield* first.coordinate(original)
      expect(pending.outcomes[0]).toMatchObject({ status: "deferred", reason: "handoff_requested" })
      expect(pending.hasUnfinished).toBe(true)
      const handoffs = yield* bus.recentByType({
        type: LMNEvents.AGENT_HANDOFF_REQUESTED,
        now: Date.now(),
        windowMs: 60_000,
      })
      expect(handoffs).toHaveLength(1)
      expect(yield* consumer.handle(handoffs[0])).toBe("accepted")
      expect(
        (yield* execution.get({ workspaceID: original.workspaceID, eventID: original.id, taskID: fixTaskID }))
          ?.assignedAgentID,
      ).toBe("agent_b")
      const finished = yield* second.coordinate(original)
      expect(finished.outcomes.map((outcome) => outcome.status)).toEqual(["completed", "completed"])
      expect(resumed[0]).toEqual({ agentType: "agent_b", baseRef: "agent/partial", generation: 2 })
      expect(
        (yield* execution.get({ workspaceID: original.workspaceID, eventID: original.id, taskID: fixTaskID }))
          ?.continuationRef,
      ).toBe("agent/final")
      expect((yield* second.coordinate(original)).outcomes[0]).toMatchObject({
        status: "completed",
        reason: "already_completed",
      })
      expect(resumed).toHaveLength(2)
    }),
  )

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

  allowed.effect("writes a durable admission receipt and settles it processing → accepted", () =>
    Effect.gen(function* () {
      const input = yield* seed
      const consumer = yield* AgentHandoffConsumer.Service
      const admission = yield* HandoffAdmission.Service
      expect(yield* consumer.handle(input.event)).toBe("accepted")
      const receipt = yield* admission.get("handoff_1")
      expect(receipt?.state).toBe("accepted")
      expect(receipt?.eventID).toBe(input.event.id)
      expect(receipt?.workspaceID).toBe(input.original.workspaceID)
      expect(receipt?.settledAt != null).toBe(true)
      // a redelivery short-circuits on the TERMINAL receipt: still accepted, receipt untouched.
      expect(yield* consumer.handle(input.event)).toBe("accepted")
      const after = yield* admission.get("handoff_1")
      expect(after?.state).toBe("accepted")
      expect(after?.settledAt).toBe(receipt?.settledAt)
    }),
  )

  allowed.effect("retry pump claims due deliveries atomically — a second claimant sees nothing", () =>
    Effect.gen(function* () {
      const input = yield* seed
      const bus = yield* DeepAgentEventBus.Service
      const at = input.event.createdAt + 1
      const first = yield* bus.claimDue({ subscriptionGroup: HANDOFF_GROUP, claimantId: "claimant_a", now: at })
      expect(first.deliveries.map((delivery) => delivery.eventID)).toContain(input.event.id)
      // lease live → the same row is invisible to a competing claimant (RISK-001 mutual exclusion).
      const second = yield* bus.claimDue({ subscriptionGroup: HANDOFF_GROUP, claimantId: "claimant_b", now: at })
      expect(second.deliveries.length).toBe(0)
    }),
  )

  allowed.effect("ack/nack are claim-token conditioned — a stale token cannot settle the delivery", () =>
    Effect.gen(function* () {
      const input = yield* seed
      const bus = yield* DeepAgentEventBus.Service
      const at = input.event.createdAt + 1
      const claim = yield* bus.claimDue({ subscriptionGroup: HANDOFF_GROUP, claimantId: "claimant_a", now: at })
      expect(claim.deliveries.length).toBe(1)
      const wrong = { subscriptionGroup: HANDOFF_GROUP, eventID: input.event.id }
      // a stale/forged token settles nothing.
      expect(yield* bus.ackClaim({ ...wrong, claimToken: "not-the-token" })).toBe(false)
      expect(yield* bus.nackClaim({ ...wrong, claimToken: "not-the-token", reason: "stale" })).toBe(false)
      // the owning token settles exactly once; afterwards the same token is stale too.
      expect(yield* bus.ackClaim({ ...wrong, claimToken: claim.claimToken })).toBe(true)
      expect(yield* bus.ackClaim({ ...wrong, claimToken: claim.claimToken })).toBe(false)
      expect(yield* bus.nackClaim({ ...wrong, claimToken: claim.claimToken, reason: "after settle" })).toBe(false)
    }),
  )

  allowed.effect("crash recovery: an expired lease re-claims and a processing receipt is re-admitted", () =>
    Effect.gen(function* () {
      const input = yield* seed
      const bus = yield* DeepAgentEventBus.Service
      const admission = yield* HandoffAdmission.Service
      const consumer = yield* AgentHandoffConsumer.Service
      const execution = yield* AgentExecution.Service
      const at = input.event.createdAt + 1
      // The crashed worker claimed the delivery AND stamped its admission `processing`, then died
      // before settling either. Both records stay exactly as the crash left them.
      yield* bus.claimDue({ subscriptionGroup: HANDOFF_GROUP, claimantId: "crashed_worker", now: at })
      yield* admission.begin({
        handoffID: "handoff_1",
        eventID: input.event.id,
        workspaceID: input.original.workspaceID,
        claimantID: "crashed_worker",
        at,
      })
      expect((yield* admission.get("handoff_1"))?.state).toBe("processing")
      // While the lease is live the pump must NOT re-drive the in-flight handoff.
      expect(yield* consumer.pumpRetries(at + 1)).toBe(0)
      expect((yield* admission.get("handoff_1"))?.state).toBe("processing")
      // Once the lease lapses the row is re-claimable: `processing` means "not finished", so the
      // pump re-admits it and settles the receipt to its terminal state.
      expect(yield* consumer.pumpRetries(at + 5 * 60_000 + 1)).toBe(1)
      const receipt = yield* admission.get("handoff_1")
      expect(receipt?.state).toBe("accepted")
      expect(receipt?.claimantID !== "crashed_worker").toBe(true)
      const transferred = yield* execution.get({
        workspaceID: input.original.workspaceID,
        eventID: input.original.id,
        taskID: input.task.id,
      })
      expect(transferred?.status).toBe("available")
      expect(transferred?.assignedAgentID).toBe("agent_b")
      // the delivery was acked under the claim — nothing due remains.
      expect(yield* consumer.pumpRetries(at + 10 * 60_000)).toBe(0)
    }),
  )

  denied.effect("settles the admission receipt processing → rejected with the reject reason", () =>
    Effect.gen(function* () {
      const input = yield* seed
      const consumer = yield* AgentHandoffConsumer.Service
      const admission = yield* HandoffAdmission.Service
      expect(yield* consumer.handle(input.event)).toBe("rejected")
      const receipt = yield* admission.get("handoff_1")
      expect(receipt?.state).toBe("rejected")
      expect(receipt?.reason).toBe("handoff_security_runtime_operation")
      // a terminal reject is sticky across redelivery.
      expect(yield* consumer.handle(input.event)).toBe("rejected")
      expect((yield* admission.get("handoff_1"))?.state).toBe("rejected")
    }),
  )
})
