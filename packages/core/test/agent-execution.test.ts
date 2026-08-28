import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentExecution } from "@deepagent-code/core/deepagent/agent-execution"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "./lib/effect"

let clock = 1_000
const now = () => clock
const setNow = (value: number) => {
  clock = value
}

const database = Database.layerFromPath(":memory:")
const it = testEffect(AgentExecution.layerWith({ now }).pipe(Layer.provideMerge(database)))
const eventID = DeepAgentEvent.ID.create(1_000)
const key = { workspaceID: "wrk_1", eventID, taskID: "task_1" }

describe("AgentExecution durable ownership", () => {
  it.effect("excludes a second owner until expiry, then advances the generation", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const execution = yield* AgentExecution.Service
      const first = yield* execution.claim({ ...key, ownerID: "worker_a", agentID: "agent_a", leaseMs: 100 })
      expect(first.type).toBe("claimed")
      if (first.type !== "claimed") return
      expect(first.record.generation).toBe(1)

      const busy = yield* execution.claim({ ...key, ownerID: "worker_b", agentID: "agent_a", leaseMs: 100 })
      expect(busy.type).toBe("busy")

      setNow(1_101)
      const recovered = yield* execution.claim({ ...key, ownerID: "worker_b", agentID: "agent_a", leaseMs: 100 })
      expect(recovered.type).toBe("claimed")
      if (recovered.type !== "claimed") return
      expect(recovered.record.generation).toBe(2)
      expect(recovered.record.ownerID).toBe("worker_b")

      expect(yield* execution.complete({ ...key, ownerID: "worker_a", generation: first.record.generation })).toBe(
        false,
      )
      expect(yield* execution.complete({ ...key, ownerID: "worker_b", generation: recovered.record.generation })).toBe(
        true,
      )
    }),
  )

  it.effect("enforces resource locks across independent tasks and releases them on settle", () =>
    Effect.gen(function* () {
      setNow(2_000)
      const execution = yield* AgentExecution.Service
      const first = yield* execution.claim({
        ...key,
        ownerID: "worker_a",
        agentID: "agent_a",
        resources: ["file:src/shared.ts"],
      })
      expect(first.type).toBe("claimed")
      if (first.type !== "claimed") return

      const other = { ...key, taskID: "task_2" }
      expect(
        (yield* execution.claim({
          ...other,
          ownerID: "worker_b",
          agentID: "agent_b",
          resources: ["file:src/shared.ts"],
        })).type,
      ).toBe("resource_locked")

      expect(
        yield* execution.release({
          ...key,
          ownerID: "worker_a",
          generation: first.record.generation,
          retryable: false,
          reason: "done",
        }),
      ).toBe(true)
      expect(
        (yield* execution.claim({
          ...other,
          ownerID: "worker_b",
          agentID: "agent_b",
          resources: ["file:src/shared.ts"],
        })).type,
      ).toBe("claimed")
    }),
  )

  it.effect("transfers a pending handoff only for its exact generation and target", () =>
    Effect.gen(function* () {
      setNow(3_000)
      const execution = yield* AgentExecution.Service
      const first = yield* execution.claim({ ...key, ownerID: "worker_a", agentID: "agent_a" })
      expect(first.type).toBe("claimed")
      if (first.type !== "claimed") return

      const pending = yield* execution.prepareHandoff({
        ...key,
        ownerID: "worker_a",
        generation: first.record.generation,
        handoffID: "handoff_1",
        toAgentID: "agent_b",
        reason: "runner_failed",
        continuationRef: "agent/partial",
      })
      expect(pending?.status).toBe("handoff_pending")
      expect(
        yield* execution.acceptHandoff({
          ...key,
          handoffID: "handoff_1",
          generation: first.record.generation + 1,
          fromAgentID: "agent_a",
          toAgentID: "agent_b",
        }),
      ).toBe(false)
      expect(
        yield* execution.acceptHandoff({
          ...key,
          handoffID: "handoff_1",
          generation: first.record.generation,
          fromAgentID: "agent_a",
          toAgentID: "agent_b",
        }),
      ).toBe(true)

      expect((yield* execution.claim({ ...key, ownerID: "worker_c", agentID: "agent_a" })).type).toBe(
        "assigned_elsewhere",
      )
      const claimed = yield* execution.claim({ ...key, ownerID: "worker_c", agentID: "agent_b" })
      expect(claimed.type).toBe("claimed")
      if (claimed.type !== "claimed") return
      expect(claimed.record.generation).toBe(first.record.generation + 1)
      expect(claimed.record.continuationRef).toBe("agent/partial")
    }),
  )

  it.effect("persists token debits in fixed workspace-agent windows", () =>
    Effect.gen(function* () {
      const execution = yield* AgentExecution.Service
      yield* execution.debitTokens({ workspaceID: "wrk_1", agentID: "agent_a", tokens: 7, at: 4_100, windowMs: 1_000 })
      yield* execution.debitTokens({ workspaceID: "wrk_1", agentID: "agent_a", tokens: 5, at: 4_900, windowMs: 1_000 })
      expect(
        yield* execution.tokensUsed({ workspaceID: "wrk_1", agentID: "agent_a", at: 4_500, windowMs: 1_000 }),
      ).toBe(12)
      expect(
        yield* execution.tokensUsed({ workspaceID: "wrk_1", agentID: "agent_a", at: 5_000, windowMs: 1_000 }),
      ).toBe(0)
    }),
  )

  it.effect("atomically debits failed and handed-off turns before releasing ownership", () =>
    Effect.gen(function* () {
      setNow(6_000)
      const execution = yield* AgentExecution.Service
      const failed = { ...key, taskID: "failed_tokens" }
      const failedClaim = yield* execution.claim({ ...failed, ownerID: "worker_a", agentID: "agent_a" })
      expect(failedClaim.type).toBe("claimed")
      if (failedClaim.type !== "claimed") return
      expect(
        yield* execution.release({
          ...failed,
          ownerID: "worker_a",
          generation: failedClaim.record.generation,
          retryable: true,
          reason: "provider_error",
          tokensUsed: 11,
          tokenAt: 6_000,
          tokenWindowMs: 1_000,
        }),
      ).toBe(true)

      const handedOff = { ...key, taskID: "handoff_tokens" }
      const handoffClaim = yield* execution.claim({ ...handedOff, ownerID: "worker_b", agentID: "agent_a" })
      expect(handoffClaim.type).toBe("claimed")
      if (handoffClaim.type !== "claimed") return
      expect(
        yield* execution.prepareHandoff({
          ...handedOff,
          ownerID: "worker_b",
          generation: handoffClaim.record.generation,
          handoffID: "handoff_tokens_1",
          toAgentID: "agent_b",
          reason: "runner_failed",
          tokensUsed: 7,
          tokenAt: 6_100,
          tokenWindowMs: 1_000,
        }),
      ).toMatchObject({ status: "handoff_pending" })
      expect(
        yield* execution.tokensUsed({ workspaceID: "wrk_1", agentID: "agent_a", at: 6_500, windowMs: 1_000 }),
      ).toBe(18)
    }),
  )
})
