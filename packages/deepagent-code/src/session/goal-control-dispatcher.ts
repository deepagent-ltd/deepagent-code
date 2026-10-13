export * as GoalControlDispatcher from "./goal-control-dispatcher"

import { Effect } from "effect"
import type { Database } from "@deepagent-code/core/database/database"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import type { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { GoalTickConsumer } from "./goal-tick-consumer"

/** A bounded outbox drain. Re-publishing after a crash reuses the committed business key. */
export const drain = Effect.fn("GoalControlDispatcher.drain")(function* (
  db: Database.Interface["db"],
  bus: DeepAgentEventBus.Interface,
) {
  const commands = yield* GoalControl.pendingWakes(db)
  if (!commands.length) return
  // The cold consumer need not be running yet; publication must still owe it a durable delivery.
  yield* bus.registerConsumerGroup(GoalTickConsumer.TICK_GROUP, LMNEvents.GOAL_TICK_REQUESTED)
  for (const cmd of commands) {
    yield* Effect.gen(function* () {
      const row = yield* GoalControl.wakeEligible(db, cmd)
      if (!row) {
        yield* GoalControl.markWake(db, cmd, "superseded")
        return
      }
      yield* bus.publish({
        ...GoalTickConsumer.tickCommand({
          sessionID: row.session_id,
          goalId: row.goal_id,
          planDocId: row.plan_doc_id,
          revision: cmd.revision,
          seq: cmd.tick_seq,
          expectedPlanVersion: cmd.plan_version,
          ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}),
        }),
        idempotencyKey: cmd.wake_key,
      })
      yield* GoalControl.markWake(db, cmd, "published")
    }).pipe(
      Effect.catchCause(() =>
        GoalControl.markWake(db, cmd, "pending", "Goal wake publication or validation failed").pipe(Effect.ignore),
      ),
    )
  }
})
