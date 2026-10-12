export * as IMTaskControl from "./task-control"

import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { IMTaskState } from "./task-state"

/** Durable cancellation is management authority. The exact Session interruption follows
 * its commit and says nothing about previously dispatched physical effects or their charge. */
export const make = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const execution = yield* SessionExecution.Service
  const state = yield* IMTaskState.make
  const cancel = Effect.fn("IMTaskControl.cancel")(function* (
    input: Parameters<typeof IMTaskAuthority.cancelAndControl>[1],
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const cancelled = yield* IMTaskAuthority.cancelAndControl(db, input)
        // Commit survives caller cancellation. Interrupt is idempotent and never resumes
        // an idle owner; an exact retry may safely send this same advisory interruption.
        if (cancelled.work) yield* execution.interrupt(SessionSchema.ID.make(cancelled.work.session_id))
        const projection = yield* restore(state.read({ requestID: input.requestID, directory: input.directory }))
        return { receipt: cancelled.receipt, state: projection }
      }),
    )
  })
  return { cancel }
})
export type Interface = Effect.Success<typeof make>
