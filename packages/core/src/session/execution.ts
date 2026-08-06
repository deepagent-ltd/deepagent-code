export * as SessionExecution from "./execution"

import { Cause, Context, Effect, Exit, Layer } from "effect"
import { SessionRunner } from "./runner/index"
import { SessionSchema } from "./schema"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Explicitly drain one Session, making at least one provider attempt. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Schedule a drain after durable work is recorded. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID, seq?: number) => Effect.Effect<void, SessionRunner.RunError>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID, seq?: number) => Effect.Effect<void>
  /** Resolves once this process owns no active execution for the Session. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SessionExecution") {}

export type InterruptReason = "user" | "shutdown" | "superseded"

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: InterruptReason) {
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  const failure = Cause.squash(exit.cause)
  return {
    type: "failed" as const,
    error: {
      type: "unknown" as const,
      message: failure instanceof Error ? failure.message : String(failure),
    },
  }
}

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
  }),
)
