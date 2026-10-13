export * as GoalTickCheckpointSchema from "./goal-tick-checkpoint.schema"

import { Schema } from "effect"
import { GoalChildSchema } from "./goal-child.schema"

export const MAX_BYTES = 1_048_576
export const MAX_RECORDS = 100_000
export const MAX_INSTANCE_BYTES = 268_435_456
const Text = GoalChildSchema.Text
const Hash = GoalChildSchema.Hash
const Count = GoalChildSchema.Count
// Native Session/input/activity/execution identities are ASCII. This bound keeps the full
// compact receipt encodable in its pre-reserved 2 KiB slot without JSON escape amplification.
const Ref = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:~-]{1,128}$/))
const DocumentRef = Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(/^doc:[a-z_]+:[A-Za-z0-9_.:-]+$/))
export const RESULT_BYTES = 2048
export const EFFECT_BYTES = 1024
export const Ledger = Schema.Struct({ count: Count, through: Count, hash: Hash })
export const State = Schema.Literals([
  "prepared",
  "running",
  "mirror_pending",
  "committed",
  "halted",
  "recovery_required",
])
export type State = typeof State.Type
export const Cursor = Schema.Struct({ role: Count, stage: GoalChildSchema.Stage })
export type Cursor = typeof Cursor.Type
export const Role = Schema.Struct({
  key: Text,
  agent: Text,
  kind: Schema.Literals(["worker", "reviewer", "panel"]),
  ordinal: Count,
  criterion: Schema.NullOr(Count),
  round: Schema.NullOr(Count),
  lens: Schema.NullOr(Count),
  mode: Schema.Literals(["plain", "structured"]),
  promptHash: Hash,
  policyHash: Hash,
})
export type Role = typeof Role.Type
export const Roles = Schema.Array(Role).check(Schema.isMaxLength(64), Schema.isMinLength(1))
export const Result = Schema.Struct({
  version: Schema.Literal(1),
  unitID: Ref,
  stage: GoalChildSchema.Stage,
  inputID: Ref,
  admittedSeq: Count,
  activityID: Ref,
  messageID: Ref,
  executionID: Ref,
  claimToken: Count,
  providers: Ledger,
  tools: Ledger,
  outcome: Schema.Literals(["valid", "schema_invalid"]),
  resultHash: Hash,
  schemaHash: Hash,
  usage: Schema.Struct({
    input: Count,
    nonCachedInput: Count,
    output: Count,
    reasoning: Schema.NullOr(Count),
    visibleOutput: Schema.NullOr(Count),
    cacheRead: Count,
    cacheWrite: Count,
  }),
  usageDerivation: Schema.Struct({
    version: Schema.Literal(1),
    inferredInputCategories: Schema.Array(Schema.Literals(["nonCachedInput", "cacheRead", "cacheWrite"])).check(
      Schema.isMaxLength(3),
    ),
  }),
})
export type Result = typeof Result.Type
export const EffectReceipt = Schema.Struct({
  id: Ref,
  kind: Schema.Literals(["validation", "rollback"]),
  commandHash: Hash,
  state: Schema.Literals([
    "prepared",
    "dispatched",
    "exited",
    "cancelled_before_dispatch",
    "stop_confirmed",
    "unknown",
  ]),
  exitCode: Schema.NullOr(Schema.Int),
  resultHash: Schema.NullOr(Hash),
})
export type EffectReceipt = typeof EffectReceipt.Type
export const Mirror = Schema.Struct({
  documentID: DocumentRef,
  expectedVersion: Schema.NullOr(Count),
  expectedHash: Schema.NullOr(Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))),
  payload: Schema.String.check(Schema.isMaxLength(262144)),
  payloadHash: Hash,
  state: Schema.Literals(["pending", "confirmed"]),
  observedVersion: Schema.NullOr(Count),
  observedHash: Schema.NullOr(Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))),
})
export type Mirror = typeof Mirror.Type
export const Steering = Schema.Struct({
  cutoff: Count,
  mutationEpoch: Count,
  rows: Schema.Array(Schema.Struct({ id: Text, seq: Count, hash: Hash })).check(Schema.isMaxLength(256)),
})
export type Steering = typeof Steering.Type
export const Parent = Schema.Struct({
  sessionID: Text,
  sourceSeq: Count,
  authorityHash: Hash,
  authority: Schema.String.check(Schema.isMaxLength(262144)),
  steering: Steering,
})
export type Parent = typeof Parent.Type
export const Journal = Schema.Struct({
  version: Schema.Literal(1),
  parent: Parent,
  roles: Roles,
  cursor: Cursor,
  budgets: Schema.Struct({
    resultSlots: Count,
    effectSlots: Count,
    mirrors: Schema.Array(Schema.Struct({ documentID: DocumentRef, bytes: Count })).check(Schema.isMaxLength(8)),
    nextStateBytes: Count,
  }),
  results: Schema.Array(Result).check(Schema.isMaxLength(192)),
  localEffects: Schema.Array(EffectReceipt).check(Schema.isMaxLength(33)),
  mirrors: Schema.Array(Mirror).check(Schema.isMaxLength(8)),
  nextState: Schema.NullOr(Schema.String.check(Schema.isMaxLength(262144))),
  nextStateHash: Schema.NullOr(Hash),
})
export type Journal = typeof Journal.Type
export class Error extends Schema.TaggedErrorClass<Error>()("GoalTickCheckpoint.Error", {
  code: Schema.Literals([
    "CHECKPOINT_INVALID",
    "CHECKPOINT_CONFLICT",
    "CHECKPOINT_CAPACITY",
    "CHECKPOINT_RECOVERY_REQUIRED",
    "CHECKPOINT_CONTROL_CHANGED",
    "PARENT_FRONTIER_LIMIT",
    "PARENT_AUTHORITY_CHANGED",
    "PARENT_HISTORY_UNAVAILABLE",
  ]),
  message: Schema.String,
}) {}
