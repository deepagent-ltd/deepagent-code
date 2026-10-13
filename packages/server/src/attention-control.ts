export * as AttentionControl from "./attention-control"

import { Context, Effect } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import { TaskHumanControlSchema } from "@deepagent-code/core/session/task-human-control.schema"

/** A listener captures its original host authority when providing this port.
 * The shared API has no way to construct an operator or execution runtime. */
export class Task extends Context.Service<
  Task,
  {
    readonly advertise: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<{ task: boolean; goal: boolean }>
    readonly control: (
      input: TaskHumanControlSchema.Input,
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<TaskHumanControlSchema.Result, TaskHumanControlSchema.Error>
  }
>()("@deepagent-code/server/AttentionTaskControl") {}
