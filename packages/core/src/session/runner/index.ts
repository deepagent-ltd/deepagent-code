export * as SessionRunner from "./index"
export * as SessionProviderRecovery from "./recovery"
export * as SessionProviderRecoveryStore from "./recovery-store"
export * as SessionProviderRecoveryDurable from "./recovery-durable-store"

import type { LLMError } from "@deepagent-code/llm"
import { Context, Effect, Schema } from "effect"
import { SessionSchema } from "../schema"
import type { ContextSnapshotDecodeError, MessageDecodeError } from "../error"
import { SessionRunnerModel } from "./model"
import type { SystemContext } from "../../system-context/index"
import type { SessionContextEpoch } from "../context-epoch"
import type { ToolOutputStore } from "../../tool-output-store"
import type { AdmissionError } from "./canonical-turn"
import type { Error as V2ProviderTurnError } from "./v2-provider-turn"

/** W7 — settle hook input. `activityId` is the durable activity that just settled; it is absent
 * when the drain ran without dispatching any provider turn (e.g. an early no-op wake). */
export type OnSessionSettledInput = {
  readonly sessionID: SessionSchema.ID
  readonly workspacePath: string
  readonly activityId?: string
}

/** W7 — host-injectable hook invoked once after a drain chain settles, beside the W10 project-docs
 * tail. Unwired (`undefined` default) = no-op; the deepagent-code composition injects the
 * durable-learning admission implementation. */
export const CurrentOnSessionSettled = Context.Reference<
  ((input: OnSessionSettledInput) => Effect.Effect<void>) | undefined
>("@deepagent-code/v2/SessionRunner/OnSessionSettled", { defaultValue: () => undefined })

export class StepLimitExceededError extends Schema.TaggedErrorClass<StepLimitExceededError>()(
  "SessionRunner.StepLimitExceededError",
  {
    sessionID: SessionSchema.ID,
    limit: Schema.Int,
  },
) {}

export type RunError =
  | LLMError
  | SessionRunnerModel.Error
  | MessageDecodeError
  | ContextSnapshotDecodeError
  | StepLimitExceededError
  | SystemContext.InitializationBlocked
  | SessionContextEpoch.AgentReplacementBlocked
  | ToolOutputStore.Error
  | V2ProviderTurnError
  | AdmissionError

/** Runs one local continuation from already-recorded Session history. */
export interface Interface {
  /** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
  readonly run: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force?: boolean
  }) => Effect.Effect<void, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SessionRunner") {}
