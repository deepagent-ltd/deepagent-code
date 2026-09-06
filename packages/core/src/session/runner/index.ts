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
import type { RecoveryRequiredError } from "./v2-tool-effect"
import type { NotFoundError } from "../../agent"

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

// W2-V2 seam: the plan gate (understand→plan→execute discipline) lives in the deepagent-code
// layer — it wraps the V1 SessionTools execution path but the V2 runner settles tools through the
// core registry, so the gate never fired on the V2 path (run-mode evidence: edits executed with
// zero plan calls and zero blocks). The composition wires this reference with the same
// evaluatePlanGate decision; absent (core-only compositions) tools settle ungated exactly as before.
export type ToolSettleGateInput = {
  readonly sessionID: string
  readonly toolName: string
  readonly args: unknown
}
export type ToolSettleGateDecision = { kind: "pass"; reminder?: string } | { kind: "block"; output: string }
export const CurrentToolSettleGate = Context.Reference<
  ((input: ToolSettleGateInput) => Effect.Effect<ToolSettleGateDecision>) | undefined
>("@deepagent-code/v2/SessionRunner/ToolSettleGate", { defaultValue: () => undefined })

// Module-level registrar (the learning-runtime reviewer-factory pattern): the runner tree builds
// inside per-location layer scopes where outer graph provides do not reliably flow (run-mode
// evidence: the httpapi-root Reference provide never reached the runner's layer build). A host
// registers the gate implementation at composition build; the runner reads it at SETTLE time —
// immune to layer scoping.
type ToolSettleGateFn = (input: ToolSettleGateInput) => Effect.Effect<ToolSettleGateDecision>
const gateRegistry = new Map<symbol, ToolSettleGateFn>()
export const registerToolSettleGate = (fn: ToolSettleGateFn) => {
  const token = Symbol("v2-tool-settle-gate")
  gateRegistry.set(token, fn)
  return () => gateRegistry.delete(token)
}
export const currentToolSettleGate = (): ToolSettleGateFn | undefined =>
  [...gateRegistry.values()].toReversed()[0]

// R3 — the message carries the diagnosis (TaggedErrorClass otherwise renders an empty message
// on every log/SSE surface that prints `error.message`).
export class StepLimitExceededError extends Schema.TaggedErrorClass<StepLimitExceededError>()(
  "SessionRunner.StepLimitExceededError",
  {
    sessionID: SessionSchema.ID,
    limit: Schema.Int,
  },
) {
  constructor(props: { readonly sessionID: SessionSchema.ID; readonly limit: number }) {
    super(props)
    this.message = `step limit ${props.limit} exceeded for session ${props.sessionID}`
  }
}

/** A durable execution claim already exists. The caller must classify/recover that Session instead
 * of starting another provider drain whose preceding physical outcome may be unknown. */
export class ExecutionRecoveryRequiredError extends Schema.TaggedErrorClass<ExecutionRecoveryRequiredError>()(
  "SessionRunner.ExecutionRecoveryRequiredError",
  { sessionID: SessionSchema.ID },
) {
  constructor(props: { readonly sessionID: SessionSchema.ID }) {
    super(props)
    this.message = `session ${props.sessionID} has an unresolved execution claim; explicit recovery is required`
  }
}

export type RunError =
  | LLMError
  | SessionRunnerModel.Error
  | MessageDecodeError
  | ContextSnapshotDecodeError
  | StepLimitExceededError
  | ExecutionRecoveryRequiredError
  | SystemContext.InitializationBlocked
  | SessionContextEpoch.AgentReplacementBlocked
  | ToolOutputStore.Error
  | V2ProviderTurnError
  | RecoveryRequiredError
  | NotFoundError
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
