export * as TaskHumanControlSchema from "./task-human-control.schema"

import { Schema } from "effect"

const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (value: string) =>
      value.isWellFormed() && Buffer.byteLength(value, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/.test(value),
  ),
)
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Action = Schema.Literals(["request_close", "resolve_failed", "resolve_closed"])
export type Action = typeof Action.Type
export const Input = Schema.Struct({
  runID: Text,
  parentSessionID: Text,
  childSessionID: Schema.NullOr(Text),
  generation: Count.check(Schema.isGreaterThanOrEqualTo(1)),
  expectedVersion: Count,
  itemID: Text,
  itemRevision: Digest,
  requestID: Text,
  action: Action,
  reason: Schema.String.check(
    Schema.isMinLength(1),
    Schema.makeFilter(
      (value: string) => value.isWellFormed() && Buffer.byteLength(value, "utf8") <= 2048 && !value.includes("\u0000"),
    ),
  ),
}).annotate({ identifier: "TaskHumanControlInput" })
export type Input = typeof Input.Type
export const Receipt = Schema.Struct({
  contract: Schema.Literal("task-human-control-v1"),
  receiptID: Text,
  requestHash: Digest,
  request: Input,
  authority: Schema.Struct({
    scope: Schema.Literal("implicit-local"),
    principal: Text,
    projectID: Text,
    directory: Schema.String.check(
      Schema.isMinLength(1),
      Schema.makeFilter(
        (value: string) =>
          value.isWellFormed() && Buffer.byteLength(value, "utf8") <= 2048 && !value.includes("\u0000"),
      ),
    ),
    permissionEpoch: Count,
  }),
  recordedChildSessionID: Text,
  version: Count,
  state: Text,
  controlState: Schema.Literals(["open", "close_requested", "closed"]),
  terminalReceiptID: Schema.NullOr(Text),
  affectedRuns: Count,
  time: Count,
}).annotate({ identifier: "TaskHumanControlReceipt" })
export type Receipt = typeof Receipt.Type
export const Result = Schema.Struct({ receipt: Receipt, replayed: Schema.Boolean })
export type Result = typeof Result.Type
export class Error extends Schema.TaggedErrorClass<Error>()("TaskHumanControl.Error", {
  code: Schema.Literals([
    "unavailable",
    "auth_required",
    "scope_changed",
    "source_changed",
    "request_conflict",
    "command_limit",
    "custody_required",
    "unsupported",
    "invalid_request",
  ]),
  message: Schema.String,
}) {}
