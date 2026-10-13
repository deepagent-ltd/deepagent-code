export * as TaskHumanClient from "./task-human-client"

import type { AttentionSchema } from "../attention/schema"
import type { TaskHumanControlSchema } from "./task-human-control.schema"

/** Local transport carries commands and observations, never an actor or execution permit. */
export type Query = { itemID: string }
export type Transport = {
  get(query: Query, signal?: AbortSignal): Promise<typeof AttentionSchema.Item.Type>
  control(input: TaskHumanControlSchema.Input, signal?: AbortSignal): Promise<TaskHumanControlSchema.Result>
  whenSettled(): Promise<void>
}

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly unknown = false,
  ) {
    super(message)
    this.name = "TaskHumanClient.RequestError"
  }
}
