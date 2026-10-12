import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { EventWorkRule } from "@deepagent-code/core/deepagent/event-work-rule"
import { MultiAgentRuntime } from "../../src/session/multi-agent-runtime"

test("actual file database scopes same write node coordination by receipt and deduplicates exact replay", () => Effect.runPromise(
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dac-event-coordination-receipt-"))),
      (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })))
    const context = yield* Layer.build(DeepAgentEventBus.layer.pipe(Layer.provideMerge(Database.layerFromPath(path.join(root, "events.sqlite")))))
    yield* Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const first: DeepAgentEvent.Event = { id: DeepAgentEvent.ID.make(`dae_evwork_${"a".repeat(64)}`), type: EventWorkRule.EVENT_TYPE,
        source: "system", workspaceID: "wrk_actual_receipt", idempotencyKey: "first", priority: "normal", createdAt: Date.now(), payload: {} }
      const second = { ...first, id: DeepAgentEvent.ID.make(`dae_evwork_${"b".repeat(64)}`), idempotencyKey: "second" }
      for (const type of ["agent.task.blocked", "agent.task.needs_human"] as const) {
        const publish = (event: DeepAgentEvent.Event) => bus.publish({ type, source: "system", workspaceID: event.workspaceID,
          causationID: event.id, idempotencyKey: MultiAgentRuntime.coordinationKey(event, `coord:write:${type}`),
          priority: "high", payload: { type, taskID: "write", reason: "admission_recovery_required" } })
        const a = yield* publish(first)
        const b = yield* publish(second)
        const replay = yield* publish(first)
        expect(a.id).not.toBe(b.id)
        expect(replay.id).toBe(a.id)
        const rows = yield* bus.recentByType({ type, windowMs: 60_000, now: Date.now() })
        expect(rows.length).toBe(2)
        expect(rows.map((row) => row.causationID).sort()).toEqual([first.id, second.id].sort())
      }
      expect(MultiAgentRuntime.coordinationKey({ ...first, type: "ci.failure" }, "coord:write:blocked")).toBe("coord:write:blocked")
    }).pipe(Effect.provide(context))
  }).pipe(Effect.scoped),
))
