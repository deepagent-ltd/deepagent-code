export * as IMRemoteTaskStatus from "./remote-task-status"

import { Effect, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRemoteDeliveryLocator } from "./remote-delivery-locator"
import { IMRemoteTaskResult } from "./remote-task-result"
import { IMTaskStatusLocator } from "./task-status-locator"

export const Lookup = Schema.Union([
  IMTaskStatusLocator.Result.members[0],
  Schema.Struct({ version: Schema.Literal(1), state: Schema.Literal("unavailable"),
    code: Schema.Literals(["remote_status_unlinked", "status_changed", "delivery_unknown", "placement_unavailable"]),
  }),
])
export type Lookup = typeof Lookup.Type

/** One original status reader is captured at assembly. A caller tuple locates a B
 * receipt; current B task management and reader authority still decide disclosure. */
export const make = (statuses: Effect.Success<typeof IMTaskStatusLocator.make>) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const lookup = Effect.fn("IMRemoteTaskStatus.lookup")(function* (input: {
    tuple: IMRemoteTaskResult.Tuple; workspaceID: string; userID: string; directory: string; instanceID: string
  }): Effect.fn.Return<Lookup, Effect.Error<ReturnType<typeof statuses.read>> | IMRemoteDeliveryLocator.StorageError,
    Effect.Services<ReturnType<typeof statuses.read>>> {
    const messageID = yield* IMRemoteDeliveryLocator.resolveMessage(db, input)
    if (!messageID) return unavailable("remote_status_unlinked")
    const result = yield* statuses.read({ ...input, messageID })
    if (!result) return unavailable("remote_status_unlinked")
    if (result.state === "unavailable") return unavailable(result.code === "not_task_status" ? "remote_status_unlinked" : result.code)
    if (result.task.instanceID !== input.instanceID || result.task.directory !== input.directory)
      return unavailable("placement_unavailable")
    return result
  })
  return { lookup }
})

function unavailable(code: Extract<Lookup, { state: "unavailable" }>["code"]): Lookup {
  return { version: 1, state: "unavailable", code }
}
