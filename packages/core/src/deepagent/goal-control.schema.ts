export * as GoalControlSchema from "./goal-control.schema"

import { Schema } from "effect"
import { GoalSpec } from "./goal-loop"
import { GoalTickProgram } from "./goal-tick-program"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
export const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const Phase = Schema.Literals(["running", "paused", "stopped", "done", "needs_human", "rolled_back"])
export type Phase = typeof Phase.Type
export const Action = Schema.Literals(["pause", "resume", "stop"])
export type Action = typeof Action.Type
export const Mode = Schema.Literals(["event", "resident"])
export type Mode = typeof Mode.Type
export const WakeState = Schema.Literals(["none", "pending", "published", "superseded"])
export type WakeState = typeof WakeState.Type
export const ControlInput = Schema.Struct({
  sessionID: Text,
  goalId: Text,
  expectedRevision: Count,
  requestID: Text,
})
export type ControlInput = typeof ControlInput.Type
export const Snapshot = Schema.Struct({
  goalId: Schema.String,
  planDocId: Schema.String,
  phase: Schema.String,
  running: Schema.Boolean,
  revision: Count,
  requestedPhase: Phase,
  preparation: Schema.Literals(["preparing", "ready", "recovery_required"]),
  inFlight: Schema.Boolean,
  recoveryRequired: Schema.Boolean,
  wakeState: WakeState,
  receiptID: Schema.optional(Schema.String),
  replayed: Schema.Boolean,
})
export type Snapshot = typeof Snapshot.Type

export class Error extends Schema.TaggedErrorClass<Error>()("GoalControl.Error", {
  code: Schema.Literals([
    "not_found",
    "target_conflict",
    "revision_conflict",
    "request_conflict",
    "busy",
    "unsupported",
    "recovery_required",
    "unavailable",
    "invalid_request",
  ]),
  message: Schema.String,
}) {}

/** Frozen before initialization; neither retries nor cold ticks select a different model/spec. */
export const Initialization = Schema.Struct({
  spec: GoalSpec,
  netTokenBudget: Schema.Boolean,
  planVersion: Count,
  planHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  model: Schema.Struct({ providerID: Text, modelID: Text }),
  executionContract: Schema.optional(Schema.Literal("owned-goal-v2")),
  ownedPreparation: Schema.optional(
    Schema.Struct({
      parentHash: GoalTickProgram.Hash,
      documents: Schema.Array(GoalTickProgram.FullDocument).check(Schema.isMinLength(2), Schema.isMaxLength(8)),
      panel: Schema.Struct({
        question: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
        maxRounds: Schema.optional(Count.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
        codeRefs: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(Schema.isMaxLength(32)),
        lenses: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(8),
        ),
      }),
    }),
  ),
})
export type Initialization = typeof Initialization.Type
export const ChildSessions = Schema.Array(Text)
export const Outcome = Schema.NullOr(Phase)

export type Tick = {
  sessionID: string
  goalId: string
  planDocId: string
  revision: number
  seq: number
  expectedPlanVersion: number
}
