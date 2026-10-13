export * as GoalPlanRebaseSchema from "./goal-plan-rebase.schema"

import { Schema } from "effect"
import { GoalTickProgram } from "./goal-tick-program"

export const MAX_BYTES = 1_048_576
export const MAX_RECORDS = 100_000
export const MAX_INSTANCE_BYTES = 268_435_456
export const MAX_COMMANDS = 32
export const RECEIPT_BYTES = 8192
export const Ref = GoalTickProgram.Ref
export const Identity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((value: string) => Buffer.byteLength(value, "utf8") <= 512),
)
export const Hash = GoalTickProgram.Hash
export const Count = GoalTickProgram.Count
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const StepID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

export const State = Schema.Literals([
  "waiting_boundary",
  "ready",
  "prepared",
  "mirror_pending",
  "committed",
  "cancelled",
  "superseded",
  "recovery_required",
])
export type State = typeof State.Type

export const Step = Schema.Struct({
  step_id: StepID,
  title: Text,
  status: Schema.Literals(["pending", "active", "done", "cancelled", "blocked"]),
  acceptance: Schema.optional(Schema.NullOr(Text)),
  assigned_agent: Schema.optional(Schema.NullOr(StepID)),
  evidence: Schema.optional(Schema.Array(Text).check(Schema.isMaxLength(64))),
  note: Schema.optional(Schema.NullOr(Text)),
})
export const Candidate = Schema.Struct({
  steps: Schema.Array(Step).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  activeStepID: Schema.NullOr(StepID),
  dispositions: Schema.Array(Schema.Struct({ stepID: StepID, reason: Text })).check(Schema.isMaxLength(128)),
})
export type Candidate = typeof Candidate.Type

export const Begin = Schema.Struct({
  sessionID: Identity,
  goalID: Identity,
  expectedControlRevision: Count,
  requestID: Ref,
})
export type Begin = typeof Begin.Type
export const Target = Schema.Struct({
  sessionID: Identity,
  goalID: Identity,
  editID: Ref,
  requestID: Ref,
  expectedEditRevision: Count,
  expectedControlRevision: Count,
})
export type Target = typeof Target.Type
export const Apply = Schema.Struct({
  ...Target.fields,
  expectedPlanRevision: Count,
  expectedDocVersion: Count,
  expectedDocHash: Hash,
  candidate: Candidate,
  reason: Text,
})
export type Apply = typeof Apply.Type

export const Source = Schema.Struct({
  planRevision: Count,
  controlRevision: Count,
  nextSeq: Count,
  priorRebaseID: Schema.NullOr(Ref),
  permitID: Schema.NullOr(Ref),
  receiptHash: Hash,
  planDocID: Ref,
  planDocVersion: Count,
  planDocHash: Hash,
  baselineDocsHash: Hash,
  documents: Schema.Array(GoalTickProgram.DocumentPayload).check(Schema.isMinLength(2), Schema.isMaxLength(8)),
  parentAuthorityHash: Hash,
  parentEventSeq: Count,
  attemptedStepIDs: Schema.Array(StepID).check(Schema.isMaxLength(4096)),
})
export type Source = typeof Source.Type

export const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  requestID: Ref,
  requestHash: Hash,
  action: Schema.Literals(["begin", "apply", "cancel", "reconcile"]),
  editID: Ref,
  goalID: Identity,
  sessionID: Identity,
  revision: Count,
  state: State,
  sourcePlanRevision: Count,
  sourceControlRevision: Count,
  targetPlanRevision: Count,
  controlRevision: Count,
  sourceReceiptHash: Schema.NullOr(Hash),
  candidateHash: Schema.NullOr(Hash),
  committedReceiptHash: Schema.NullOr(Hash),
  planDocID: Ref,
  planDocVersion: Count,
  planDocHash: Schema.NullOr(Hash),
  nextSeq: Count,
  confirmedDocuments: Count,
  totalDocuments: Count,
  projections: Schema.Array(
    Schema.Struct({
      documentID: Ref,
      state: Schema.Literals(["pending", "confirmed"]),
      version: Schema.NullOr(Count),
      hash: Schema.NullOr(Hash),
    }),
  ).check(Schema.isMaxLength(8)),
  partial: Schema.Boolean,
  execution: Schema.Literals(["waiting_boundary", "paused", "blocked", "terminal"]),
  recordedAt: Count,
})
export type Receipt = typeof Receipt.Type

export const Current = Schema.Struct({
  editID: Ref,
  revision: Count,
  state: State,
  controlRevision: Count,
  planRevision: Count,
  confirmedDocuments: Count,
  totalDocuments: Count,
  partial: Schema.Boolean,
  safeToResume: Schema.Boolean,
  execution: Schema.Literals(["waiting_boundary", "blocked", "terminal", "paused", "running"]),
  retry: Schema.Literals(["same_request", "refresh", "reconcile", "none"]),
  editSource: Schema.NullOr(
    Schema.Struct({
      planDocument: GoalTickProgram.DocumentPayload,
      planDocHash: Hash,
      sourceReceiptHash: Hash,
      baselineDocsHash: Hash,
      attemptedStepIDs: Schema.Array(StepID).check(Schema.isMaxLength(4096)),
    }),
  ),
})
export const Response = Schema.Struct({
  version: Schema.Literal(1),
  originalReceipt: Schema.NullOr(Receipt),
  current: Current,
  replayed: Schema.Boolean,
})
export type Response = typeof Response.Type

export const Command = Schema.Union([
  Schema.Struct({ action: Schema.Literal("begin"), request: Begin }),
  Schema.Struct({ action: Schema.Literal("apply"), request: Apply }),
  Schema.Struct({ action: Schema.Literal("cancel"), request: Target }),
  Schema.Struct({ action: Schema.Literal("reconcile"), request: Target }),
])
export type Command = typeof Command.Type
export const CommandReceipt = Schema.Struct({
  command: Command,
  requestHash: Hash,
  receipt: Schema.NullOr(Receipt),
})

export const Journal = Schema.Struct({
  version: Schema.Literal(1),
  begin: Begin,
  source: Schema.NullOr(Source),
  commands: Schema.Array(CommandReceipt).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_COMMANDS)),
  candidateHash: Schema.NullOr(Hash),
  documents: Schema.Array(GoalTickProgram.FullDocument).check(Schema.isMaxLength(8)),
  nextState: Schema.NullOr(Schema.String),
  fileStarted: Schema.Boolean,
  controlInterruption: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["control_pause", "control_stop"]),
      commandID: Ref,
      revision: Count,
    }),
  ),
  committedReceiptHash: Schema.NullOr(Hash),
  // Frozen before any file effect. It is receipt identity, never a new timestamp on retry.
  preparedAt: Schema.NullOr(Count),
  committedAt: Schema.NullOr(Count),
})
export type Journal = typeof Journal.Type

export class Error extends Schema.TaggedErrorClass<Error>()("GoalPlanRebase.Error", {
  code: Schema.Literals([
    "AUTH_REQUIRED",
    "AUTH_CHANGED",
    "APPROVAL_REJECTED",
    "PERMISSION_DENIED",
    "TARGET_CONFLICT",
    "REQUEST_CONFLICT",
    "REVISION_CONFLICT",
    "INVALID_CANDIDATE",
    "IMMUTABLE_COMPLETED_STEP",
    "ATTEMPTED_STEP_REQUIRED",
    "DISPOSITION_REQUIRED",
    "WAITING_BOUNDARY",
    "RECOVERY_REQUIRED",
    "PLAN_CONFLICT",
    "PARENT_CHANGED",
    "CAPACITY",
    "UNAVAILABLE",
    "NOT_FOUND",
  ]),
  message: Schema.String,
}) {}
