export * as IMDacSessionSchema from "./dac-session.schema"

import { Schema } from "effect"

const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))
const text = Schema.String.check(
  Schema.makeFilter(
    (value) => value.trim().length > 0 && !value.includes("\0") && new TextEncoder().encode(value).byteLength <= 100000,
  ),
)
const Placement = {
  groupID: Schema.String,
  projectID: Schema.String,
  directory: Schema.String,
  workspaceID: Schema.NullOr(Schema.String),
}

export const Submit = Schema.Struct({
  commandID: ID,
  text,
  delivery: Schema.Literals(["queue", "steer"]),
  referenceMessageIDs: Schema.optional(
    Schema.Array(
      Schema.String.check(
        Schema.makeFilter((value) => value.length > 0 && value.length <= 512 && !value.includes("\0")),
      ),
    ).check(Schema.isMaxLength(32)),
  ),
  newSession: Schema.optional(Schema.Boolean),
})
export type Submit = typeof Submit.Type

export const CommandResponse = Schema.Struct({
  version: Schema.Literal(1),
  ...Placement,
  commandID: ID,
  bindingID: Schema.String,
  sessionID: Schema.String,
  inputID: Schema.String,
  delivery: Schema.Literals(["queue", "steer"]),
  state: Schema.Literals(["pending", "admitted", "rejected"]),
  activityID: Schema.NullOr(Schema.String),
  finalMessageID: Schema.NullOr(Schema.String),
  replyStatus: Schema.NullOr(Schema.Literals(["pending", "delivering", "delivered", "dead", "unknown"])),
})
export type CommandResponse = typeof CommandResponse.Type

export const BindingResponse = Schema.Struct({
  version: Schema.Literal(1),
  ...Placement,
  bindingID: Schema.NullOr(Schema.String),
  sessionID: Schema.NullOr(Schema.String),
  recentCommands: Schema.optional(Schema.Array(CommandResponse).check(Schema.isMaxLength(8))),
})
export type BindingResponse = typeof BindingResponse.Type

export class Error extends Schema.TaggedErrorClass<Error>()("IMDacSession.Error", {
  code: Schema.Literals([
    "command_conflict",
    "binding_unavailable",
    "reference_unavailable",
    "command_not_found",
    "admission_rejected",
    "reply_unavailable",
  ]),
}) {}

export const ReplyReconcileRequest = Schema.Struct({
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
})
export type ReplyReconcileRequest = typeof ReplyReconcileRequest.Type
export const ReplyReceiptState = Schema.Literals([
  "confirmed_acceptance",
  "unknown",
  "not_found",
  "conflict",
  "expired",
  "unavailable",
])
export const ReplyReceiptQuery = Schema.Struct({
  version: Schema.Literal(1),
  channelType: Schema.Literals([1, 2]),
  targetId: Schema.String,
  clientUid: Schema.String,
  requestHash: Schema.String,
  expiresAt: Schema.Int,
})
export type ReplyReceiptQuery = typeof ReplyReceiptQuery.Type
export const ReplyReceipt = Schema.Struct({
  version: Schema.Literal(1),
  state: ReplyReceiptState,
  clientUid: Schema.String,
  requestHash: Schema.String,
  expiresAt: Schema.Int,
  msgId: Schema.String,
  msgTime: Schema.Int,
  msgSeqNo: Schema.String,
})
export type ReplyReceipt = typeof ReplyReceipt.Type
export const ReplyReconcilePart = Schema.Struct({
  index: Schema.Int,
  outboxID: Schema.String,
  replyMessageID: Schema.String,
  deliveryMessageID: Schema.String,
  outcome: Schema.Literals([
    "already_confirmed",
    "confirmed_acceptance",
    "unconfirmed",
    "active_delivery",
    "not_dispatched",
    "expired",
    "retired",
    "unavailable",
  ]),
  remoteState: Schema.NullOr(ReplyReceiptState),
  kernelMessageID: Schema.NullOr(Schema.String),
})
export type ReplyReconcilePart = typeof ReplyReconcilePart.Type
export const ReplyReconcileResponse = Schema.Struct({
  version: Schema.Literal(1),
  command: CommandResponse,
  state: Schema.Literals(["confirmed_acceptance", "partial", "unconfirmed"]),
  totalParts: Schema.Int,
  confirmedParts: Schema.Int,
  unconfirmedParts: Schema.Int,
  activeParts: Schema.Int,
  parts: Schema.Array(ReplyReconcilePart).check(Schema.isMaxLength(32)),
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
}).check(
  Schema.makeFilter(
    (value) =>
      value.totalParts > 0 &&
      value.totalParts <= 49999 &&
      value.confirmedParts >= 0 &&
      value.unconfirmedParts >= 0 &&
      value.confirmedParts + value.unconfirmedParts === value.totalParts &&
      value.activeParts >= 0 &&
      value.activeParts <= value.unconfirmedParts &&
      value.parts.every((part) => part.index >= 0 && part.index < value.totalParts) &&
      new Set(value.parts.map((part) => part.index)).size === value.parts.length &&
      value.hasMore === (value.nextCursor !== null) &&
      (value.state === "confirmed_acceptance"
        ? value.confirmedParts === value.totalParts
        : value.state === "partial"
          ? value.confirmedParts > 0 && value.unconfirmedParts > 0
          : value.confirmedParts === 0),
  ),
)
export type ReplyReconcileResponse = typeof ReplyReconcileResponse.Type
